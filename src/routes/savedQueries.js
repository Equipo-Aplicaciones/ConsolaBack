import express from "express";
import sql from "mssql";
import mgmtDb from "../db/adminDb.js";
import { getConnectionById, makeMssqlConfig } from "../db/connections.js";
import { allowRoles } from "../middleware/roleMiddleware.js";

const router = express.Router();

// Roles que se pueden habilitar para ejecutar una consulta (Admin siempre puede)
const ROLES_EJECUTAN_VALIDOS = ["N1", "N2"];

function normalizarRolesEjecutan(valor) {
  return Array.isArray(valor)
    ? [...new Set(valor.filter((rol) => ROLES_EJECUTAN_VALIDOS.includes(rol)))]
    : [];
}

const accionDe = (texto) =>
  String(texto || "").trim().split(/\s+/)[0]?.toUpperCase() || "";

const ACCIONES_PERMITIDAS = ["SELECT", "UPDATE", "DELETE"];

function validarSql(texto) {
  const limpio = String(texto || "").trim();
  const primeraPalabra = limpio.split(/\s+/)[0]?.toUpperCase();

  if (!ACCIONES_PERMITIDAS.includes(primeraPalabra)) {
    throw new Error(
      "Solo se permiten queries que empiecen con SELECT, UPDATE o DELETE."
    );
  }

  return limpio;
}

async function registrarRun({
  savedQueryId,
  connectionId,
  username,
  sqlEjecutado,
  estado,
  mensaje
}) {
  await mgmtDb("saved_query_runs").insert({
    saved_query_id: savedQueryId,
    connection_id: connectionId ?? null,
    username: username ?? null,
    sql_ejecutado: sqlEjecutado,
    estado,
    mensaje
  });
}

/* LISTAR
   Admin: todas, completas. N1 / N2: solo las activas que tienen asignadas para ejecutar, sin el SQL
   (solo su tipo de acción) para que sepan si la consulta modifica datos. */
router.get("/", allowRoles("Admin", "N1", "N2"), async (req, res) => {
  try {
    const query = mgmtDb("saved_queries").orderBy("nombre");

    if (req.user.role === "Admin") {
      return res.json(await query);
    }

    const filas = await query
      .where("activo", true)
      .whereRaw("? = ANY(roles_ejecutan)", [req.user.role]);

    res.json(
      filas.map((q) => ({
        id: q.id,
        nombre: q.nombre,
        descripcion: q.descripcion,
        activo: q.activo,
        accion: accionDe(q.sql_text)
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error obteniendo queries." });
  }
});

/* OBTENER UNA */
router.get("/:id", allowRoles("Admin"), async (req, res) => {
  try {
    const query = await mgmtDb("saved_queries")
      .where("id", req.params.id)
      .first();

    if (!query) {
      return res.status(404).json({ message: "Query no encontrada." });
    }

    res.json(query);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error obteniendo la query." });
  }
});

/* HISTORIAL DE EJECUCIONES */
router.get("/:id/runs", allowRoles("Admin"), async (req, res) => {
  try {
    const runs = await mgmtDb("saved_query_runs as r")
      .leftJoin("connections as c", "c.id", "r.connection_id")
      .select(
        "r.id",
        "r.connection_id",
        "c.codLocal",
        "c.name as nombreLocal",
        "r.username",
        "r.sql_ejecutado",
        "r.estado",
        "r.mensaje",
        "r.created_at"
      )
      .where("r.saved_query_id", req.params.id)
      .orderBy("r.created_at", "desc");

    res.json(runs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error obteniendo el historial." });
  }
});

/* CREAR */
router.post("/", allowRoles("Admin"), async (req, res) => {
  try {
    const { nombre, descripcion, sql_text, activo, roles_ejecutan } = req.body;

    if (!nombre || !sql_text) {
      return res.status(400).json({
        message: "nombre y sql_text son requeridos."
      });
    }

    const [id] = await mgmtDb("saved_queries")
      .insert({
        nombre,
        descripcion: descripcion ?? null,
        sql_text,
        activo: activo ?? true,
        roles_ejecutan: normalizarRolesEjecutan(roles_ejecutan)
      })
      .returning("id");

    res.json({ ok: true, id: typeof id === "object" ? id.id : id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error creando la query." });
  }
});

/* EDITAR */
router.put("/:id", allowRoles("Admin"), async (req, res) => {
  try {
    const { nombre, descripcion, sql_text, activo, roles_ejecutan } = req.body;

    if (!nombre || !sql_text) {
      return res.status(400).json({
        message: "nombre y sql_text son requeridos."
      });
    }

    await mgmtDb("saved_queries")
      .where("id", req.params.id)
      .update({
        nombre,
        descripcion: descripcion ?? null,
        sql_text,
        activo: activo ?? true,
        roles_ejecutan: normalizarRolesEjecutan(roles_ejecutan),
        updated_at: new Date()
      });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error actualizando la query." });
  }
});

/* ELIMINAR */
router.delete("/:id", allowRoles("Admin"), async (req, res) => {
  try {
    await mgmtDb("saved_queries")
      .where("id", req.params.id)
      .del();

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error eliminando la query." });
  }
});

/* EJECUTAR CONTRA UN LOCAL */
router.post("/:id/run", allowRoles("Admin", "N1", "N2"), async (req, res) => {
  const { connectionId } = req.body;
  const username = req.user?.username;

  if (!connectionId) {
    return res.status(400).json({
      message: "connectionId es requerido."
    });
  }

  // Se ejecuta SIEMPRE el SQL guardado: lo que mande el cliente en el cuerpo no se usa.
  let guardada;

  try {
    guardada = await mgmtDb("saved_queries").where("id", req.params.id).first();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error obteniendo la query." });
  }

  if (!guardada) {
    return res.status(404).json({ message: "Query no encontrada." });
  }

  const esAdmin = req.user.role === "Admin";

  if (!esAdmin && (!guardada.activo || !guardada.roles_ejecutan?.includes(req.user.role))) {
    return res.status(403).json({ message: "No tienes permiso para ejecutar esta query." });
  }

  let sqlValidado;

  try {
    sqlValidado = validarSql(guardada.sql_text);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }

  try {
    const conn = await getConnectionById(connectionId);

    if (!conn) {
      return res.status(404).json({ message: "Conexión no encontrada." });
    }

    const config = makeMssqlConfig(conn.host);
    const pool = await new sql.ConnectionPool(config).connect();

    try {
      const result = await pool.request().query(sqlValidado);

      const esSelect = sqlValidado.toUpperCase().startsWith("SELECT");

      const mensaje = esSelect
        ? `${result.recordset?.length ?? 0} fila(s) obtenida(s)`
        : `${result.rowsAffected?.[0] ?? 0} fila(s) afectada(s)`;

      await registrarRun({
        savedQueryId: req.params.id,
        connectionId,
        username,
        sqlEjecutado: sqlValidado,
        estado: "OK",
        mensaje
      });

      res.json({
        success: true,
        data: esSelect ? result.recordset : null,
        rowsAffected: esSelect ? null : result.rowsAffected?.[0] ?? 0,
        message: mensaje
      });
    } finally {
      await pool.close();
    }
  } catch (err) {
    console.error(err);

    await registrarRun({
      savedQueryId: req.params.id,
      connectionId,
      username,
      sqlEjecutado: sqlValidado,
      estado: "ERROR",
      mensaje: err.message
    });

    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
