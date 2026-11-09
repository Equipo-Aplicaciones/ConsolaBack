import express from "express";
import db from "../db/adminDb.js";
import { allowRoles } from "../middleware/roleMiddleware.js";

const router = express.Router();

router.use(allowRoles("Admin", "N1", "N2"));

const GRUPO_ESTADO = "INCIDENCIA";

router.param("id", (_req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(404).json({ error: "Incidencia no encontrada" });
  }

  next();
});

function limpiarTexto(valor, max) {
  const texto = String(valor ?? "").trim().slice(0, max);
  return texto || null;
}

function fechaValida(valor) {
  if (!valor) return null;
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

async function obtenerEstado(codigo, trx = db) {
  return trx("estados")
    .where({ grupo: GRUPO_ESTADO, codigo: String(codigo || "").toUpperCase(), activo: true })
    .first();
}

const baseConsulta = (trx = db) =>
  trx("incidencias as i")
    .join("connections as c", "c.id", "i.connection_id")
    .join("estados as e", "e.id", "i.estado_id")
    .leftJoin("users as u", "u.id", "i.creado_por")
    .select(
      "i.id",
      "i.connection_id",
      "c.name as local_nombre",
      "c.codLocal as local_codigo",
      "i.titulo",
      "i.descripcion",
      "i.categoria",
      "i.estado_id",
      "e.codigo as estado_codigo",
      "e.nombre as estado_nombre",
      "i.fecha_incidencia",
      "i.resuelta_at",
      "i.creado_por",
      "u.full_name as creado_por_nombre",
      "i.created_at",
      "i.updated_at"
    );

/* =========================================================
   GET /incidencias
   Filtros: ?connection_id=  ?estado=ABIERTA,EN_SEGUIMIENTO
            ?categoria=  ?search=
========================================================= */

router.get("/", async (req, res) => {
  try {
    const { connection_id, estado, categoria, search } = req.query;

    const query = baseConsulta()
      .select(
        db.raw(
          "(SELECT COUNT(*) FROM incidencia_seguimientos s WHERE s.incidencia_id = i.id)::int AS seguimientos"
        )
      )
      .orderBy("i.fecha_incidencia", "desc")
      .orderBy("i.id", "desc");

    if (connection_id) {
      const id = Number(connection_id);

      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: "El local no es válido" });
      }

      query.where("i.connection_id", id);
    }

    if (estado) {
      const codigos = String(estado)
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);

      if (codigos.length) {
        query.whereIn("e.codigo", codigos);
      }
    }

    if (categoria) {
      query.where("i.categoria", String(categoria));
    }

    if (search) {
      const patron = `%${String(search).trim()}%`;

      query.where(function () {
        this.whereILike("i.titulo", patron)
          .orWhereILike("i.descripcion", patron)
          .orWhereILike("i.categoria", patron)
          .orWhereILike("c.name", patron);
      });
    }

    res.json(await query);
  } catch (error) {
    console.error("Error listando incidencias:", error);
    res.status(500).json({ error: "Error listando incidencias" });
  }
});

/* =========================================================
   GET /incidencias/categorias
   Categorías ya usadas, para sugerirlas al registrar.
========================================================= */

router.get("/categorias", async (_req, res) => {
  try {
    const filas = await db("incidencias")
      .whereNotNull("categoria")
      .distinct("categoria")
      .orderBy("categoria", "asc");

    res.json(filas.map((f) => f.categoria));
  } catch (error) {
    console.error("Error obteniendo categorías de incidencias:", error);
    res.status(500).json({ error: "Error obteniendo categorías" });
  }
});

/* =========================================================
   GET /incidencias/:id
   Detalle con su seguimiento (del más antiguo al más reciente).
========================================================= */

router.get("/:id", async (req, res) => {
  try {
    const incidencia = await baseConsulta().where("i.id", req.params.id).first();

    if (!incidencia) {
      return res.status(404).json({ error: "Incidencia no encontrada" });
    }

    const seguimientos = await db("incidencia_seguimientos as s")
      .leftJoin("users as u", "u.id", "s.usuario_id")
      .leftJoin("estados as e", "e.id", "s.estado_id")
      .where("s.incidencia_id", incidencia.id)
      .select(
        "s.id",
        "s.comentario",
        "s.created_at",
        "u.full_name as usuario_nombre",
        "e.codigo as estado_codigo",
        "e.nombre as estado_nombre"
      )
      .orderBy("s.created_at", "asc")
      .orderBy("s.id", "asc");

    res.json({ ...incidencia, seguimientos });
  } catch (error) {
    console.error("Error obteniendo incidencia:", error);
    res.status(500).json({ error: "Error obteniendo incidencia" });
  }
});

/* =========================================================
   POST /incidencias
   BODY: { connection_id, titulo, descripcion?, categoria?, fecha_incidencia? }
========================================================= */

router.post("/", async (req, res) => {
  try {
    const connectionId = Number(req.body.connection_id);
    const titulo = limpiarTexto(req.body.titulo, 200);

    if (!Number.isInteger(connectionId)) {
      return res.status(400).json({ error: "Debe seleccionar un local" });
    }

    if (!titulo) {
      return res.status(400).json({ error: "Debe ingresar un título" });
    }

    const local = await db("connections").where({ id: connectionId }).first("id");

    if (!local) {
      return res.status(400).json({ error: "El local seleccionado no existe" });
    }

    const estado = await obtenerEstado("ABIERTA");

    if (!estado) {
      return res.status(500).json({ error: "No está configurado el estado Abierta" });
    }

    const fecha = req.body.fecha_incidencia ? fechaValida(req.body.fecha_incidencia) : new Date();

    if (!fecha) {
      return res.status(400).json({ error: "La fecha de la incidencia no es válida" });
    }

    const [creada] = await db("incidencias")
      .insert({
        connection_id: connectionId,
        titulo,
        descripcion: limpiarTexto(req.body.descripcion, 5000),
        categoria: limpiarTexto(req.body.categoria, 100),
        estado_id: estado.id,
        fecha_incidencia: fecha,
        creado_por: req.user.id,
        created_at: db.fn.now(),
        updated_at: db.fn.now()
      })
      .returning("id");

    res.status(201).json({ id: creada.id ?? creada });
  } catch (error) {
    console.error("Error creando incidencia:", error);
    res.status(500).json({ error: "Error creando incidencia" });
  }
});

/* =========================================================
   PUT /incidencias/:id
   Edita título, descripción, categoría y fecha. El estado cambia
   con un seguimiento.
========================================================= */

router.put("/:id", async (req, res) => {
  try {
    const titulo = limpiarTexto(req.body.titulo, 200);

    if (!titulo) {
      return res.status(400).json({ error: "Debe ingresar un título" });
    }

    const cambios = {
      titulo,
      descripcion: limpiarTexto(req.body.descripcion, 5000),
      categoria: limpiarTexto(req.body.categoria, 100),
      updated_at: db.fn.now()
    };

    if (req.body.fecha_incidencia) {
      const fecha = fechaValida(req.body.fecha_incidencia);

      if (!fecha) {
        return res.status(400).json({ error: "La fecha de la incidencia no es válida" });
      }

      cambios.fecha_incidencia = fecha;
    }

    const actualizadas = await db("incidencias").where({ id: req.params.id }).update(cambios);

    if (!actualizadas) {
      return res.status(404).json({ error: "Incidencia no encontrada" });
    }

    res.json({ message: "Incidencia actualizada" });
  } catch (error) {
    console.error("Error actualizando incidencia:", error);
    res.status(500).json({ error: "Error actualizando incidencia" });
  }
});

/* =========================================================
   POST /incidencias/:id/seguimientos
   BODY: { comentario, estado_codigo? }
   Si trae estado_codigo y es distinto al actual, la incidencia pasa
   a ese estado (Resuelta registra la fecha de resolución).
========================================================= */

router.post("/:id/seguimientos", async (req, res) => {
  try {
    const comentario = limpiarTexto(req.body.comentario, 5000);

    if (!comentario) {
      return res.status(400).json({ error: "Debe ingresar un comentario" });
    }

    const resultado = await db.transaction(async (trx) => {
      const incidencia = await trx("incidencias").where({ id: req.params.id }).first();

      if (!incidencia) {
        return { status: 404, error: "Incidencia no encontrada" };
      }

      let estadoNuevo = null;

      if (req.body.estado_codigo) {
        estadoNuevo = await obtenerEstado(req.body.estado_codigo, trx);

        if (!estadoNuevo) {
          return { status: 400, error: "El estado seleccionado no es válido" };
        }
      }

      const cambiaEstado = estadoNuevo && estadoNuevo.id !== incidencia.estado_id;

      await trx("incidencia_seguimientos").insert({
        incidencia_id: incidencia.id,
        comentario,
        estado_id: cambiaEstado ? estadoNuevo.id : null,
        usuario_id: req.user.id,
        created_at: trx.fn.now()
      });

      const cambios = { updated_at: trx.fn.now() };

      if (cambiaEstado) {
        cambios.estado_id = estadoNuevo.id;
        cambios.resuelta_at = estadoNuevo.codigo === "RESUELTA" ? trx.fn.now() : null;
      }

      await trx("incidencias").where({ id: incidencia.id }).update(cambios);

      return { status: 201 };
    });

    if (resultado.error) {
      return res.status(resultado.status).json({ error: resultado.error });
    }

    res.status(201).json({ message: "Seguimiento registrado" });
  } catch (error) {
    console.error("Error registrando seguimiento:", error);
    res.status(500).json({ error: "Error registrando seguimiento" });
  }
});

/* =========================================================
   DELETE /incidencias/:id
   Solo Admin. Borra también su seguimiento.
========================================================= */

router.delete("/:id", allowRoles("Admin"), async (req, res) => {
  try {
    const borradas = await db("incidencias").where({ id: req.params.id }).delete();

    if (!borradas) {
      return res.status(404).json({ error: "Incidencia no encontrada" });
    }

    res.json({ message: "Incidencia eliminada" });
  } catch (error) {
    console.error("Error eliminando incidencia:", error);
    res.status(500).json({ error: "Error eliminando incidencia" });
  }
});

export default router;
