import express from "express";
import mgmtDb from "../db/adminDB.js";
import { requireAuth } from "../middleware/auth.js";
import { allowRoles } from "../middleware/roleMiddleware.js";
import ExcelJS from "exceljs";
import { logMenuChange } from "../services/menuLogs.service.js";

function resumenHorario({ dias, hora_apertura, hora_cierre, cerrado }) {
  const diasTexto = Array.isArray(dias) ? dias.join(",") : dias;
  return cerrado
    ? `días ${diasTexto}: CERRADO`
    : `días ${diasTexto}: ${hora_apertura} - ${hora_cierre}`;
}

const router = express.Router();

router.use(requireAuth);

/**
 * ============================================================
 * GET /horarios-base
 *
 * Obtiene horarios base.
 *
 * Relación real:
 * local_horarios_base.connection_id -> connections.id
 *
 * codlocal se obtiene desde connections solamente para mostrarlo.
 * ============================================================
 */
router.get("/", allowRoles("Admin", "Comercial", "Zonal"), async (req, res) => {
  try {
    const { page = 1, limit = 10, search, empresa_id, con_horario } = req.query;

    const offset = (Number(page) - 1) * Number(limit);

    const userId = req.user.id;
    const role = req.user.role;

    /* =========================
       QUERY BASE

       LEFT JOIN (en vez de INNER JOIN) para poder listar
       tambien los locales que todavia no tienen ningun
       horario base cargado (filtro "Sin horario").
    ========================= */

    let query = ` SELECT c.id AS connection_id, c."codLocal" AS codlocal, c.name AS local_nombre,
          c.empresa_id, c.formato, u.full_name AS zonal_nombre,
          h.dia_semana, h.hora_apertura, h.hora_cierre, h.activo, h.cerrado
          FROM connections c
          LEFT JOIN local_horarios_base h ON h.connection_id = c.id
          LEFT JOIN users u ON u.id = c.zonal`;

    const params = [];
    const where = [];

    /*  FILTRO ZONAL  */

    if (role === "Zonal") {
      where.push(`c.zonal = ?`);
      params.push(userId);
    }

    if (empresa_id) {
      where.push(`c.empresa_id = ?`);
      params.push(Number(empresa_id));
    }

    /*  BUSCADOR */

    if (search) {
      where.push(
        `( LOWER(c.name) LIKE LOWER(?) OR CAST(c."codLocal" AS TEXT) LIKE ?)`,
      );
      params.push(`%${search}%`, `%${search}%`);
    }

    /* ARMAR WHERE */

    if (where.length > 0) {
      query += ` WHERE ${where.join(" AND ")} `;
    }

    query += ` ORDER BY c.name, h.hora_apertura, h.dia_semana `;
    const result = await mgmtDb.raw(query, params);
    const rows = result.rows;

    /*  MAPA DE DÍAS  */

    const diasMap = {
      1: "Lun",
      2: "Mar",
      3: "Mié",
      4: "Jue",
      5: "Vie",
      6: "Sáb",
      7: "Dom",
    };

    /*  AGRUPACIÓN
       IMPORTANTE:
       Antes se agrupaba por codlocal.
       
       Ahora se agrupa por connection_id
       porque dos empresas pueden tener
       el mismo codLocal.
    ========================= */

    const agrupado = {};

    rows.forEach((r) => {
      const keyLocal = r.connection_id;

      if (!agrupado[keyLocal]) {
        agrupado[keyLocal] = {
          connection_id: r.connection_id,
          codlocal: r.codlocal,
          local_nombre: r.local_nombre,
          empresa_id: r.empresa_id,
          formato: r.formato,
          zonal_nombre: r.zonal_nombre,
          bloques: {},
        };
      }

      /* Local sin ningun horario cargado: el LEFT JOIN trae
         una fila con dia_semana null. No arma bloque. */
      if (r.dia_semana == null) return;

      const keyBloque = `${r.hora_apertura}-${r.hora_cierre}-${r.activo}-${r.cerrado}`;

      if (!agrupado[keyLocal].bloques[keyBloque]) {
        agrupado[keyLocal].bloques[keyBloque] = {
          dias: [],
          hora_apertura: r.cerrado ? null : r.hora_apertura?.slice(0, 5),
          hora_cierre: r.cerrado ? null : r.hora_cierre?.slice(0, 5),
          activo: r.activo,
          cerrado: r.cerrado,
        };
      }

      agrupado[keyLocal].bloques[keyBloque].dias.push(diasMap[r.dia_semana]);
    });

    /* =========================
       RESPUESTA
    ========================= */

    let items = Object.values(agrupado).map((local) => ({
      connection_id: local.connection_id,
      codlocal: local.codlocal,
      local_nombre: local.local_nombre,
      empresa_id: local.empresa_id,
      formato: local.formato,
      zonal_nombre: local.zonal_nombre,
      horarios: Object.values(local.bloques).map((b) => ({
        dias: b.dias.join(" - "),
        horario: b.cerrado
          ? "CERRADO"
          : `${b.hora_apertura} - ${b.hora_cierre}`,
        hora_apertura: b.hora_apertura,
        hora_cierre: b.hora_cierre,
        activo: b.activo,
        cerrado: b.cerrado,
      })),
    }));

    /* FILTRO CON/SIN HORARIO */

    if (con_horario === "true") {
      items = items.filter((local) => local.horarios.length > 0);
    } else if (con_horario === "false") {
      items = items.filter((local) => local.horarios.length === 0);
    }

    const paginatedItems = items.slice(offset, offset + Number(limit));

    res.json({
      items: paginatedItems,
      total: items.length,
    });
  } catch (err) {
    console.error("ERROR OBTENIENDO HORARIOS BASE:", err);
    res.status(500).json({
      error: "Error obteniendo horarios base",
    });
  }
});

/**
 * ============================================================
 * POST /
 *
 * Crear / actualizar un horario base
 * ============================================================
 */
router.post(
  "/",
  allowRoles("Admin", "Comercial", "Zonal"),
  async (req, res) => {
    let {
      connection_id,
      dia_semana,
      hora_apertura,
      hora_cierre,
      activo,
      cerrado = false,
    } = req.body;

    if (connection_id == null || dia_semana == null) {
      return res.status(400).json({
        error: "Connection y día son obligatorios",
      });
    }

    /* Si está cerrado no necesitamos horas. */

    if (cerrado) {
      hora_apertura = null;
      hora_cierre = null;
    } else {
      if (!hora_apertura || !hora_cierre) {
        return res.status(400).json({
          error: "Horario incompleto",
        });
      }

      if (hora_apertura >= hora_cierre) {
        return res.status(400).json({
          error: "Horario inválido",
        });
      }
    }

    try {
      /*
       * Validar que connection exista
       */

      const connection = await mgmtDb("connections")
        .where({ id: connection_id })
        .first();

      if (!connection) {
        return res.status(404).json({
          error: "Local no encontrado",
        });
      }

      const anterior = await mgmtDb("local_horarios_base")
        .where({ connection_id, dia_semana })
        .first();

      await mgmtDb.raw(
        ` INSERT INTO local_horarios_base (
          connection_id,
          dia_semana,
          hora_apertura,
          hora_cierre,
          activo,
          cerrado
        )

        VALUES ( ?, ?, ?, ?, COALESCE(?, true), COALESCE(?, false) )
        ON CONFLICT (connection_id, dia_semana)
        DO UPDATE SET
          hora_apertura = EXCLUDED.hora_apertura,
          hora_cierre = EXCLUDED.hora_cierre,
          activo = EXCLUDED.activo,
          cerrado = EXCLUDED.cerrado,
          created_at = now()`,
        [
          connection_id,
          dia_semana,
          hora_apertura,
          hora_cierre,
          activo,
          cerrado,
        ],
      );

      await logMenuChange({
        entidad: "horario_base",
        entidadId: connection_id,
        campo: `dia_${dia_semana}`,
        valorAnterior: anterior
          ? resumenHorario({
              dias: [dia_semana],
              hora_apertura: anterior.hora_apertura,
              hora_cierre: anterior.hora_cierre,
              cerrado: anterior.cerrado,
            })
          : "sin horario",
        valorNuevo: resumenHorario({
          dias: [dia_semana],
          hora_apertura,
          hora_cierre,
          cerrado,
        }),
        usuario: req.user.username,
        rol: req.user.role,
      });

      res.json({ ok: true });
    } catch (err) {
      console.error("ERROR GUARDANDO HORARIO BASE:", err);

      res.status(500).json({
        error: "Error guardando horario base",
      });
    }
  },
);

/**
 * ============================================================
 * POST /bulk
 *
 * Crear horarios para varios locales y días
 *
 * locales debe contener connection_id:
 *
 * locales: [114, 115, 116]
 * ============================================================
 */
router.post("/bulk", allowRoles("Admin", "Zonal"), async (req, res) => {
  try {
    let {
      dias,
      locales,
      hora_apertura,
      hora_cierre,
      activo = true,
      cerrado = false,
    } = req.body;

    /* =========================
         NORMALIZAR HORARIO
      ========================= */

    if (cerrado) {
      hora_apertura = null;
      hora_cierre = null;
    } else {
      if (!hora_apertura || !hora_cierre || hora_apertura >= hora_cierre) {
        return res.status(400).json({
          error: "Horario inválido",
        });
      }
    }

    /* =========================
         VALIDAR DÍAS
      ========================= */

    if (!Array.isArray(dias) || dias.length === 0) {
      return res.status(400).json({
        error: "Debe seleccionar al menos un día",
      });
    }

    /* =========================
         VALIDAR LOCALES
      ========================= */

    if (!Array.isArray(locales) || locales.length === 0) {
      return res.status(400).json({
        error: "Debe seleccionar al menos un local",
      });
    }

    /*
     * locales contiene connection_id
     */

    const connectionIds = locales.map(Number);

    /*
     * Validar que existan.
     */

    const connections = await mgmtDb("connections")
      .whereIn("id", connectionIds)
      .select("id");

    if (connections.length !== connectionIds.length) {
      return res.status(400).json({
        error: "Uno o más locales no existen",
      });
    }

    /* =========================
         GENERAR FILAS
      ========================= */

    const rows = [];

    for (const connection_id of connectionIds) {
      for (const dia_semana of dias) {
        rows.push({
          connection_id,
          dia_semana,
          hora_apertura,
          hora_cierre,
          activo,
          cerrado,
        });
      }
    }

    /* =========================
         INSERT / UPDATE
      ========================= */

    await mgmtDb("local_horarios_base")
      .insert(rows)
      .onConflict(["connection_id", "dia_semana"])
      .merge({
        hora_apertura,
        hora_cierre,
        activo,
        cerrado,
        created_at: mgmtDb.fn.now(),
      });

    const resumenNuevo = resumenHorario({ dias, hora_apertura, hora_cierre, cerrado });

    for (const connection_id of connectionIds) {
      await logMenuChange({
        entidad: "horario_base",
        entidadId: connection_id,
        campo: "bulk_horario",
        valorAnterior: null,
        valorNuevo: resumenNuevo,
        usuario: req.user.username,
        rol: req.user.role,
      });
    }

    res.json({
      ok: true,
      inserted: rows.length,
    });
  } catch (err) {
    console.error("ERROR BULK HORARIO BASE:", err);

    res.status(500).json({
      error: "Error guardando horarios base",
    });
  }
});

/**
 * ============================================================
 * PATCH /:id/estado
 *
 * Activar / desactivar horario
 * ============================================================
 */
router.patch("/:id/estado", allowRoles("Admin", "Zonal"), async (req, res) => {
  const { activo } = req.body;

  try {
    await mgmtDb("local_horarios_base")
      .where({
        id: req.params.id,
      })
      .update({
        activo,
      });

    res.json({
      ok: true,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Error cambiando estado",
    });
  }
});

/**
 * ============================================================
 * DELETE /:id
 * ============================================================
 */
router.delete("/:id", allowRoles("Admin"), async (req, res) => {
  try {
    await mgmtDb("local_horarios_base")
      .where({
        id: req.params.id,
      })
      .del();

    res.json({
      ok: true,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Error eliminando horario",
    });
  }
});

/**
 * ============================================================
 * POST /replace/:connectionId
 *
 * Reemplaza todos los horarios base
 * del local seleccionado.
 *
 * ANTES:
 *
 * /replace/:codlocal
 *
 * AHORA:
 *
 * /replace/:connectionId
 * ============================================================
 */
router.post(
  "/replace/:connectionId",
  allowRoles("Admin", "Comercial", "Zonal"),
  async (req, res) => {
    const connectionId = Number(req.params.connectionId);

    let { dias, hora_apertura, hora_cierre, activo, cerrado } = req.body;

    if (!connectionId || Number.isNaN(connectionId)) {
      return res.status(400).json({
        message: "Connection inválida",
      });
    }

    /*
     * Normalizar horario
     */

    if (cerrado) {
      hora_apertura = null;
      hora_cierre = null;
    } else {
      if (!hora_apertura || !hora_cierre || hora_apertura >= hora_cierre) {
        return res.status(400).json({
          message: "Horario inválido",
        });
      }
    }

    if (!Array.isArray(dias) || dias.length === 0) {
      return res.status(400).json({
        message: "Días son obligatorios",
      });
    }

    try {
      /*
       * Validar connection
       */

      const connection = await mgmtDb("connections")
        .where({
          id: connectionId,
        })
        .first();

      if (!connection) {
        return res.status(404).json({
          message: "Local no encontrado",
        });
      }

      const anteriores = await mgmtDb("local_horarios_base").where({
        connection_id: connectionId,
      });

      const resumenAnterior = anteriores.length
        ? anteriores
            .map((h) =>
              resumenHorario({
                dias: [h.dia_semana],
                hora_apertura: h.hora_apertura,
                hora_cierre: h.hora_cierre,
                cerrado: h.cerrado,
              }),
            )
            .join(" | ")
        : "sin horario";

      await mgmtDb.transaction(async (trx) => {
        /*
         * 1. Eliminar horarios
         */

        await trx("local_horarios_base")
          .where({
            connection_id: connectionId,
          })
          .del();

        /*
         * 2. Crear nuevos horarios
         */

        const rows = dias.map((dia) => ({
          connection_id: connectionId,

          dia_semana: dia,

          hora_apertura,

          hora_cierre,

          activo,

          cerrado,
        }));

        await trx("local_horarios_base").insert(rows);
      });

      await logMenuChange({
        entidad: "horario_base",
        entidadId: connectionId,
        campo: "reemplazo_horario",
        valorAnterior: resumenAnterior,
        valorNuevo: resumenHorario({ dias, hora_apertura, hora_cierre, cerrado }),
        usuario: req.user.username,
        rol: req.user.role,
      });

      res.json({
        message: "Horario base reemplazado correctamente",
      });
    } catch (err) {
      console.error("REPLACE HORARIO BASE ERROR:", err);

      res.status(500).json({
        message: "Error reemplazando horarios base",
      });
    }
  },
);

/**
 * ============================================================
 * GET /export/excel
 *
 * EXPORTACIÓN
 *
 * IMPORTANTE:
 * vw_horarios_unificados debe estar actualizada
 * para trabajar internamente con connection_id.
 *
 * La vista puede seguir exponiendo codlocal
 * obteniéndolo desde connections.
 * ============================================================
 */
router.get(
  "/export/excel",
  allowRoles("Admin", "Comercial", "Zonal"),
  async (req, res) => {
    try {
      const horarios = await mgmtDb("vw_horarios_unificados").orderBy([
        "codlocal",
        "menuOrigen",
        "tipo_horario",
        "fecha",
      ]);

      const wb = new ExcelJS.Workbook();

      /* =========================
         HOJA: HORARIOS BASE
      ========================= */

      const wsBase = wb.addWorksheet("Horarios Base");

      wsBase.columns = [
        {
          header: "Código Local",
          key: "codlocal",
          width: 15,
        },

        {
          header: "Nombre Local",
          key: "nombre_local",
          width: 30,
        },

        {
          header: "Menú Origen",
          key: "menuOrigen",
          width: 20,
        },

        {
          header: "Menú Crítico",
          key: "menuCritico",
          width: 15,
        },

        {
          header: "Días",
          key: "dias",
          width: 25,
        },

        {
          header: "Horario",
          key: "horario",
          width: 20,
        },

        {
          header: "Estado",
          key: "estado",
          width: 15,
        },

        {
          header: "Tipo Horario",
          key: "tipo_horario",
          width: 15,
        },
      ];

      horarios
        .filter((h) => h.tipo_horario === "BASE")
        .forEach((h) => {
          wsBase.addRow({
            codlocal: h.codlocal,

            nombre_local: h.nombre_local,

            menuOrigen: h.menuOrigen,

            menuCritico: h.menuCritico,

            dias: h.dias,

            horario: h.cerrado
              ? "CERRADO"
              : `${h.hora_apertura?.slice(0, 5)} - ${h.hora_cierre?.slice(0, 5)}`,

            estado: h.activo ? "Activo" : "Inactivo",

            tipo_horario: h.tipo_horario,
          });
        });

      /* =========================
         HOJA: HORARIOS ESPECIALES
      ========================= */

      const wsEsp = wb.addWorksheet("Horarios Especiales");

      wsEsp.columns = [
        {
          header: "Código Local",
          key: "codlocal",
          width: 15,
        },

        {
          header: "Nombre Local",
          key: "nombre_local",
          width: 30,
        },

        {
          header: "Menú Origen",
          key: "menuOrigen",
          width: 20,
        },

        {
          header: "Menú Crítico",
          key: "menuCritico",
          width: 15,
        },

        {
          header: "Fecha",
          key: "fecha",
          width: 15,
        },

        {
          header: "Horario",
          key: "horario",
          width: 20,
        },

        {
          header: "Estado",
          key: "estado",
          width: 15,
        },

        {
          header: "Tipo Horario",
          key: "tipo_horario",
          width: 15,
        },

        {
          header: "Fecha Solicitud",
          key: "f_solicitud",
          width: 25,
        },
      ];

      horarios
        .filter((h) => h.tipo_horario === "ESPECIAL")
        .forEach((h) => {
          wsEsp.addRow({
            codlocal: h.codlocal,

            nombre_local: h.nombre_local,

            menuOrigen: h.menuOrigen,

            menuCritico: h.menuCritico,

            fecha: h.fecha ? h.fecha.toISOString().split("T")[0] : "",

            horario: h.cerrado
              ? "CERRADO"
              : `${h.hora_apertura?.slice(0, 5)} - ${h.hora_cierre?.slice(0, 5)}`,

            estado: h.activo ? "Activo" : "Inactivo",

            tipo_horario: h.tipo_horario,

            f_solicitud: h.f_solicitud
              ? h.f_solicitud.toISOString().replace("T", " ").slice(0, 19)
              : "",
          });
        });

      /* =========================
         RESPONSE
      ========================= */

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );

      res.setHeader(
        "Content-Disposition",
        "attachment; filename=horarios.xlsx",
      );

      await wb.xlsx.write(res);

      res.end();
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Error exportando Excel",
      });
    }
  },
);

export default router;
