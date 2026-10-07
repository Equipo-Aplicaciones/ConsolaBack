import express from "express";
import multer from "multer";
import db from "../db/adminDb.js";
import { allowRoles } from "../middleware/roleMiddleware.js";

const router = express.Router();

router.use(allowRoles("Admin"));

const MAX_JSON_BYTES = 50 * 1024 * 1024;

const recibirJson = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_JSON_BYTES, files: 1 }
}).single("file");

function limpiarTexto(valor, max) {
  const texto = String(valor ?? "").trim().slice(0, max);
  return texto || null;
}

function normalizarCambios(valor) {
  try {
    const lista = JSON.parse(valor);
    return Array.isArray(lista) ? lista.map(String).slice(0, 5000) : [];
  } catch {
    return [];
  }
}

function normalizarDetalle(valor) {
  try {
    const lista = JSON.parse(valor);
    return Array.isArray(lista)
      ? lista.filter((x) => x && typeof x === "object" && !Array.isArray(x)).slice(0, 5000)
      : [];
  } catch {
    return [];
  }
}

/* =========================================================
   GET /editor-menu/versiones
   Historial de menús exportados (sin el contenido del JSON).
========================================================= */

router.get("/versiones", async (req, res) => {
  try {
    const versiones = await db("editor_menu_versiones as v")
      .leftJoin("users as u", "u.id", "v.subido_por")
      .select(
        "v.id",
        "v.agregador",
        "v.nombre_archivo",
        "v.descripcion",
        "v.cambios",
        "v.cantidad_imagenes",
        "v.tamano",
        "v.created_at",
        "u.full_name as usuario_nombre"
      )
      .orderBy("v.created_at", "desc")
      .limit(300);

    res.json(versiones);
  } catch (error) {
    console.error("Error listando versiones del editor de menú:", error);
    res.status(500).json({ error: "Error listando el historial" });
  }
});

/* =========================================================
   GET /editor-menu/versiones/:id
   Metadatos y detalle estructurado de los cambios (sin el JSON).
========================================================= */

router.get("/versiones/:id", async (req, res) => {
  try {
    const version = await db("editor_menu_versiones as v")
      .leftJoin("users as u", "u.id", "v.subido_por")
      .select(
        "v.id",
        "v.agregador",
        "v.nombre_archivo",
        "v.descripcion",
        "v.cambios",
        "v.cambios_detalle",
        "v.cantidad_imagenes",
        "v.tamano",
        "v.created_at",
        "u.full_name as usuario_nombre"
      )
      .where("v.id", req.params.id)
      .first();

    if (!version) {
      return res.status(404).json({ error: "Versión no encontrada" });
    }

    res.json(version);
  } catch (error) {
    console.error("Error obteniendo detalle de la versión:", error);
    res.status(500).json({ error: "Error obteniendo la versión" });
  }
});

/* =========================================================
   GET /editor-menu/versiones/:id/archivo
   Descarga el JSON exactamente como se exportó.
========================================================= */

router.get("/versiones/:id/archivo", async (req, res) => {
  try {
    const version = await db("editor_menu_versiones")
      .where({ id: req.params.id })
      .first();

    if (!version) {
      return res.status(404).json({ error: "Versión no encontrada" });
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(version.nombre_archivo)}`
    );
    res.send(version.contenido);
  } catch (error) {
    console.error("Error obteniendo versión del editor de menú:", error);
    res.status(500).json({ error: "Error obteniendo la versión" });
  }
});

/* =========================================================
   POST /editor-menu/versiones  (multipart)
   file: JSON exportado | descripcion | agregador | cambios (JSON)
   | cantidad_imagenes
========================================================= */

router.post("/versiones", (req, res) => {
  recibirJson(req, res, async (err) => {
    if (err) {
      const mensaje =
        err.code === "LIMIT_FILE_SIZE"
          ? "El JSON supera el máximo de 50 MB"
          : "Error recibiendo el archivo";

      return res.status(400).json({ error: mensaje });
    }

    try {
      const archivo = req.file;
      const descripcion = limpiarTexto(req.body.descripcion, 2000);
      const agregador = limpiarTexto(req.body.agregador, 30);

      if (!archivo) {
        return res.status(400).json({ error: "Debe adjuntar el JSON" });
      }

      if (!descripcion) {
        return res.status(400).json({ error: "La descripción es obligatoria" });
      }

      if (!agregador) {
        return res.status(400).json({ error: "Falta el agregador" });
      }

      const contenido = archivo.buffer.toString("utf8");

      try {
        JSON.parse(contenido);
      } catch {
        return res.status(400).json({ error: "El archivo no es un JSON válido" });
      }

      const nombreArchivo = Buffer.from(archivo.originalname, "latin1")
        .toString("utf8")
        .slice(0, 255);

      const [creada] = await db("editor_menu_versiones")
        .insert({
          agregador,
          nombre_archivo: nombreArchivo,
          descripcion,
          cambios: JSON.stringify(normalizarCambios(req.body.cambios)),
          cambios_detalle: JSON.stringify(normalizarDetalle(req.body.cambios_detalle)),
          cantidad_imagenes: Math.max(0, parseInt(req.body.cantidad_imagenes, 10) || 0),
          contenido,
          tamano: archivo.size,
          subido_por: req.user.id
        })
        .returning(["id", "created_at"]);

      res.status(201).json(creada);
    } catch (error) {
      console.error("Error guardando versión del editor de menú:", error);
      res.status(500).json({ error: "Error guardando la versión" });
    }
  });
});

export default router;
