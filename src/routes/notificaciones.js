import express from "express";
import mgmtDb from "../db/adminDb.js";
import { allowRoles } from "../middleware/roleMiddleware.js";

const router = express.Router();

const NOTIFICACIONES_POR_ROL = {
  Admin: [
    "ultima-venta",
    "scheduled-tasks"
  ],
  RRHH: [
    "vendedores"
  ],
  N1: [],
  N2: [],
  Gerente: [],
  Comercial: [],
  Zonal: []
};

router.put("/leido/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const updated = await mgmtDb("notificaciones")
      .where({ id })
      .update({ leido: true });

    if (!updated) {
      return res.status(404).json({ error: "No encontrado" });
    }

    res.json({ ok: true });

  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error actualizando notificación" });
  }
});

router.get("/", async (req, res) => {
  try {
    const role = req.user.role;

    const urlsPermitidas = NOTIFICACIONES_POR_ROL[role] || [];

    if (!urlsPermitidas.length) {
      return res.json([]);
    }

    const notificaciones = await db("notificaciones")
        .where("leido", false)
        .whereIn("url", urlsPermitidas)
        .orderBy("created_at", "desc");

    res.json(notificaciones);

  } catch (error) {
    res.status(500).json({
      message:
        "Error al obtener notificaciones"
    });
  }
});

router.get("/url", async (req, res) => {
  try {
    const { url, leido } = req.query;

    const query = mgmtDb("notificaciones")
      .select("id","titulo","contenido","leido","created_at","url")
      .orderBy("created_at", "desc");

    if (url) {
      query.where("url", url);
    }

    if (leido !== undefined) {
      query.where("leido", leido === "true");
    }

    const notificaciones = await query;

    return res.json({
      success: true,
      notificaciones
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Error al obtener las notificaciones."
    });
  }
});

export default router;