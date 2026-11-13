import sql from "mssql";
import mgmtDb from "../db/adminDb.js";
import { getCentralPool } from "../db/dbCentral.js";

/* =====================================================
   AUDITORÍA DE BOLETAS DE LAS MESAS 500-599

   Cada compra se asigna a un número de mesa; estas mesas no deberían tener cobros en efectivo,
   propina, vuelto ni descuentos. Se revisan, por boleta:
     - combo con precio $0 (monto referencial = cantidad x precio de lista del artículo)
     - boleta sin pagos
     - pagos que no suman el total
     - productos que no suman el total
     - pago en efectivo (error: se notifica)
   Las boletas anuladas no se revisan; solo se cuentan.
===================================================== */

export const MESA_DESDE = 500;
export const MESA_HASTA = 599;

// Medio de pago EFECTIVO en med_pago
export const CODIGO_EFECTIVO = 1;

// Cada día de la cadena son ~7.000 boletas (~3 s); se limita el rango para no cargar la central
export const MAX_DIAS = 7;

// Tope de boletas devueltas en el detalle
const MAX_BOLETAS_DETALLE = 5000;

const TITULO_EFECTIVO = "Efectivo en mesas 500-599";

const EXPRESION_CON_DIFERENCIAS =
  "(d.f_combo_cero + d.f_sin_pago + d.f_pago_distinto + d.f_productos_distinto + d.f_efectivo)";

/**
 * Prepara en tablas temporales (#b boletas, #h productos, #c combos, #p pagos y #d diagnóstico)
 * los datos del rango. En la central `emitidos` y `histfact` son enormes: el motor elige recorrer
 * toda la tabla (más de 50 s) si no se le fuerza el índice; con el índice y el loop join un día
 * tarda ~3 s. Lo mismo ocurre con `formpago` (41 s sin forzar, 0,3 s forzando). `histfact` y
 * `formpago` tienen el índice IDEMITIDOS. Si algún índice no existe (error 308) se repite sin
 * forzarlos.
 */
function preparacion(conHints) {
  const hintEmitidos = conHints ? "WITH (INDEX(FECHA))" : "";
  const hintHistfact = conHints ? "WITH (INDEX(IDEMITIDOS))" : ""; // también para formpago
  const loop = conHints ? "INNER LOOP JOIN" : "INNER JOIN";

  return `
    SET NOCOUNT ON;

    DECLARE @d DATETIME = CAST(@desde AS DATETIME),
            @h DATETIME = DATEADD(DAY, 1, CAST(@hasta AS DATETIME));

    SELECT e.idk, e.local, e.fecha, e.hora, e.numero, e.mesa, e.total, e.anulado
    INTO #b
    FROM emitidos e ${hintEmitidos}
    WHERE e.fecha >= @d AND e.fecha < @h
      AND e.mesa BETWEEN @mesaDesde AND @mesaHasta;

    CREATE CLUSTERED INDEX ix_b ON #b (idk);

    SELECT hf.idemitidos AS idk,
           SUM(CAST(hf.cantidad AS DECIMAL(18,2)) * CAST(hf.precio AS DECIMAL(18,2))) AS total_histfact
    INTO #h
    FROM #b b ${loop} histfact hf ${hintHistfact} ON hf.idemitidos = b.idk
    GROUP BY hf.idemitidos;

    SELECT hf.idemitidos AS idk,
           COUNT(*) AS combos_cero,
           SUM(CAST(hf.cantidad AS DECIMAL(18,2)) * CAST(a.precio AS DECIMAL(18,2))) AS monto_referencial
    INTO #c
    FROM #b b ${loop} histfact hf ${hintHistfact} ON hf.idemitidos = b.idk
    INNER JOIN articulo a ON a.codigo = hf.codigo
    WHERE a.combo = 1 AND hf.precio = 0
    GROUP BY hf.idemitidos;

    SELECT fp.idemitidos AS idk,
           COUNT(*) AS registros_pago,
           SUM(CAST(fp.fp_importe AS DECIMAL(18,2))) AS total_formpago,
           SUM(CASE WHEN fp.fp_codpago = @codEfectivo THEN 1 ELSE 0 END) AS pagos_efectivo,
           SUM(CASE WHEN fp.fp_codpago = @codEfectivo THEN CAST(fp.fp_importe AS DECIMAL(18,2)) ELSE 0 END) AS importe_efectivo
    INTO #p
    FROM #b b ${loop} formpago fp ${hintHistfact} ON fp.idemitidos = b.idk
    GROUP BY fp.idemitidos;

    SELECT b.idk, b.local, b.fecha, b.hora, b.numero, b.mesa, b.total, b.anulado,
           ISNULL(c.combos_cero, 0)       AS combos_cero,
           ISNULL(c.monto_referencial, 0) AS monto_referencial,
           ISNULL(h.total_histfact, 0)    AS total_histfact,
           ISNULL(p.total_formpago, 0)    AS total_formpago,
           ISNULL(p.registros_pago, 0)    AS registros_pago,
           ISNULL(p.importe_efectivo, 0)  AS importe_efectivo,
           CASE WHEN b.anulado = 0 AND ISNULL(c.combos_cero, 0) > 0 THEN 1 ELSE 0 END AS f_combo_cero,
           CASE WHEN b.anulado = 0 AND ISNULL(p.registros_pago, 0) = 0 THEN 1 ELSE 0 END AS f_sin_pago,
           CASE WHEN b.anulado = 0 AND ISNULL(p.registros_pago, 0) > 0
                 AND ABS(p.total_formpago - b.total) > 0.01 THEN 1 ELSE 0 END AS f_pago_distinto,
           CASE WHEN b.anulado = 0 AND ABS(ISNULL(h.total_histfact, 0) - b.total) > 0.01 THEN 1 ELSE 0 END AS f_productos_distinto,
           CASE WHEN b.anulado = 0 AND ISNULL(p.pagos_efectivo, 0) > 0 THEN 1 ELSE 0 END AS f_efectivo
    INTO #d
    FROM #b b
    LEFT JOIN #c c ON c.idk = b.idk
    LEFT JOIN #h h ON h.idk = b.idk
    LEFT JOIN #p p ON p.idk = b.idk;
  `;
}

const RESUMEN_POR_LOCAL = `
  SELECT d.local AS codigo_local,
         RTRIM(l.nom_local) AS nombre_local,
         SUM(CASE WHEN d.anulado = 0 THEN 1 ELSE 0 END) AS boletas_revisadas,
         SUM(CAST(d.anulado AS INT)) AS boletas_anuladas,
         SUM(CASE WHEN ${EXPRESION_CON_DIFERENCIAS} > 0 THEN 1 ELSE 0 END) AS boletas_con_diferencias,
         SUM(d.f_combo_cero) AS boletas_combo_cero,
         SUM(CASE WHEN d.f_combo_cero = 1 THEN d.combos_cero ELSE 0 END) AS combos_cero,
         SUM(CASE WHEN d.f_combo_cero = 1 THEN d.monto_referencial ELSE 0 END) AS monto_referencial,
         SUM(d.f_sin_pago) AS boletas_sin_pago,
         SUM(d.f_pago_distinto) AS boletas_pago_distinto,
         SUM(d.f_productos_distinto) AS boletas_productos_distinto,
         SUM(d.f_efectivo) AS boletas_efectivo,
         SUM(CASE WHEN d.f_efectivo = 1 THEN d.importe_efectivo ELSE 0 END) AS importe_efectivo
  FROM #d d
  LEFT JOIN locales l ON l.num_local = d.local
  GROUP BY d.local, RTRIM(l.nom_local)
  ORDER BY SUM(d.f_efectivo) DESC,
           SUM(CASE WHEN d.f_combo_cero = 1 THEN d.monto_referencial ELSE 0 END) DESC,
           SUM(CASE WHEN ${EXPRESION_CON_DIFERENCIAS} > 0 THEN 1 ELSE 0 END) DESC,
           d.local;
`;

const BOLETAS_CON_DIFERENCIAS = `
  SELECT TOP (${MAX_BOLETAS_DETALLE + 1})
         d.idk, d.local AS codigo_local, CONVERT(CHAR(10), d.fecha, 23) AS fecha,
         RTRIM(d.hora) AS hora, RTRIM(d.numero) AS numero,
         d.mesa, d.total, d.combos_cero, d.monto_referencial, d.total_histfact, d.total_formpago,
         d.registros_pago, d.importe_efectivo,
         d.f_combo_cero, d.f_sin_pago, d.f_pago_distinto, d.f_productos_distinto, d.f_efectivo
  FROM #d d
  WHERE ${EXPRESION_CON_DIFERENCIAS} > 0
  ORDER BY d.f_efectivo DESC, d.fecha, d.hora;
`;

function parametros(request, desde, hasta) {
  return request
    .input("desde", sql.Date, desde)
    .input("hasta", sql.Date, hasta)
    .input("mesaDesde", sql.Int, MESA_DESDE)
    .input("mesaHasta", sql.Int, MESA_HASTA)
    .input("codEfectivo", sql.Int, CODIGO_EFECTIVO);
}

const esIndiceInexistente = (err) =>
  err.number === 308 || err.originalError?.info?.number === 308;

async function ejecutar(pool, desde, hasta, consultaFinal) {
  try {
    return await parametros(pool.request(), desde, hasta).query(preparacion(true) + consultaFinal);
  } catch (err) {
    if (!esIndiceInexistente(err)) {
      throw err;
    }

    console.warn("⚠️ Índice no disponible en la central para la auditoría de boletas; se consulta sin forzarlo");
    return parametros(pool.request(), desde, hasta).query(preparacion(false) + consultaFinal);
  }
}

/**
 * Resumen por local y detalle de las boletas con diferencias del rango (fechas YYYY-MM-DD,
 * `hasta` incluido).
 */
export async function auditarBoletas(desde, hasta, pool = null) {
  const central = pool || (await getCentralPool());

  const resultado = await ejecutar(central, desde, hasta, RESUMEN_POR_LOCAL + BOLETAS_CON_DIFERENCIAS);

  const [locales, boletas] = resultado.recordsets;

  const truncado = boletas.length > MAX_BOLETAS_DETALLE;

  return {
    locales,
    boletas: truncado ? boletas.slice(0, MAX_BOLETAS_DETALLE) : boletas,
    boletas_truncadas: truncado
  };
}

/* =====================================================
   AVISO DE EFECTIVO EN LAS MESAS 500-599
===================================================== */

const fechaSantiago = (fecha = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santiago" }).format(fecha);

// YYYY-MM-DD del día anterior (hora de Santiago)
export function ayerSantiago(ahora = new Date()) {
  const [a, m, d] = fechaSantiago(ahora).split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d - 1)).toISOString().slice(0, 10);
}

const MAX_LOCALES_EN_AVISO = 8;

/**
 * Revisa el día anterior (o `fecha`) y, si hubo boletas con pago en efectivo en las mesas 500-599,
 * avisa por la campana a cada Admin. No repite el mismo aviso el mismo día.
 * `central` se puede reemplazar (pruebas); por defecto es la base central.
 */
export async function notificarEfectivoEnMesas({ db = mgmtDb, central = null, fecha = null } = {}) {
  const dia = fecha || ayerSantiago();
  const hoy = fechaSantiago();
  const pool = central || (await getCentralPool());

  const consulta = (hint) => `
    SELECT e.local AS codigo_local, RTRIM(l.nom_local) AS nombre_local,
           COUNT(DISTINCT e.idk) AS boletas,
           SUM(CAST(fp.fp_importe AS DECIMAL(18,2))) AS importe
    FROM emitidos e ${hint}
    INNER JOIN formpago fp ON fp.idemitidos = e.idk
    LEFT JOIN locales l ON l.num_local = e.local
    WHERE e.fecha >= CAST(@dia AS DATETIME) AND e.fecha < DATEADD(DAY, 1, CAST(@dia AS DATETIME))
      AND e.mesa BETWEEN @mesaDesde AND @mesaHasta
      AND e.anulado = 0
      AND fp.fp_codpago = @codEfectivo
    GROUP BY e.local, RTRIM(l.nom_local)
    ORDER BY COUNT(DISTINCT e.idk) DESC, e.local
  `;

  const pedir = (hint) =>
    pool
      .request()
      .input("dia", sql.Date, dia)
      .input("mesaDesde", sql.Int, MESA_DESDE)
      .input("mesaHasta", sql.Int, MESA_HASTA)
      .input("codEfectivo", sql.Int, CODIGO_EFECTIVO)
      .query(consulta(hint));

  let filas;

  try {
    filas = (await pedir("WITH (INDEX(FECHA))")).recordset;
  } catch (err) {
    if (!esIndiceInexistente(err)) {
      throw err;
    }

    filas = (await pedir("")).recordset;
  }

  if (!filas.length) {
    return { fecha: dia, locales: 0, boletas: 0, notificaciones: 0 };
  }

  const totalBoletas = filas.reduce((suma, f) => suma + Number(f.boletas), 0);

  const detalle = filas
    .slice(0, MAX_LOCALES_EN_AVISO)
    .map((f) => `${f.codigo_local}${f.nombre_local ? ` ${f.nombre_local}` : ""} (${f.boletas})`)
    .join(", ");

  const resto = filas.length > MAX_LOCALES_EN_AVISO ? ` y ${filas.length - MAX_LOCALES_EN_AVISO} local(es) más` : "";

  const contenido =
    `El ${dia} hubo ${totalBoletas} boleta(s) con pago en efectivo en las mesas ` +
    `${MESA_DESDE}-${MESA_HASTA}: ${detalle}${resto}.`;

  const admins = await db("users").where({ role: "Admin" }).select("id");

  let creadas = 0;

  for (const admin of admins) {
    const yaAvisado = await db("notificaciones")
      .where({ usuario_id: admin.id, titulo: TITULO_EFECTIVO })
      .where("contenido", "like", `El ${dia} %`)
      .whereRaw("(created_at AT TIME ZONE 'America/Santiago')::date = ?::date", [hoy])
      .first();

    if (yaAvisado) {
      continue;
    }

    await db("notificaciones").insert({
      titulo: TITULO_EFECTIVO,
      contenido,
      leido: false,
      url: "auditoria-boletas",
      usuario_id: admin.id,
      created_at: new Date()
    });

    creadas++;
  }

  return { fecha: dia, locales: filas.length, boletas: totalBoletas, notificaciones: creadas };
}
