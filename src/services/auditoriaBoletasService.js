import sql from "mssql";
import { getCentralPool } from "../db/dbCentral.js";

/* =====================================================
   AUDITORÍA DE BOLETAS DE LAS MESAS 500-599

   Cada compra se asigna a un número de mesa. Se revisan, por boleta:
     - combo sin cobrar: la boleta trae combos con precio $0 y ningún combo con precio (monto
       referencial = cantidad x precio de lista del artículo). Si la boleta también cobra un combo,
       la cabecera en $0 es un registro auxiliar del POS y no se marca
     - boleta sin pagos
     - pagos que no suman el total
     - productos que no suman el total
   El pago en efectivo es válido en estas mesas: solo se informa (cantidad e importe), no es error.
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

const EXPRESION_CON_DIFERENCIAS =
  "(d.f_combo_cero + d.f_sin_pago + d.f_pago_distinto + d.f_productos_distinto)";

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
           SUM(CASE WHEN hf.precio = 0 THEN 1 ELSE 0 END) AS combos_cero,
           SUM(CASE WHEN hf.precio = 0
                    THEN CAST(hf.cantidad AS DECIMAL(18,2)) * CAST(a.precio AS DECIMAL(18,2))
                    ELSE 0 END) AS monto_referencial,
           SUM(CASE WHEN hf.precio > 0 THEN 1 ELSE 0 END) AS combos_cobrados
    INTO #c
    FROM #b b ${loop} histfact hf ${hintHistfact} ON hf.idemitidos = b.idk
    INNER JOIN articulo a ON a.codigo = hf.codigo
    WHERE a.combo = 1
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
           CASE WHEN b.anulado = 0 AND ISNULL(c.combos_cero, 0) > 0
                 AND ISNULL(c.combos_cobrados, 0) = 0 THEN 1 ELSE 0 END AS f_combo_cero,
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
  ORDER BY SUM(CASE WHEN ${EXPRESION_CON_DIFERENCIAS} > 0 THEN 1 ELSE 0 END) DESC,
           SUM(CASE WHEN d.f_combo_cero = 1 THEN d.monto_referencial ELSE 0 END) DESC,
           d.local;
`;

const BOLETAS_CON_DIFERENCIAS = `
  SELECT TOP (${MAX_BOLETAS_DETALLE + 1})
         d.idk, d.local AS codigo_local, CONVERT(CHAR(10), d.fecha, 23) AS fecha,
         RTRIM(d.hora) AS hora, RTRIM(d.numero) AS numero,
         d.mesa, d.total, d.combos_cero, d.monto_referencial, d.total_histfact, d.total_formpago,
         d.registros_pago,
         d.f_combo_cero, d.f_sin_pago, d.f_pago_distinto, d.f_productos_distinto
  FROM #d d
  WHERE ${EXPRESION_CON_DIFERENCIAS} > 0
  ORDER BY d.fecha, d.hora;
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
