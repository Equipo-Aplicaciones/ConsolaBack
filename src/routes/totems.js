import express from "express";
import mgmtDb from "../db/adminDb.js";

const router = express.Router();

/** Obtiene el estado de los tótems del día actual.
 *Devuelve un registro por tótem.*/

router.get("/", async (req, res) => {
  try {
    const hoy = new Date();
    const registros = await mgmtDb("totem_estado_diario as ted")
    .distinctOn("ted.connection_id","ted.totem_numero")
    .leftJoin("connections as c","c.id","ted.connection_id")
    .select(
      "ted.id",
      "ted.connection_id",
      "c.empresa_id",
      "ted.codLocal",
      "ted.totem_numero",
      "ted.ip",
      "ted.estado",
      "ted.hora_encendido",
      "ted.hora_apagado",
      "ted.ultima_revision",
      "ted.fecha",
      "c.name as local_nombre")
    .orderBy([
      {
        column: "ted.connection_id",
        order: "asc"
      },
      {
        column: "ted.totem_numero",
        order: "asc"
      },
      {
        column: "ted.fecha",
        order: "desc"
      }
    ]);

    return res.json(registros);

  } catch (error) {

    console.error(
      "Error obteniendo estado de tótems:",
      error
    );

    return res.status(500).json({
      message: "Error al obtener el estado de los tótems"
    });
  }

});


/**
 * =====================================================
 * GET /totems/resumen
 * =====================================================
 *
 * Obtiene un resumen de los tótems del día actual.
 *
 */
router.get("/resumen", async (req, res) => {

  try {

    const registros = await mgmtDb("totem_estado_diario as ted")
      .leftJoin( "connections as c", "c.id", "ted.connection_id" )
      .whereRaw( "ted.fecha = CURRENT_DATE" )
      .select(
        "ted.codLocal",
        "c.name as local_nombre",
        "ted.totem_numero",
        "ted.estado",
        "ted.hora_encendido",
        "ted.hora_apagado",
        "ted.ultima_revision" )
      .orderBy([
        {
          column: "ted.codLocal",
          order: "asc"
        },
        {
          column: "ted.totem_numero",
          order: "asc"
        }
      ]);

    const resumen = {};

    for (const registro of registros) {

      const codLocal = registro.codLocal;

      if (!resumen[codLocal]) {

        resumen[codLocal] = {
          codLocal,
          localNombre: registro.local_nombre || "",
          total: 0,
          on: 0,
          off: 0,
          totems: []
        };

      }

      resumen[codLocal].total++;

      if (registro.estado === "ON") {
        resumen[codLocal].on++;
      } else {
        resumen[codLocal].off++;
      }

      resumen[codLocal].totems.push({
        numero: registro.totem_numero,
        estado: registro.estado,
        hora_encendido: registro.hora_encendido
      });
    }

    return res.json(
      Object.values(resumen)
    );

  } catch (error) {

    console.error(
      "Error obteniendo resumen de tótems:",
      error
    );

    return res.status(500).json({
      message: "Error al obtener resumen de tótems"
    });
  }

});


router.get("/reporte", async (req, res) => {
  try {
    const { desde, hasta, codLocal, empresa_id } = req.query;

    if (!desde || !hasta) {
      return res.status(400).json({
        message: "Debe indicar fecha desde y fecha hasta."
      });
    }

    const query = mgmtDb("totem_estado_diario as t")
      .join("connections as c", "c.id", "t.connection_id")
      .leftJoin("empresas as e", "e.id", "c.empresa_id")
      .whereBetween("t.fecha", [desde, hasta])
      .select(
        "t.id",
        "t.connection_id",
        "t.codLocal",
        "c.name as local_nombre",
        "e.nombre as empresa_nombre",
        "c.empresa_id",
        "t.totem_numero",
        "t.ip",
        "t.fecha",
        "t.estado",
        "t.hora_encendido",
        "t.ultima_revision"
      )
      .orderBy("c.empresa_id", "asc")
      .orderBy("t.codLocal")
      .orderBy("t.totem_numero")
      .orderBy("t.fecha");

    if (codLocal) {
      query.where("t.codLocal", codLocal);
    }

    if (empresa_id) {
      query.where("c.empresa_id", empresa_id);
    }

    const registros = await query;

    return res.json(registros);

  } catch (error) {
    console.error("Error reporte tótems:", error);

    return res.status(500).json({
      message: "Error generando reporte de tótems."
    });
  }
});


/**
 * =====================================================
 * GET /totems/:codLocal
 * =====================================================
 *
 * Obtiene los tótems correspondientes a un local.
 *
 */
router.get("/:codLocal", async (req, res) => {

  try {

    const { codLocal } = req.params;

    const registros = await mgmtDb("totem_estado_diario as ted")
      .leftJoin("connections as c", "c.id", "ted.connection_id" )
      .where("ted.codLocal",codLocal)
      .whereRaw("ted.fecha = CURRENT_DATE")
      .select(
        "ted.id",
        "ted.connection_id",
        "c.empresa_id",
        "ted.codLocal",
        "ted.totem_numero",
        "ted.ip",
        "ted.estado",
        "ted.hora_encendido",
        "ted.fecha",
        "c.name as local_nombre",
        "ted.ultima_revision")
      .orderBy("ted.totem_numero","asc");
    return res.json(registros);
  } catch (error) {
    console.error(
      "Error obteniendo tótems del local:",
      error
    );

    return res.status(500).json({
      message: "Error al obtener los tótems del local"
    });
  }

});


/**
 * =====================================================
 * GET /totems/:codLocal/:totemNumero
 * =====================================================
 *
 * Obtiene un tótem específico de un local.
 *
 */
router.get("/:codLocal/:totemNumero",async (req, res) => {
    try {
      const { codLocal, totemNumero } = req.params;

      const registro =
        await mgmtDb("totem_estado_diario as ted")
          .leftJoin("connections as c", "c.id","ted.connection_id")
          .where("ted.codLocal",codLocal)
          .where("ted.totem_numero",totemNumero)
          .whereRaw("ted.fecha = CURRENT_DATE")
          .select(
            "ted.id",
            "ted.connection_id",
            "ted.empresa_id",
            "c.codLocal",
            "ted.totem_numero",
            "ted.ip",
            "ted.estado",
            "ted.hora_encendido",
            "ted.fecha",
            "c.name as local_nombre",
            "ted.ultima_revision"
          ).first();

      if (!registro) {

        return res.status(404).json({
          message: "No existe información para este tótem"
        });

      }

      return res.json(registro);

    } catch (error) {

      console.error(
        "Error obteniendo tótem:",
        error
      );

      return res.status(500).json({
        message: "Error al obtener el tótem"
      });
    }

  }
);


export default router;