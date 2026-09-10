import cron from "node-cron";
import mgmtDb from "../db/adminDb.js";
import sql from "mssql";
import { makeMssqlConfig } from "../db/connections.js";

let ejecutando = false;

function dividirEnLotes(items, cantidad = 500) {
  const lotes = [];

  for (let i = 0; i < items.length; i += cantidad) {
    lotes.push(items.slice(i, i + cantidad));
  }

  return lotes;
}

async function actualizarArticulosLocal(pool, articulos) {
  const codigosUnicos = [
    ...new Set(
      articulos
        .map(item => String(item.articuloCodigo).trim())
        .filter(Boolean)
    )
  ];

  if (!codigosUnicos.length) {
    return [];
  }

  const codigosActualizados = [];
  const lotes = dividirEnLotes(codigosUnicos, 500);

  for (const lote of lotes) {
    const request = pool.request();

    const parametros = lote.map((codigo, index) => {
      const nombre = `codigo${index}`;

      request.input(
        nombre,
        sql.VarChar(100),
        codigo
      );

      return `@${nombre}`;
    });

    const resultado = await request.query(`
      DECLARE @Actualizados TABLE (Codigo VARCHAR(100));

      UPDATE articulo
      SET Web = 1
      OUTPUT INSERTED.Codigo INTO @Actualizados
      WHERE Codigo IN (${parametros.join(",")})
        AND grupo11 > 0;

      SELECT Codigo FROM @Actualizados;
    `);

    for (const row of resultado.recordset || []) {
      codigosActualizados.push(
        String(row.Codigo).trim()
      );
    }
  }

  return [...new Set(codigosActualizados)];
}

async function runFixOfflineUpdates() {
  if (ejecutando) {
    console.log(
      "[CRON REPARACIÓN] Ejecución omitida: proceso anterior aún activo."
    );
    return;
  }

  ejecutando = true;
  const inicio = Date.now();

  try {
    const pendientes = await mgmtDb("logs")
      .where("requiereCorreccion", true)
      .andWhere("corregido", false)
      .select(
        "id",
        "codLocal",
        "articuloCodigo"
      );

    if (!pendientes.length) {
      console.log(
        "[CRON REPARACIÓN] Sin artículos pendientes."
      );
      return;
    }

    const pendientesPorLocal = new Map();

    for (const item of pendientes) {
      const key = String(item.codLocal);

      if (!pendientesPorLocal.has(key)) {
        pendientesPorLocal.set(key, []);
      }

      pendientesPorLocal
        .get(key)
        .push(item);
    }

    const conexiones = await mgmtDb("connections")
      .where("activo", true)
      .select(
        "id",
        "codLocal",
        "name",
        "host"
      );

    let localesProcesados = 0;
    let articulosCorregidos = 0;

    for (const conn of conexiones) {
      const articulos = pendientesPorLocal.get(
        String(conn.codLocal)
      );

      if (!articulos?.length) {
        continue;
      }

      let pool;

      try {
        const config = makeMssqlConfig(
          conn.host
        );

        pool = new sql.ConnectionPool(config);

        await pool.connect();

        const codigosActualizados =
          await actualizarArticulosLocal(
            pool,
            articulos
          );

        if (!codigosActualizados.length) {
          continue;
        }

        const codigosSet = new Set(
          codigosActualizados.map(
            codigo => String(codigo)
          )
        );

        const articulosCorregidosLocal =
          articulos.filter(item =>
            codigosSet.has(
              String(
                item.articuloCodigo
              ).trim()
            )
          );

        if (!articulosCorregidosLocal.length) {
          continue;
        }

        const idsCorregidos =
          articulosCorregidosLocal.map(
            item => item.id
          );

        const nuevosLogs =
          articulosCorregidosLocal.map(
            item => ({
              username: "SYSTEM",
              codLocal: conn.codLocal,
              articuloCodigo:
                item.articuloCodigo,
              campo: "Web",
              valorNuevo: true,
              requiereCorreccion: false,
              corregido: true
            })
          );

        await mgmtDb.transaction(
          async trx => {
            await trx("logs")
              .insert(nuevosLogs);

            await trx("logs")
              .whereIn(
                "id",
                idsCorregidos
              )
              .update({
                corregido: true
              });
          }
        );

        localesProcesados++;

        articulosCorregidos +=
          articulosCorregidosLocal.length;

      } catch (error) {
        console.error(
          `[CRON REPARACIÓN] Error local ${conn.codLocal} - ${conn.name}: ${error.message}`
        );
      } finally {
        if (pool) {
          await pool.close();
        }
      }
    }

    console.log(
      `[CRON REPARACIÓN] Locales procesados: ${localesProcesados} - Artículos corregidos: ${articulosCorregidos}`
    );

  } catch (error) {
    console.error(
      `[CRON REPARACIÓN] Error general: ${error.message}`
    );

  } finally {
    const segundos = (
      (Date.now() - inicio) / 1000
    ).toFixed(1);

    console.log(
      `[CRON REPARACIÓN] Finalizado en ${segundos}s`
    );

    ejecutando = false;
  }
}

cron.schedule(
  "0 10 * * *",
  runFixOfflineUpdates,
  {
    timezone: "America/Santiago"
  }
);

if (
  process.env.RUN_FIX_NOW === "true"
) {
  runFixOfflineUpdates();
}

export default runFixOfflineUpdates;