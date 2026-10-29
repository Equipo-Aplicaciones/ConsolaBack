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
   CORREO DE GESTIONES QUE INICIAN HOY
===================================================== */

const TITULO_MARCA_CORREO = "Correo: gestiones que inician hoy";

// Copia por defecto del correo; se puede cambiar con GESTIONES_INICIO_MAIL_CC
const COPIA_POR_DEFECTO = "smtp@tarragona.cl";

const escapar = (texto) =>
  String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Envía UN correo con las gestiones Pendientes cuya fecha de inicio es hoy.
 * Destinatarios: GESTIONES_INICIO_MAIL_TO (separados por coma; p. ej. soporte y mesa de ayuda) y
 * copia a GESTIONES_INICIO_MAIL_CC (por defecto smtp@tarragona.cl).
 * Se envía una sola vez por día: tras enviarlo se deja una marca en `notificaciones` (sin url
 * de campana, no la ve nadie) y una segunda corrida del mismo día no vuelve a enviarlo.
 *
 * `enviar` se puede reemplazar (pruebas); por defecto es el servicio de correo del sistema.
 */
export async function enviarCorreoGestionesQueInician(
  db = mgmtDb,
  enviar = null
) {
  const hoy = fechaHoySantiago();
  const para = String(process.env.GESTIONES_INICIO_MAIL_TO || "").trim();
  const copia = String(process.env.GESTIONES_INICIO_MAIL_CC || COPIA_POR_DEFECTO).trim();

  if (!para) {
    console.warn(
      "[GESTIONES] No se envió el correo de inicio: falta GESTIONES_INICIO_MAIL_TO en el .env"
    );
    return { enviado: false, motivo: "SIN_DESTINATARIOS" };
  }

  const yaEnviado = await db("notificaciones")
    .where({ titulo: TITULO_MARCA_CORREO, contenido: hoy })
    .first();

  if (yaEnviado) {
    return { enviado: false, motivo: "YA_ENVIADO" };
  }

  const gestiones = await db("gestiones as g")
    .join("estados as e", "e.id", "g.estado_id")
    .leftJoin("users as u", "u.id", "g.encargado_id")
    .leftJoin("gestiones_locales as gl", "gl.gestion_id", "g.id")
    .where("e.codigo", "PENDIENTE")
    .whereRaw("g.fecha_inicio = ?::date", [hoy])
    .groupBy("g.id", "g.nombre", "g.version", "u.full_name")
    .select(
      "g.id",
      "g.nombre",
      "g.version",
      "u.full_name as encargado",
      db.raw("COUNT(gl.id) AS locales")
    )
    .orderBy("g.id");

  if (!gestiones.length) {
    return { enviado: false, motivo: "SIN_GESTIONES" };
  }

  const filas = gestiones
    .map(
      (g) => `
        <tr>
          <td style="padding:6px 10px;border:1px solid #dee2e6">${escapar(g.nombre)}</td>
          <td style="padding:6px 10px;border:1px solid #dee2e6">${escapar(g.version || "-")}</td>
          <td style="padding:6px 10px;border:1px solid #dee2e6">${escapar(g.encargado || "Sin encargado")}</td>
          <td style="padding:6px 10px;border:1px solid #dee2e6;text-align:right">${escapar(g.locales)}</td>
        </tr>`
    )
    .join("");

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
      <h2>Gestiones que inician hoy</h2>
      <p>
        Hoy, <strong>${escapar(hoy)}</strong>, está programado el inicio de
        <strong>${gestiones.length}</strong> gestión(es):
      </p>
      <table style="border-collapse:collapse">
        <thead>
          <tr style="background:#e9ecef">
            <th style="padding:6px 10px;border:1px solid #dee2e6;text-align:left">Gestión</th>
            <th style="padding:6px 10px;border:1px solid #dee2e6;text-align:left">Versión</th>
            <th style="padding:6px 10px;border:1px solid #dee2e6;text-align:left">Encargado</th>
            <th style="padding:6px 10px;border:1px solid #dee2e6;text-align:right">Locales</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
      <p>Ingrese a Manager Crack, módulo Gestiones, para revisarlas e iniciarlas.</p>
      <hr>
      <small>Este correo fue generado automáticamente por el sistema de administración.</small>
    </div>
  `;

  const enviador =
    enviar || (await import("./mailService.js")).enviarCorreoAlerta;

  const resultado = await enviador({
    subject: `Gestiones que inician hoy (${gestiones.length})`,
    html,
    to: para,
    cc: copia,
    usarCc: Boolean(copia)
  });

  if (!resultado?.ok) {
    console.error(`[GESTIONES] No se pudo enviar el correo de inicio: ${resultado?.error}`);
    return { enviado: false, motivo: "ERROR_ENVIO", error: resultado?.error };
  }

  await db("notificaciones").insert({
    titulo: TITULO_MARCA_CORREO,
    contenido: hoy,
    leido: true,
    url: "sistema",
    created_at: new Date()
  });

  return { enviado: true, gestiones: gestiones.length };
}
