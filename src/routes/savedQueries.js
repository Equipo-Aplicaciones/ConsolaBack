import express from "express";
import sql from "mssql";
import mgmtDb from "../db/adminDb.js";
import { getConnectionById, makeMssqlConfig } from "../db/connections.js";

const router = express.Router();

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

/* LISTAR */
router.get("/", async (req, res) => {
  try {
    const queries = await mgmtDb("saved_queries")
      .orderBy("nombre");
    res.json(queries);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error obteniendo queries." });
  }
});

/* OBTENER UNA */
router.get("/:id", async (req, res) => {
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
router.get("/:id/runs", async (req, res) => {
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
router.post("/", async (req, res) => {
  try {
    const { nombre, descripcion, sql_text, activo } = req.body;

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
        activo: activo ?? true
      })
      .returning("id");

    res.json({ ok: true, id: typeof id === "object" ? id.id : id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error creando la query." });
  }
});

/* EDITAR */
router.put("/:id", async (req, res) => {
  try {
    const { nombre, descripcion, sql_text, activo } = req.body;

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
        updated_at: new Date()
      });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error actualizando la query." });
  }
});

/* ELIMINAR */
router.delete("/:id", async (req, res) => {
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
router.post("/:id/run", async (req, res) => {
  const { connectionId, sql: sqlText } = req.body;
  const username = req.user?.username;

  if (!connectionId || !sqlText) {
    return res.status(400).json({
      message: "connectionId y sql son requeridos."
    });
  }

  let sqlValidado;

  try {
    sqlValidado = validarSql(sqlText);
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
