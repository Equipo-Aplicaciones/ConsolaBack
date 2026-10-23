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
