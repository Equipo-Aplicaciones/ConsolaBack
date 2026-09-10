// src/routes/reports.js
import express from "express";
import mgmtDb from "../db/adminDb.js";
import ExcelJS from "exceljs";
import {allowRoles} from "../middleware/roleMiddleware.js";

const router = express.Router();

const DIAS_ES = {
  Sunday: "Domingo",
  Monday: "Lunes",
  Tuesday: "Martes",
  Wednesday: "Miércoles",
  Thursday: "Jueves",
  Friday: "Viernes",
  Saturday: "Sábado"
};

// 🔥 NORMALIZACIÓN DE NOMBRES DE PRODUCTO
//
// El mismo producto queda cargado varias veces con un sufijo de
// canal/combo distinto (ej: "LATA COCA-COLA CPR", "LATA COCA-COLA PPM",
// "LATA COCA-COLA SPP" son la misma lata de Coca-Cola, solo que se
// registró el agotado desde combos distintos). Se agrupan sacando ese
// sufijo, sin tocar variantes que SÍ son un producto distinto (ej. "SIN
// AZUCAR"/"ZERO" quedan aparte de la versión regular).
const SUFIJOS_CANAL = ["CPR", "PPM", "SPP", "CCR", "CRM", "CRR", "LIENZO", "LIE"];

// Grupos manuales: familias de productos que el catálogo carga con nombres
// libres distintos (typos, tamaños, variantes de combo) pero que para el
// negocio son "lo mismo" a efectos de ver qué se agotó. Se evalúan en orden
// — el primero que matchea gana — así una regla específica (ej. "extra queso
// cheddar") no queda tapada por una más general ("extra queso"). El nombre
// original (post limpieza de sufijo de canal) se conserva como "mix" para
// poder ver el detalle real al hacer clic en el grupo.
const GRUPOS_MANUALES = [
  { test: (n) => n.startsWith("extra queso cheddar"), canonical: "extra queso cheddar" },
  { test: (n) => n.includes("mozzarella stick"), canonical: "mozzarella stick" },
  { test: (n) => n.includes("cafe capuccino") || n.includes("cafe capucciono"), canonical: "cafe capuccino" },
  // "jugo de naranja" y variantes sin el "de" (ej. "jugo naranja r", "jugo naranja m")
  { test: (n) => n.includes("jugo de naranja") || n.includes("jugo naranja"), canonical: "jugo de naranja" },
  { test: (n) => n.includes("extra cebolla") || n.includes("cebolla ring"), canonical: "extra cebolla" },
  { test: (n) => n.includes("bacon bbq"), canonical: "bacon bbq" },
  { test: (n) => n.includes("agua c/gas"), canonical: "agua c/gas" },
  { test: (n) => n.includes("agua s/gas"), canonical: "agua s/gas" },
  { test: (n) => n.includes("coffee time"), canonical: "coffee time" },
  { test: (n) => n.includes("cafe grande"), canonical: "cafe grande" },
  { test: (n) => n.includes("cheddar bbq"), canonical: "cheddar bbq" },
  { test: (n) => n.includes("gringou"), canonical: "gringou" },
  { test: (n) => n.includes("extra queso"), canonical: "extra queso" }
];

function agruparManual(nombreBase) {
  if (!nombreBase) return nombreBase;
  const grupo = GRUPOS_MANUALES.find((g) => g.test(nombreBase));
  return grupo ? grupo.canonical : nombreBase;
}

// Limpieza base: saca el sufijo de canal/combo y pasa todo a minúscula, SIN
// aplicar todavía los grupos manuales de arriba (eso lo hace
// normalizarProducto). Separado para poder guardar el nombre real como
// detalle ("mix") cuando un producto cae dentro de un grupo manual.
function normalizarBase(nombreOriginal) {
  if (!nombreOriginal) return nombreOriginal;

  let nombre = nombreOriginal.trim();

  // "COCA COLA" (sin guión) y "COCA-COLA" son el mismo producto
  nombre = nombre.replace(/\bCOCA\s+COLA\b/gi, "COCA-COLA");

  const partes = nombre.split(/\s+/);
  const ultima = partes[partes.length - 1]?.toUpperCase();

  if (partes.length > 1 && SUFIJOS_CANAL.includes(ultima)) {
    partes.pop();
    nombre = partes.join(" ");
  }

  // Los nombres llegan cargados con mayúsculas/minúsculas mezcladas según
  // quién los tipeó ("Agr Salsa Tarragona" vs "LATA COCA-COLA") — se pasa
  // todo a minúscula para que se vea parejo en todo el dashboard.
  return nombre.trim().toLowerCase();
}

function normalizarProducto(nombreOriginal) {
  return agruparManual(normalizarBase(nombreOriginal));
}

// Suma cantidades de una lista de filas {producto, cantidad} agrupando
// por nombre YA normalizado.
function agruparPorProductoNormalizado(filas, { productoKey = "producto", cantidadKey = "cantidad" } = {}) {
  const mapa = new Map();

  filas.forEach((fila) => {
    const nombre = normalizarProducto(fila[productoKey]);
    const cantidad = Number(fila[cantidadKey]);

    mapa.set(nombre, (mapa.get(nombre) || 0) + cantidad);
  });

  return [...mapa.entries()]
    .map(([producto, cantidad]) => ({ producto, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad);
}

function parseDateRange(q) {
  const today = new Date();

  // Si viene date_from o date_to, tratarlas como fechas locales (sin shift de zona)
  const parseLocalDate = (str) => {
    if (!str) return null;
    const [year, month, day] = str.split("-").map(Number);
    return new Date(year, month - 1, day);
  };

  let dateTo = parseLocalDate(q.date_to) || today;
  let dateFrom = parseLocalDate(q.date_from);

  if (!dateFrom) {
    dateFrom = new Date(dateTo);
    dateFrom.setDate(dateTo.getDate() - 13);
  }

  // 🔹 Forzar límites del día en horario local real
  dateFrom.setHours(0, 0, 0, 0);
  dateTo.setHours(23, 59, 59, 999);

  return { dateFrom, dateTo };
}



router.get("/productosagotados",allowRoles("Admin"), async (req, res) => {
  try {
    let { dateFrom: desde, dateTo: hasta } =  parseDateRange(req.query);
    let { limit } = req.query;
    limit = parseInt(limit) || 10; 

    // 🔥 VALIDACIÓN + DEFAULTS
    const hoy = new Date().toISOString().split("T")[0];

    if (!desde) desde = hoy;
    if (!hasta) hasta = desde;

    // 🔥 NORMALIZAR RANGO (hasta incluye todo el día)
    const hastaPlus = new Date(hasta);
    hastaPlus.setDate(hastaPlus.getDate() + 1);
    
    // 🔥 BASE QUERY OPTIMIZADA
    const baseQuery = mgmtDb("logs as l")
      .join("connections as c", function () {
        this.on(
          mgmtDb.raw('c."codLocal" = l."codLocal"::integer')
        );
      })
      .where("l.valorNuevo", false)
      .where("l.created_at", ">=", desde)
      .andWhere("l.created_at", "<", hastaPlus);

    // 🔥 TOP PRODUCTOS
    //
    // Se agrupa primero por nombre crudo en SQL (rápido), y recién
    // después se re-agrupa por nombre NORMALIZADO en JS — así "LATA
    // COCA-COLA CPR/PPM/SPP" quedan sumados en una sola fila antes de
    // aplicar el Top N, en vez de competir por separado por un lugar
    // en el ranking.
    const productosRaw = await baseQuery
      .clone()
      .select("l.nombre_articulo as producto")
      .count("* as cantidad")
      .groupBy("l.nombre_articulo");

    const productos = agruparPorProductoNormalizado(productosRaw).slice(0, limit);

    // 🔥 TOP LOCALES
    const locales = await baseQuery
      .clone()
      .select("c.name as local")
      .count("* as cantidad")
      .groupBy("c.name")
      .orderBy("cantidad", "desc")
      .limit(limit);

    // 🔥 DETALLE (LIMITADO para no romper frontend)
    const detalleRaw = await baseQuery
      .clone()
      .select(
        "l.nombre_articulo as producto",
        "c.name as local",
        "l.created_at as fecha"
      )
      .orderBy("l.created_at", "desc")
      .limit(500);

    const detalle = detalleRaw.map((row) => ({
      ...row,
      producto: normalizarProducto(row.producto)
    }));

    const diasRaw = await baseQuery
      .clone()
      .select(
        mgmtDb.raw(`
          EXTRACT(DOW FROM l.created_at) as orden,
          TRIM(TO_CHAR(l.created_at, 'Day')) as dia
        `)
      )
      .count("* as cantidad")
      .groupBy("orden", "dia")
      .orderBy("orden");

    // 🔥 DESGLOSE POR PRODUCTO (día de la semana y local), para la barra
    // apilada y su tooltip. Se usan como máximo los STACK_TOP_N productos más
    // agotados del período (ya normalizados) para el COLOR de la barra — tope
    // necesario para no romper la paleta categórica validada (con la cola
    // larga real de agotados, cubrir el 80% de los productos exigiría 60+
    // colores, indistinguibles a simple vista) — y el resto se suma en
    // "Otros". El tooltip, en cambio, lista cada producto normalizado uno por
    // uno, sin agrupar nada en "Otros", y siempre encabezado por el que más
    // se agotó.
    const STACK_TOP_N = 11;
    const topProductosStack = productos.slice(0, STACK_TOP_N).map((p) => p.producto);

    function armarDesglosePorGrupo(filasRaw) {
      const breakdownPorGrupo = {};
      const detalleMapaPorGrupo = {};
      // grupo -> nombreFinal -> Map(nombreBase -> cantidad) — solo se llena
      // para productos que pasaron por un GRUPO_MANUAL, así el frontend
      // puede mostrar "qué mix real hay adentro" al hacer clic en el grupo.
      const mixMapaPorGrupo = {};

      filasRaw.forEach((row) => {
        const grupo = row.grupo;
        const nombreBase = normalizarBase(row.producto);
        const nombre = agruparManual(nombreBase);
        const cantidad = Number(row.cantidad);
        const clave = topProductosStack.includes(nombre) ? nombre : "Otros";

        if (!breakdownPorGrupo[grupo]) breakdownPorGrupo[grupo] = {};
        breakdownPorGrupo[grupo][clave] = (breakdownPorGrupo[grupo][clave] || 0) + cantidad;

        if (!detalleMapaPorGrupo[grupo]) detalleMapaPorGrupo[grupo] = new Map();
        const mapa = detalleMapaPorGrupo[grupo];
        mapa.set(nombre, (mapa.get(nombre) || 0) + cantidad);

        if (nombre !== nombreBase) {
          if (!mixMapaPorGrupo[grupo]) mixMapaPorGrupo[grupo] = {};
          if (!mixMapaPorGrupo[grupo][nombre]) mixMapaPorGrupo[grupo][nombre] = new Map();
          const mixMapa = mixMapaPorGrupo[grupo][nombre];
          mixMapa.set(nombreBase, (mixMapa.get(nombreBase) || 0) + cantidad);
        }
      });

      const detallePorGrupo = {};
      Object.entries(detalleMapaPorGrupo).forEach(([grupo, mapa]) => {
        detallePorGrupo[grupo] = [...mapa.entries()]
          .map(([producto, cantidad]) => {
            const mixMapa = mixMapaPorGrupo[grupo]?.[producto];
            if (!mixMapa) return { producto, cantidad };

            const mix = [...mixMapa.entries()]
              .map(([sub, cant]) => ({ producto: sub, cantidad: cant }))
              .sort((a, b) => b.cantidad - a.cantidad);

            return { producto, cantidad, mix };
          })
          .sort((a, b) => b.cantidad - a.cantidad);
      });

      return { breakdownPorGrupo, detallePorGrupo };
    }

    // --- Por día de la semana ---
    const diasProductosRaw = (await baseQuery
      .clone()
      .select(
        mgmtDb.raw(`EXTRACT(DOW FROM l.created_at) as grupo`),
        "l.nombre_articulo as producto"
      )
      .count("* as cantidad")
      .groupBy("grupo", "l.nombre_articulo")
    ).map((row) => ({ ...row, grupo: Number(row.grupo) }));

    const topProductoPorDia = {};

    diasProductosRaw.forEach((row) => {
      const nombre = normalizarProducto(row.producto);
      const cantidad = Number(row.cantidad);

      if (!topProductoPorDia[row.grupo] || cantidad > topProductoPorDia[row.grupo].cantidad) {
        topProductoPorDia[row.grupo] = { producto: nombre, cantidad };
      }
    });

    const { breakdownPorGrupo: breakdownPorDia, detallePorGrupo: detalleCompletoPorDia } =
      armarDesglosePorGrupo(diasProductosRaw);

    const dias = diasRaw.map((row) => {
      const orden = Number(row.orden);
      const totalDia = Number(row.cantidad);
      const top = topProductoPorDia[orden];

      return {
        dia: DIAS_ES[row.dia] || row.dia,
        cantidad: totalDia,
        topProducto: top ? top.producto : null,
        topProductoPct: top && totalDia > 0
          ? Math.round((top.cantidad / totalDia) * 100)
          : null,
        productosDetalle: detalleCompletoPorDia[orden] || [],
        ...breakdownPorDia[orden]
      };
    });

    // --- Por local (solo para los locales del Top N de arriba) ---
    const nombresLocalesTop = locales.map((l) => l.local);

    const localesProductosRaw = nombresLocalesTop.length
      ? await baseQuery
          .clone()
          .whereIn("c.name", nombresLocalesTop)
          .select(
            "c.name as grupo",
            "l.nombre_articulo as producto"
          )
          .count("* as cantidad")
          .groupBy("grupo", "l.nombre_articulo")
      : [];

    const { breakdownPorGrupo: breakdownPorLocal, detallePorGrupo: detalleCompletoPorLocal } =
      armarDesglosePorGrupo(localesProductosRaw);

    const localesConDesglose = locales.map((row) => ({
      local: row.local,
      cantidad: Number(row.cantidad),
      productosDetalle: detalleCompletoPorLocal[row.local] || [],
      ...breakdownPorLocal[row.local]
    }));

    res.json({
      productos,
      locales: localesConDesglose,
      detalle,
      dias,
      productosStack: topProductosStack
    });

  } catch (error) {
    console.error("Error reporte agotados:", error);
    res.status(500).json({
      error: "Error generando reporte"
    });
  }
});

/**
 * 📊 GET /reports/incidence-by-day
 * Muestra agrupado por día y local, con los artículos OFF del período.
 */
router.get("/incidence-by-day", async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query);
    
    const results = await mgmtDb("logs as l")
    .select(
      mgmtDb.raw(`date_trunc('day', l."created_at") as fecha`),
      mgmtDb.raw(`l."codLocal"`),
      mgmtDb.raw(`c."name" as "localName"`),
      mgmtDb.raw(`string_agg(distinct l."articuloCodigo"::text, ', ') as articulos`),
      mgmtDb.raw(`count(distinct l."articuloCodigo") as total_articulos`)
    )
    .leftJoin(
      "connections as c",
      mgmtDb.raw('CAST(c."codLocal" AS TEXT)'),
      "=",
      mgmtDb.raw('l."codLocal"')
    )
    .whereBetween("l.created_at", [dateFrom, dateTo])
    .andWhere("l.valorNuevo", false)
    .groupByRaw(`1, 2, 3`)
    .orderByRaw(`1 asc, 2 asc`);


    res.json({ success: true, data: results });
  } catch (err) {
    console.error("GET /reports/incidence-by-day error:", err);
    res.status(500).json({ success: false, message: "Error generando reporte agrupado" });
  }
});

/**
 * 📤 GET /reports/export?type=by_grouped
 * Exporta el mismo reporte a Excel
 */
router.get("/export", async (req, res) => {

    const { dateFrom, dateTo } = parseDateRange(req.query);
   try {

    const logs = await mgmtDb("logs")
      .select(
        mgmtDb.raw("to_char(created_at, 'YYYY-MM-DD') as fecha"),
        "codLocal",
        "nombre_articulo"
      )
      .count("* as veces")
      .where({
        valorNuevo: false,
        requiereCorreccion: true
      })
      .whereBetween("created_at", [dateFrom, dateTo])
      .groupByRaw("to_char(created_at, 'YYYY-MM-DD'), \"codLocal\", \"nombre_articulo\"")
      .orderBy(["codLocal","fecha"]);

    const connections = await mgmtDb("connections")
      .select("codLocal","name");

    const mapLocales = {};
    connections.forEach(c=>{
      mapLocales[c.codLocal] = c.name;
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Artículos Agotados");

    // ancho columnas
    sheet.columns = [
      { header:"Local", key:"local", width:25 },
      { header:"Fecha", key:"fecha", width:15 },
      { header:"Artículo", key:"articulo", width:45 },
      { header:"Veces", key:"veces", width:10 }
    ];

    // título
    sheet.mergeCells("A1:D1");
    sheet.getCell("A1").value = "REPORTE DE ARTÍCULOS AGOTADOS";
    sheet.getCell("A1").font = { size:16, bold:true };
    sheet.getCell("A1").alignment = { horizontal:"center" };

    // rango fechas
    sheet.mergeCells("A2:D2");
    sheet.getCell("A2").value = `Rango de fechas: ${new Date(dateFrom).toLocaleDateString()} a ${new Date(dateTo).toLocaleDateString()}`;
    sheet.getCell("A2").alignment = { horizontal:"center" };

    sheet.addRow([]);

    // encabezados
    const header = sheet.addRow(["Local","Fecha","Artículo","Veces"]);

    header.font = { bold:true };
    header.alignment = { horizontal:"center" };

    header.eachCell(cell=>{
      cell.fill = {
        type:"pattern",
        pattern:"solid",
        fgColor:{ argb:"FFBDD7EE" }
      };

      cell.border = {
        top:{style:"thin"},
        bottom:{style:"thin"},
        left:{style:"thin"},
        right:{style:"thin"}
      };
    });

    // congelar encabezado
    sheet.views = [{ state:"frozen", ySplit:4 }];

    let currentLocal = null;

    logs.forEach(row=>{

      const local = mapLocales[row.codLocal] || row.codLocal;

      const fila = sheet.addRow({
        local: currentLocal === local ? "" : local,
        fecha: row.fecha,
        articulo: row.nombre_articulo.trim(),
        veces: row.veces
      });

      fila.getCell("fecha").numFmt = "yyyy-mm-dd";

      currentLocal = local;

    });

    // bordes tabla
    sheet.eachRow((row, rowNumber)=>{

      if(rowNumber < 5) return;

      row.eachCell(cell=>{
        cell.border = {
          top:{style:"thin"},
          bottom:{style:"thin"},
          left:{style:"thin"},
          right:{style:"thin"}
        };
      });

    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=articulos_agotados_${dateFrom}_${dateTo}.xlsx`
    );

    await workbook.xlsx.write(res);

    res.end();

  } catch(err){

    console.error(err);

    res.status(500).json({
      success:false,
      message:err.message
    });

  }
});

router.get("/agotados-resumen", async (req, res) => {
  
  const { dateFrom, dateTo } = parseDateRange(req.query);
    
  const { fechaInicio, fechaFin } = req.query;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({
      success: false,
      message: "Debe indicar fechaInicio y fechaFin"
    });
  }

  try {
    // 1️⃣ obtener resumen de logs
    const logs = await mgmtDb("logs")
      .select(mgmtDb.raw("to_char(created_at, 'YYYY-MM-DD') as fecha"), "codLocal", "articuloCodigo", "nombre_articulo")
      .count("* as veces")
      .where({
        valorNuevo: false,
        requiereCorreccion: true
      })
      .whereBetween("created_at", [dateFrom, dateTo])
      .groupByRaw("to_char(created_at, 'YYYY-MM-DD'), \"codLocal\",\"articuloCodigo\",\"nombre_articulo\"")
      .orderBy([
        { column: "fecha", order: "asc" },
        { column: "codLocal", order: "asc" }
      ]);

    // 2️⃣ obtener conexiones (nombre del local)
    const connections = await mgmtDb("connections")
      .select("codLocal", "name");

    const connMap = {};
    connections.forEach(c => {
      connMap[c.codLocal] = c.name;
    });

    // 3️⃣ agrupar por local
    const resultado = {};

    for (const row of logs) {
      const local = connMap[row.codLocal] || row.codLocal;
      if (!resultado[local]) {
        resultado[local] = [];
      }

      resultado[local].push({
        articuloCodigo: row.articuloCodigo,
        veces: row.veces,
        nombre_articulo: row.nombre_articulo,
        fecha: row.fecha
      });

    }

    res.json({
      success: true,
      data: resultado
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message
    });

  }

});


export default router;
