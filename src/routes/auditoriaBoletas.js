import express from "express";
import { allowRoles } from "../middleware/roleMiddleware.js";
import {
  auditarBoletas,
  MAX_DIAS,
  MESA_DESDE,
  MESA_HASTA
} from "../services/auditoriaBoletasService.js";

const router = express.Router();

router.use(allowRoles("Admin"));

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

// Fecha YYYY-MM-DD válida (no solo con el formato correcto: rechaza 2026-02-31)
function fechaValida(texto) {
  if (!FECHA_ISO.test(texto || "")) return null;

  const fecha = new Date(`${texto}T00:00:00Z`);

  return Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== texto ? null : fecha;
}

/* =========================================================
   GET /auditoria-boletas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD

   Solo Admin. `hasta` está incluido; máximo MAX_DIAS días.
   Devuelve el resumen por local y las boletas con diferencias.
========================================================= */

router.get("/", async (req, res) => {
  const desde = fechaValida(req.query.desde);
  const hasta = fechaValida(req.query.hasta);

  if (!desde || !hasta) {
    return res.status(400).json({ error: "Las fechas deben tener el formato AAAA-MM-DD" });
  }

  if (hasta < desde) {
    return res.status(400).json({ error: "La fecha final no puede ser anterior a la inicial" });
  }

  const dias = Math.round((hasta - desde) / 86400000) + 1;

  if (dias > MAX_DIAS) {
    return res.status(400).json({ error: `El rango no puede superar ${MAX_DIAS} días` });
  }

  try {
    const resultado = await auditarBoletas(req.query.desde, req.query.hasta);

    res.json({
      desde: req.query.desde,
      hasta: req.query.hasta,
      mesas: { desde: MESA_DESDE, hasta: MESA_HASTA },
      ...resultado
    });
  } catch (error) {
    console.error("Error en auditoría de boletas:", error);
    res.status(500).json({ error: "Error consultando las boletas en la central" });
  }
});

export default router;
