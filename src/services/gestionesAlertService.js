import mgmtDb from "../db/adminDb.js";

const TITULO = "Gestión inicia hoy";

// YYYY-MM-DD de hoy en hora de Santiago (no la del servidor)
function fechaHoySantiago() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santiago" }).format(new Date());
}

/**
 * Avisa a cada encargado, con una notificación personal en la campana, de las gestiones
 * Pendientes cuya fecha de inicio es hoy. Si ya se avisó hoy de esa gestión no la repite.
 */
export async function notificarGestionesQueInician(db = mgmtDb) {
  const hoy = fechaHoySantiago();

  const gestiones = await db("gestiones as g")
    .join("estados as e", "e.id", "g.estado_id")
    .whereNotNull("g.encargado_id")
    .where("e.codigo", "PENDIENTE")
    .whereRaw("g.fecha_inicio = ?::date", [hoy])
    .select("g.id", "g.nombre", "g.encargado_id");

  let creadas = 0;

  for (const gestion of gestiones) {
    const contenido = `${gestion.nombre} (gestión #${gestion.id}) comienza hoy y estás a cargo de ella.`;

    const yaAvisada = await db("notificaciones")
      .where({ usuario_id: gestion.encargado_id, titulo: TITULO, contenido })
      .whereRaw("(created_at AT TIME ZONE 'America/Santiago')::date = ?::date", [hoy])
      .first();

    if (yaAvisada) {
      continue;
    }

    await db("notificaciones").insert({
      titulo: TITULO,
      contenido,
      leido: false,
      url: "gestiones",
      usuario_id: gestion.encargado_id,
      created_at: new Date()
    });

    creadas++;
  }

  return { fecha: hoy, gestiones: gestiones.length, notificaciones: creadas };
}

/* =====================================================
   CORREO DE CADA GESTIÓN QUE INICIA HOY
===================================================== */

const TITULO_MARCA_CORREO = "Correo: gestión inicia hoy";

// Copia por defecto de cada correo; se puede cambiar con GESTIONES_INICIO_MAIL_CC
const COPIA_POR_DEFECTO = "smtp@tarragona.cl";

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const escapar = (texto) =>
  String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Por cada gestión Pendiente cuya fecha de inicio es hoy, envía un correo a quien la creó y a su
 * encargado (el campo email de cada usuario; si es la misma persona, uno solo) con copia a
 * smtp@tarragona.cl (GESTIONES_INICIO_MAIL_CC). Si ninguno de los dos tiene un correo válido, la
 * gestión se omite y queda registrado en el log.
 * Cada gestión se avisa una sola vez: tras enviarlo se deja una marca en `notificaciones` (sin url
 * de campana, no la ve nadie). Si el envío falla no se marca, para poder reintentarlo.
 *
 * `enviar` se puede reemplazar (pruebas); por defecto es el servicio de correo del sistema.
 */
export async function enviarCorreoGestionesQueInician(
  db = mgmtDb,
  enviar = null
) {
  const hoy = fechaHoySantiago();
  const copia = String(process.env.GESTIONES_INICIO_MAIL_CC ?? COPIA_POR_DEFECTO).trim();

  const gestiones = await db("gestiones as g")
    .join("estados as e", "e.id", "g.estado_id")
    .leftJoin("users as ue", "ue.id", "g.encargado_id")
    .leftJoin("users as uc", "uc.id", "g.creado_por")
    .leftJoin("gestiones_locales as gl", "gl.gestion_id", "g.id")
    .where("e.codigo", "PENDIENTE")
    .whereRaw("g.fecha_inicio = ?::date", [hoy])
    .groupBy(
      "g.id",
      "g.nombre",
      "g.version",
      "ue.full_name",
      "ue.email",
      "uc.full_name",
      "uc.email"
    )
    .select(
      "g.id",
      "g.nombre",
      "g.version",
      "ue.full_name as encargado",
      "ue.email as encargado_email",
      "uc.full_name as creador",
      "uc.email as creador_email",
      db.raw("COUNT(gl.id) AS locales")
    )
    .orderBy("g.id");

  const resumen = { fecha: hoy, gestiones: gestiones.length, enviados: 0, omitidas: 0, errores: 0 };

  if (!gestiones.length) {
    return resumen;
  }

  const enviador =
    enviar || (await import("./mailService.js")).enviarCorreoAlerta;

  for (const g of gestiones) {
    const contenidoMarca = `gestión #${g.id} · ${hoy}`;

    const yaEnviado = await db("notificaciones")
      .where({ titulo: TITULO_MARCA_CORREO, contenido: contenidoMarca })
      .first();

    if (yaEnviado) {
      continue;
    }

    const destinatarios = [
      ...new Set(
        [g.creador_email, g.encargado_email]
          .map((c) => String(c || "").trim().toLowerCase())
          .filter((c) => EMAIL_VALIDO.test(c))
      )
    ];

    if (!destinatarios.length) {
      console.warn(
        `[GESTIONES] Gestión #${g.id} "${g.nombre}": ni quien la creó ni el encargado tienen un correo válido; no se envió el aviso`
      );
      resumen.omitidas++;
      continue;
    }

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
        <h2>La gestión "${escapar(g.nombre)}" inicia hoy</h2>
        <table style="border-collapse:collapse">
          <tr><td style="padding:4px 14px 4px 0"><strong>Gestión</strong></td><td>${escapar(g.nombre)}</td></tr>
          <tr><td style="padding:4px 14px 4px 0"><strong>Versión</strong></td><td>${escapar(g.version || "-")}</td></tr>
          <tr><td style="padding:4px 14px 4px 0"><strong>Fecha de inicio</strong></td><td>${escapar(hoy)}</td></tr>
          <tr><td style="padding:4px 14px 4px 0"><strong>Encargado</strong></td><td>${escapar(g.encargado || "Sin encargado")}</td></tr>
          <tr><td style="padding:4px 14px 4px 0"><strong>Creada por</strong></td><td>${escapar(g.creador || "-")}</td></tr>
          <tr><td style="padding:4px 14px 4px 0"><strong>Locales</strong></td><td>${escapar(g.locales)}</td></tr>
        </table>
        <p>Ingrese a Manager Crack, módulo Gestiones, para iniciarla y dar seguimiento a los locales.</p>
        <hr>
        <small>Este correo fue generado automáticamente por el sistema de administración.</small>
      </div>
    `;

    const resultado = await enviador({
      subject: `Gestión inicia hoy: ${g.nombre}`,
      html,
      to: destinatarios.join(", "),
      cc: copia,
      usarCc: Boolean(copia)
    });

    if (!resultado?.ok) {
      console.error(`[GESTIONES] Gestión #${g.id}: no se pudo enviar el correo de inicio: ${resultado?.error}`);
      resumen.errores++;
      continue;
    }

    await db("notificaciones").insert({
      titulo: TITULO_MARCA_CORREO,
      contenido: contenidoMarca,
      leido: true,
      url: "sistema",
      created_at: new Date()
    });

    resumen.enviados++;
  }

  return resumen;
}

/* =====================================================
   AVISO DE CAMPANA AL ASIGNAR O REASIGNAR UNA GESTIÓN
===================================================== */

/**
 * Crea una notificación personal para el nuevo encargado. No avisa si el encargado no cambió
 * ni si quien asigna se la asigna a sí mismo.
 */
export async function notificarGestionAsignada(
  db = mgmtDb,
  { gestion, encargadoId, asignadoPorId }
) {
  if (!encargadoId || Number(encargadoId) === Number(gestion.encargado_id)) {
    return { creada: false, motivo: "SIN_CAMBIO" };
  }

  if (Number(encargadoId) === Number(asignadoPorId)) {
    return { creada: false, motivo: "AUTOASIGNADA" };
  }

  await db("notificaciones").insert({
    titulo: "Gestión asignada",
    contenido: `Se te asignó la gestión "${gestion.nombre}" (gestión #${gestion.id}).`,
    leido: false,
    url: "gestiones",
    usuario_id: encargadoId,
    created_at: new Date()
  });

  return { creada: true };
}
