import mgmtDb from "../db/adminDb.js";

const TITULO = "Gestión inicia hoy";

// YYYY-MM-DD de hoy en hora de Santiago (no la del servidor)
function fechaHoySantiago() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santiago" }).format(new Date());
}

/**
 * Avisa a cada usuario del perfil asignado, con una notificación personal en la campana, de las
 * gestiones Pendientes cuya fecha de inicio es hoy. Si ya se le avisó hoy de esa gestión no la repite.
 */
export async function notificarGestionesQueInician(db = mgmtDb) {
  const hoy = fechaHoySantiago();

  const gestiones = await db("gestiones as g")
    .join("estados as e", "e.id", "g.estado_id")
    .whereNotNull("g.perfil_asignado")
    .where("e.codigo", "PENDIENTE")
    .whereRaw("g.fecha_inicio = ?::date", [hoy])
    .select("g.id", "g.nombre", "g.perfil_asignado");

  let creadas = 0;

  for (const gestion of gestiones) {
    const contenido = `${gestion.nombre} (gestión #${gestion.id}) comienza hoy y está asignada a tu perfil.`;

    const usuarios = await db("users").where({ role: gestion.perfil_asignado }).select("id");

    for (const usuario of usuarios) {
      const yaAvisado = await db("notificaciones")
        .where({ usuario_id: usuario.id, titulo: TITULO, contenido })
        .whereRaw("(created_at AT TIME ZONE 'America/Santiago')::date = ?::date", [hoy])
        .first();

      if (yaAvisado) {
        continue;
      }

      await db("notificaciones").insert({
        titulo: TITULO,
        contenido,
        leido: false,
        url: "gestiones",
        usuario_id: usuario.id,
        created_at: new Date()
      });

      creadas++;
    }
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
 * Por cada gestión Pendiente cuya fecha de inicio es hoy, envía un correo a quien la creó (el campo
 * email del usuario) con copia a smtp@tarragona.cl (GESTIONES_INICIO_MAIL_CC). Si quien la creó no
 * tiene un correo válido, la gestión se omite y queda registrado en el log.
 * Los usuarios del perfil asignado se enteran por la campana, no por correo.
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
    .leftJoin("users as uc", "uc.id", "g.creado_por")
    .leftJoin("gestiones_locales as gl", "gl.gestion_id", "g.id")
    .where("e.codigo", "PENDIENTE")
    .whereRaw("g.fecha_inicio = ?::date", [hoy])
    .groupBy(
      "g.id",
      "g.nombre",
      "g.version",
      "g.perfil_asignado",
      "uc.full_name",
      "uc.email"
    )
    .select(
      "g.id",
      "g.nombre",
      "g.version",
      "g.perfil_asignado",
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
        [g.creador_email]
          .map((c) => String(c || "").trim().toLowerCase())
          .filter((c) => EMAIL_VALIDO.test(c))
      )
    ];

    if (!destinatarios.length) {
      console.warn(
        `[GESTIONES] Gestión #${g.id} "${g.nombre}": quien la creó no tiene un correo válido; no se envió el aviso`
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
          <tr><td style="padding:4px 14px 4px 0"><strong>Asignada a</strong></td><td>${escapar(g.perfil_asignado ? `Perfil ${g.perfil_asignado}` : "Sin asignar")}</td></tr>
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
 * Crea una notificación personal para cada usuario del perfil al que se asigna la gestión, salvo
 * quien hace la asignación. No avisa si el perfil no cambió.
 * `gestion` es la fila antes de actualizar (trae el perfil anterior).
 */
export async function notificarGestionAsignada(
  db = mgmtDb,
  { gestion, perfil, asignadoPorId }
) {
  if (!perfil || perfil === gestion.perfil_asignado) {
    return { creadas: 0, motivo: "SIN_CAMBIO" };
  }

  const usuarios = await db("users")
    .where({ role: perfil })
    .whereNot({ id: asignadoPorId })
    .select("id");

  if (!usuarios.length) {
    return { creadas: 0, motivo: "SIN_USUARIOS" };
  }

  await db("notificaciones").insert(
    usuarios.map((usuario) => ({
      titulo: "Gestión asignada",
      contenido: `Se asignó a tu perfil (${perfil}) la gestión "${gestion.nombre}" (gestión #${gestion.id}).`,
      leido: false,
      url: "gestiones",
      usuario_id: usuario.id,
      created_at: new Date()
    }))
  );

  return { creadas: usuarios.length };
}
