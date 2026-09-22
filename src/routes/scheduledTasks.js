import express from "express";
import mgmtDb from "../db/adminDb.js";
import runScheduledTasks from "../services/scheduledTaskRunner.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* EMPRESAS DISPONIBLES PARA ASOCIAR A UNA TAREA */

router.get("/empresas-disponibles", async (req, res) => {
  try {
    const empresas = await mgmtDb("empresas")
      .select("id", "codigo", "nombre")
      .where({ activo: true })
      .whereNot("codigo", "QA")
      .orderBy("id");
    res.json(empresas);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error obteniendo empresas."
    });
  }
});

/* LISTAR TAREAS */

router.get("/tareas", async (req, res) => {
  try {
    const tareas = await mgmtDb("scheduled_tasks").orderBy("nombre");
    res.json(tareas);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error obteniendo tareas."
    });
  }
});


/* OBTENER UNA TAREA */
router.get("/tarea/:id", async (req, res) => {
  try {
    const tarea = await mgmtDb("scheduled_tasks")
      .where("id", req.params.id)
      .first();
    if (!tarea) {
      return res.status(404).json({
        message: "Tarea no encontrada."
      });
    }
    const articulos = await mgmtDb("scheduled_task_articles")
      .where("task_id", tarea.id)
      .orderBy("codigo_articulo");

    const empresasTarea = await mgmtDb("scheduled_task_empresas")
      .where("task_id", tarea.id)
      .select("empresa_id");

    res.json({
      ...tarea,
      articulos,
      empresas: empresasTarea.map(e => e.empresa_id)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error obteniendo tarea."
    });
  }
});


/*  CREAR */
router.post("/", async (req, res) => {
  try {
    const {
      nombre,
      descripcion,
      visible,
      requiere_confirmacion,
      dia_activar,
      dia_desactivar,
      tipo_accion,
      campo_objetivo,
      tabla_objetivo,
      articulos,
      empresas
    } = req.body;
    const activo=true
    const omitir_proxima_desactivacion=false
    const codigo=`${nombre.toUpperCase().replace(/\s+/g, "-")}`;


    const [id] = await mgmtDb("scheduled_tasks")
      .insert({
        codigo,
        nombre,
        descripcion,
        activo,
        visible,
        requiere_confirmacion,
        dia_activar: dia_activar ?? null,
        dia_desactivar: dia_desactivar ?? null,
        omitir_proxima_desactivacion,
        tipo_accion: tipo_accion || "TOGGLE_ARTICULO",
        campo_objetivo: campo_objetivo || "invisibl",
        tabla_objetivo: tabla_objetivo ?? null
      })
      .returning("id");


    const taskId = typeof id === "object" ? id.id : id;

    if (articulos?.length) {
      const rows = articulos.map(codigo => ({
        task_id: taskId,
        codigo_articulo: codigo
      }));
      await mgmtDb("scheduled_task_articles")
        .insert(rows);
    }

    if (empresas?.length) {
      const rows = empresas.map(empresa_id => ({
        task_id: taskId,
        empresa_id
      }));
      await mgmtDb("scheduled_task_empresas")
        .insert(rows);
    }

    res.json({
      ok: true
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error creando tarea."
    });
  }
});


/* EDITAR */

router.put("/:id", async (req, res) => {
  try {
    const {
      nombre,
      descripcion,
      activo,
      visible,
      requiere_confirmacion,
      dia_activar,
      dia_desactivar,
      omitir_proxima_desactivacion,
      tipo_accion,
      campo_objetivo,
      tabla_objetivo,
      articulos,
      empresas
    } = req.body;

    await mgmtDb("scheduled_tasks")
      .where("id", req.params.id)
      .update({
        nombre,
        descripcion,
        activo,
        visible,
        requiere_confirmacion,
        dia_activar: dia_activar ?? null,
        dia_desactivar: dia_desactivar ?? null,
        omitir_proxima_desactivacion,
        tipo_accion: tipo_accion || "TOGGLE_ARTICULO",
        campo_objetivo: campo_objetivo || "invisibl",
        tabla_objetivo: tabla_objetivo ?? null,
        updated_at: new Date()
      });

    await mgmtDb("scheduled_task_articles")
      .where("task_id", req.params.id)
      .del();

    if (articulos?.length) {
      const rows = articulos.map(codigo => ({
        task_id: req.params.id,
        codigo_articulo: codigo
      }));
      await mgmtDb("scheduled_task_articles")
        .insert(rows);
    }

    await mgmtDb("scheduled_task_empresas")
      .where("task_id", req.params.id)
      .del();

    if (empresas?.length) {
      const rows = empresas.map(empresa_id => ({
        task_id: req.params.id,
        empresa_id
      }));
      await mgmtDb("scheduled_task_empresas")
        .insert(rows);
    }

    res.json({
      ok: true
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error actualizando tarea."
    });
  }
});


/* ELIMINAR */

router.delete("/:id", async (req, res) => {
  try {
    await mgmtDb("scheduled_task_articles")
      .where("task_id", req.params.id)
      .del();

    await mgmtDb("scheduled_task_empresas")
      .where("task_id", req.params.id)
      .del();

    await mgmtDb("scheduled_task_results")
      .where("task_id", req.params.id)
      .del();

    await mgmtDb("scheduled_tasks")
      .where("id", req.params.id)
      .del();

    res.json({
      ok: true
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error eliminando tarea."
    });
  }
});

/* RESULTADOS DE LA ÚLTIMA EJECUCIÓN */

router.get("/:id/results", async (req, res) => {
  try {
    const resultados = await mgmtDb("scheduled_task_results as r")
      .leftJoin("connections as c", "c.id", "r.connection_id")
      .select("r.id","r.connection_id","c.codLocal","c.name as nombre","r.estado","r.mensaje","r.created_at")
      .where("r.task_id", req.params.id)
      .orderBy("c.codLocal");
    res.json(resultados);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error obteniendo resultados."
    });
  }
});

// Ejecutar tarea manualmente
router.post("/:id/run", async (req, res) => {
  try {
    const taskId = req.params.id;
    const existe = await mgmtDb("scheduled_tasks")
      .where("id", taskId)
      .first();

    if (!existe) {
      return res.status(404).json({
        message: "La tarea no existe."
      });
    }
    await runScheduledTasks({ taskId: Number(taskId) });

    res.json({
      ok: true,
      message: "Tarea ejecutada correctamente."
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: err.message
    });
  }
});

/* Reintentar únicamente los locales que fallaron */
router.post("/:id/retry", async (req, res) => {
  try {
    const taskId = Number(req.params.id);

    // Validar que exista la tarea
    const tarea = await mgmtDb("scheduled_tasks")
      .where("id", taskId)
      .first();

    if (!tarea) {
      return res.status(404).json({
        message: "La tarea no existe."
      });
    }
    // Buscar solamente los locales con error
    const fallidos = await mgmtDb("scheduled_task_results")
      .where({
        task_id: taskId,
        estado: "ERROR"
      })
      .select("connection_id");

    if (!fallidos.length) {
      return res.json({
        ok: true,
        message: "No existen locales pendientes para reintentar."
      });
    }

    const connectionIds = fallidos.map(x => x.connection_id);
    // Ejecutar nuevamente solo esos locales
    await runScheduledTasks({
      taskId,
      connectionIds
    });
    res.json({
      ok: true,
      message: `Reintento ejecutado para ${connectionIds.length} locales.`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: err.message
    });
  }
});

// =============================================
// ACTUALIZAR ESTADO DE UNA TAREA
// PUT /scheduled-tasks/:id
// =============================================
router.put("/estado/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { activo, visible } = req.body;    

    // Validar que se envíe al menos un campo
    if (activo === undefined && visible === undefined) {
      return res.status(400).json({
        message: "No se recibió ningún campo para actualizar."
      });
    }

    // Verificar que exista la tarea
    const tarea = await mgmtDb("scheduled_tasks")
      .where("id", id)
      .first();

    if (!tarea) {
      return res.status(404).json({
        message: "Tarea no encontrada."
      });
    }

    // Construir objeto de actualización
    const updateData = { updated_at: new Date() };
    if (activo !== undefined) { updateData.activo = activo; }
    if (visible !== undefined) { updateData.visible = visible; }

    await mgmtDb("scheduled_tasks")
      .where("id", id)
      .update(updateData);

    res.json({
      ok: true,
      message: "Tarea actualizada correctamente."
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error actualizando la tarea."
    });
  }
});

export default router;