import express from "express";
import multer from "multer";
import db from "../db/adminDb.js";
import { allowRoles } from "../middleware/roleMiddleware.js";

const router = express.Router();

const MAX_PDF_BYTES = 10 * 1024 * 1024;

const subirPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1 }
}).single("file");

const ROLES_VALIDOS = ["Admin", "N1", "N2", "Gerente", "RRHH", "Comercial", "Zonal"];

// roles_visibles vacío = visible para todos; Admin siempre ve todo.
function normalizarRoles(valor) {
  let lista = valor;

  if (typeof lista === "string") {
    try {
      lista = JSON.parse(lista);
    } catch {
      lista = [];
    }
  }

  if (!Array.isArray(lista)) return [];

  return [...new Set(lista.filter((rol) => ROLES_VALIDOS.includes(rol)))];
}

function puedeVer(documento, user) {
  return (
    user.role === "Admin" ||
    documento.roles_visibles.length === 0 ||
    documento.roles_visibles.includes(user.role)
  );
}

const COLUMNAS_LISTADO = [
  "d.id",
  "d.titulo",
  "d.descripcion",
  "d.categoria",
  "d.roles_visibles",
  "d.nombre_archivo",
  "d.tamano",
  "d.created_at",
  "u.full_name as subido_por_nombre"
];

function limpiarTexto(valor, max) {
  const texto = String(valor ?? "").trim().slice(0, max);
  return texto || null;
}

/* =========================================================
   GET /docs-ayuda
   Cualquier usuario autenticado puede consultar. Devuelve solo
   metadatos (sin el PDF); el frontend filtra por texto/categoría.
========================================================= */

router.get("/", async (req, res) => {
  try {
    const query = db("ayuda_documentos as d")
      .leftJoin("users as u", "u.id", "d.subido_por")
      .select(COLUMNAS_LISTADO)
      .orderBy("d.categoria", "asc")
      .orderBy("d.titulo", "asc");

    if (req.user.role !== "Admin") {
      query.whereRaw(
        "(cardinality(d.roles_visibles) = 0 OR ? = ANY(d.roles_visibles))",
        [req.user.role]
      );
    }

    res.json(await query);
  } catch (error) {
    console.error("Error listando documentos de ayuda:", error);
    res.status(500).json({ error: "Error listando documentos de ayuda" });
  }
});

router.get("/:id/archivo", async (req, res) => {
  try {
    const documento = await db("ayuda_documentos")
      .where({ id: req.params.id })
      .first();

    if (!documento || !puedeVer(documento, req.user)) {
      return res.status(404).json({ error: "Documento no encontrado" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", documento.contenido.length);
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(documento.nombre_archivo)}`
    );
    res.send(documento.contenido);
  } catch (error) {
    console.error("Error obteniendo documento de ayuda:", error);
    res.status(500).json({ error: "Error obteniendo documento de ayuda" });
  }
});

/* =========================================================
   POST / PUT / DELETE: solo Admin
========================================================= */

router.post("/", allowRoles("Admin"), (req, res) => {
  subirPdf(req, res, async (err) => {
    if (err) {
      const mensaje =
        err.code === "LIMIT_FILE_SIZE"
          ? "El PDF supera el máximo de 10 MB"
          : "Error recibiendo el archivo";

      return res.status(400).json({ error: mensaje });
    }

    try {
      const archivo = req.file;
      const titulo = limpiarTexto(req.body.titulo, 200);

      if (!archivo) {
        return res.status(400).json({ error: "Debe seleccionar un archivo" });
      }

      if (!titulo) {
        return res.status(400).json({ error: "El título es obligatorio" });
      }

      const esPdf =
        archivo.mimetype === "application/pdf" &&
        archivo.buffer.subarray(0, 5).toString("latin1") === "%PDF-";

      if (!esPdf) {
        return res.status(400).json({ error: "Solo se permiten archivos PDF" });
      }

      const nombreArchivo = Buffer.from(archivo.originalname, "latin1")
        .toString("utf8")
        .slice(0, 255);

      const [creado] = await db("ayuda_documentos")
        .insert({
          titulo,
          descripcion: limpiarTexto(req.body.descripcion, 2000),
          categoria: limpiarTexto(req.body.categoria, 100),
          roles_visibles: normalizarRoles(req.body.roles),
          nombre_archivo: nombreArchivo,
          tamano: archivo.size,
          contenido: archivo.buffer,
          subido_por: req.user.id
        })
        .returning(["id", "titulo", "categoria", "nombre_archivo", "tamano", "created_at"]);

      res.status(201).json(creado);
    } catch (error) {
      console.error("Error subiendo documento de ayuda:", error);
      res.status(500).json({ error: "Error subiendo documento de ayuda" });
    }
  });
});

router.put("/:id", allowRoles("Admin"), async (req, res) => {
  try {
    const titulo = limpiarTexto(req.body.titulo, 200);

    if (!titulo) {
      return res.status(400).json({ error: "El título es obligatorio" });
    }

    const actualizados = await db("ayuda_documentos")
      .where({ id: req.params.id })
      .update({
        titulo,
        descripcion: limpiarTexto(req.body.descripcion, 2000),
        categoria: limpiarTexto(req.body.categoria, 100),
        roles_visibles: normalizarRoles(req.body.roles),
        updated_at: new Date()
      });

    if (!actualizados) {
      return res.status(404).json({ error: "Documento no encontrado" });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Error actualizando documento de ayuda:", error);
    res.status(500).json({ error: "Error actualizando documento de ayuda" });
  }
});

router.delete("/:id", allowRoles("Admin"), async (req, res) => {
  try {
    const eliminados = await db("ayuda_documentos")
      .where({ id: req.params.id })
      .del();

    if (!eliminados) {
      return res.status(404).json({ error: "Documento no encontrado" });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Error eliminando documento de ayuda:", error);
    res.status(500).json({ error: "Error eliminando documento de ayuda" });
  }
});

export default router;
