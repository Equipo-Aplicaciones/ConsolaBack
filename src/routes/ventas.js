// routes/ventas.js
import express from "express";
import mgmtDb from "../db/adminDb.js";
import  {getCentralPool,getSqlServerPool }  from "../db/dbCentral.js";
import sql from "mssql";
import { allowRoles } from "../middleware/roleMiddleware.js";
import { requireAuth } from "../middleware/auth.js";
import { makeMssqlConfig } from "../db/connections.js";


const router = express.Router();

function obtenerDiaSemana() {
  // JS: domingo=0 ... sábado=6
  // Nosotros: lunes=1 ... domingo=7

  const dia = new Date().getDay();

  return dia === 0 ? 7 : dia;
}

router.use(requireAuth);

router.get("/ventas-diarias", allowRoles("Admin","N2","Zonal","Comercial"), async (req, res) => {

  try {

    const user = req.user; // viene del middleware de autenticación

    /* 1️⃣ OBTENER LOCALES */

    let connectionsQuery = mgmtDb("connections")
      .select("name", "host", "codLocal").where("empresa_id",2).andWhere("activo",true);

    // Si es zonal filtrar por su usuario
    if (user.role === "Zonal") {
      connectionsQuery = connectionsQuery.where("zonal", user.id);
    }

    const connections = await connectionsQuery;

    /* 2️⃣ CONSULTA CENTRAL (UNA SOLA VEZ) */

    const poolCentral = await getCentralPool();
    const centralResult = await poolCentral
      .request()
      .query(`
        SELECT 
          Local,
          COUNT(*) AS cantidad,
          ISNULL(SUM(total), 0) AS total
        FROM emitidos
        WHERE anulado = 0
          AND CAST(fecha AS DATE) = CAST(GETDATE() AS DATE)
        GROUP BY Local
      `);

    const centralMap = new Map();

    centralResult.recordset.forEach(r => {
      centralMap.set(r.Local, {
        cantidad: r.cantidad,
        total: r.total
      });
    });

    const resultado = [];

    /* 3️⃣ ITERAR POR CADA LOCAL*/

    for (const c of connections) {
      let localTotal = 0;
      let localCantidad = 0;
      const config = makeMssqlConfig(c.host);
      try {
        const localPool = await sql.connect(config);
        const r = await localPool
          .request()
          .query(`
            SELECT 
              COUNT(*) AS cantidad,
              ISNULL(SUM(total), 0) AS total
            FROM emitidos
            WHERE anulado = 0
              AND CAST(fecha AS DATE) = CAST(GETDATE() AS DATE)
          `);

        localCantidad = r.recordset[0].cantidad;
        localTotal = r.recordset[0].total;
        await localPool.close();
      } catch (err) {
        console.error(`❌ Error local ${c.codLocal}:`, err.message);

      }

      /* 4️⃣ OBTENER DATA CENTRAL */

      const centralData = centralMap.get(c.codLocal) || {
        cantidad: 0,
        total: 0
      };

      resultado.push({
        codLocal: c.codLocal,
        name: c.name,
        local: {
          cantidad: localCantidad,
          total: localTotal,
        },
        central: centralData,
        diferencia: {
          cantidad: localCantidad - centralData.cantidad,
          total: localTotal - centralData.total,
        },
      });
    }

    res.json(resultado);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      message: "Error conciliando ventas"
    });

  }

});

router.get( "/estado-horario", allowRoles("Admin", "N2"), async (req, res) => {
    try {

      /* =====================================================
         EMPRESA
      ===================================================== */

      const empresaSeleccionada = Number( req.query.empresa_id || 1 );
      const mapaEmpresas = {
        1: {
          sqlServer: "QA",
          empresaInternaId: 2
        },

        3: {
          sqlServer: "EMPRESA2",
          empresaInternaId: 3
        }
      };

      const empresaConfig = mapaEmpresas[empresaSeleccionada];

      if (!empresaConfig) {
        return res.status(400).json({
          message: "Empresa no válida"
        });
      }

      const { sqlServer, empresaInternaId } = empresaConfig;


      /* =====================================================
         NORMALIZAR CODLOCAL
      ===================================================== */

      const normalizarCodLocal = (valor) => {
        if ( valor === null || valor === undefined ) {
          return null;
        }

        const numero = Number(
          String(valor).trim()
        );

        return Number.isFinite(numero)
          ? numero
          : null;
      };


      /* =====================================================
         CONNECTIONS ACTUALES
      ===================================================== */

      const conexiones = await mgmtDb("connections")
        .where("empresa_id",empresaInternaId)
        .select("id", "codLocal", "name", "activo");


      /* =====================================================
         MAPA CONNECTIONS
      ===================================================== */

      const mapaConexiones = new Map();

      conexiones.forEach(connection => {
        const codigo =
          normalizarCodLocal(
            connection.codLocal
          );

        if (codigo !== null) {
          mapaConexiones.set(
            codigo,
            connection
          );
        }
      });


      /* =====================================================
         SQL SERVER
      ===================================================== */

      const pool = await getSqlServerPool( sqlServer );


      /* =====================================================
         CONSULTA CENTRAL
         
         Solo consideramos locales con actividad
         dentro de los últimos 30 días.
      ===================================================== */

      const result = await pool.request().query(`
        SELECT
          e.Local AS codLocal,
          l.Nom_local AS nombreLocal,

          CONVERT(
            varchar(19),
            MAX(
              DATEADD(
                SECOND,
                DATEDIFF(
                  SECOND,
                  '00:00:00',
                  e.hora
                ),
                CAST(e.fecha AS DATETIME)
              )
            ),
            120
          ) AS ultimaFecha,

          DATEDIFF(
            MINUTE,
            MAX(
              DATEADD(
                SECOND,
                DATEDIFF(
                  SECOND,
                  '00:00:00',
                  e.hora
                ),
                CAST(e.fecha AS DATETIME)
              )
            ),
            GETDATE()
          ) AS minutos,

          CASE
            WHEN MAX(e.fecha) < CAST(GETDATE() AS DATE)
              THEN 'Sin ventas hoy'

            WHEN DATEDIFF(
              MINUTE,
              MAX(
                DATEADD(
                  SECOND,
                  DATEDIFF(
                    SECOND,
                    '00:00:00',
                    e.hora
                  ),
                  CAST(e.fecha AS DATETIME)
                )
              ),
              GETDATE()
            ) <= 10
              THEN 'En horario'

            WHEN DATEDIFF(
              MINUTE,
              MAX(
                DATEADD(
                  SECOND,
                  DATEDIFF(
                    SECOND,
                    '00:00:00',
                    e.hora
                  ),
                  CAST(e.fecha AS DATETIME)
                )
              ),
              GETDATE()
            ) BETWEEN 11 AND 59
              THEN 'Demora leve'
            ELSE 'Critica'
          END AS estado

        FROM emitidos e
        LEFT JOIN locales l ON e.Local = l.Num_local
        WHERE e.anulado = 0
        GROUP BY e.Local, l.Nom_local
        HAVING
          MAX(e.fecha) >= DATEADD(
            DAY,
            -30,
            CAST(GETDATE() AS DATE)
          )

        ORDER BY
          e.Local;
      `);


      let data = result.recordset || [];


      /* =====================================================
         SOLO LOCALES QUE EXISTEN EN CONNECTIONS
      =====================================================
         
         connections define cuáles locales forman parte
         actualmente de la empresa.
      ===================================================== */

      data = data
        .filter(item => {
          const codigo =
            normalizarCodLocal(
              item.codLocal
            );

          return mapaConexiones.has( codigo );
        })
        .map(item => {
          const codigo = normalizarCodLocal( item.codLocal );
          const connection = mapaConexiones.get( codigo );

          return {
            ...item,
            codLocal: codigo,
            connection_id: connection.id,
            nombreLocal: connection.name || item.nombreLocal,
            activo: connection.activo
          };
        });


      /* =====================================================
         LOCALES INACTIVOS = CERRADO
      ===================================================== */

      data = data.map(local => {
        if (local.activo === false) {
          return {
            ...local,
            estado: "Cerrado",
            minutos: null
          };
        }

        return local;
      });


      /* =====================================================
         AGREGAR CONNECTIONS QUE NO APARECIERON
         EN LOS ÚLTIMOS 30 DÍAS
      =====================================================
         
         activo   → Sin ventas hoy
         inactivo → Cerrado
      ===================================================== */

      const codigosData =
        new Set(
          data.map(local =>
            normalizarCodLocal(
              local.codLocal
            )
          )
        );


      conexiones.forEach(connection => {
        const codigo = normalizarCodLocal(connection.codLocal );

        if ( codigo === null || codigosData.has(codigo)) {
          return;
        }

        data.push({
          codLocal: codigo,
          nombreLocal: connection.name,
          connection_id: connection.id,
          ultimaFecha: null,
          minutos: null,
          activo: connection.activo,
          estado:
            connection.activo
              ? "Sin ventas hoy"
              : "Cerrado"
        });
      });


      /* =====================================================
         VALIDAR HORARIOS CERRADOS
      ===================================================== */

      const diaSemana =
        obtenerDiaSemana();


      const conexionesSinVentas =
        data
          .filter(local =>
            local.estado === "Sin ventas hoy" &&
            local.activo === true &&
            local.connection_id !== null )
          .map(local => Number(local.connection_id))
          .filter(Number.isFinite);


      if ( conexionesSinVentas.length > 0 ) {
        const horarios = await mgmtDb("local_horarios_base")
            .select("connection_id")
            .where({dia_semana:diaSemana, activo: true, cerrado: true })
            .whereIn("connection_id",conexionesSinVentas);


        const conexionesCerradas =
          new Set(
            horarios.map(
              horario =>
                Number( horario.connection_id )
            )
          );


        data = data.map(local => {
          if (
            local.estado === "Sin ventas hoy" &&
            conexionesCerradas.has(
              Number(
                local.connection_id
              )
            )
          ) {
            return {
              ...local,
              estado: "Cerrado",
              minutos: null
            };
          }

          return local;
        });
      }


      /* =====================================================
         ORDEN POR PRIORIDAD
      ===================================================== */

      const prioridad = {
        "Sin ventas hoy": 1,
        "Critica": 2,
        "Demora leve": 3,
        "En horario": 4,
        "Cerrado": 5
      };


      data.sort((a, b) => {
        const prioridadA =
          prioridad[a.estado] ?? 99;

        const prioridadB =
          prioridad[b.estado] ?? 99;

        if (
          prioridadA !== prioridadB
        ) {
          return (
            prioridadA -
            prioridadB
          );
        }

        return (
          Number(a.codLocal) -
          Number(b.codLocal)
        );
      });


      /* =====================================================
         RESPUESTA
         
         Mantener array directo porque el front
         UltimaVentaLocal espera:
         
         const d = await r.json();
         d.sort(...)
      ===================================================== */

      return res.json(data);

    } catch (err) {
        console.error(
          "Error consultando estado horario:",
          err.message
        );

        if (
          err.code === "ESOCKET" ||
          err.code === "ETIMEOUT" ||
          err.code === "ECONNCLOSED"
        ) {
          return res.status(503).json({
            message: "No fue posible conectar con el servidor central de la empresa."
          });
        }

        return res.status(500).json({
          message: "Error consultando horarios"
        });
      }
  }
);

router.get("/estado-horario/resumen",  async (req, res) => {
  try {
    const pool = await getCentralPool();

    const result = await pool.request().query(`
      SELECT estado, COUNT(*) AS cantidad
      FROM (
        SELECT
          CASE
            WHEN MAX(e.fecha) < CAST(GETDATE() AS DATE)
              THEN 'Sin ventas hoy'
            WHEN DATEDIFF(
              MINUTE,
              MAX(
                DATEADD(SECOND,
                  DATEDIFF(SECOND,'00:00:00',e.hora),
                  CAST(e.fecha AS DATETIME)
                )
              ),
              GETDATE()
            ) <= 10
              THEN 'En horario'
            WHEN DATEDIFF(
              MINUTE,
              MAX(
                DATEADD(SECOND,
                  DATEDIFF(SECOND,'00:00:00',e.hora),
                  CAST(e.fecha AS DATETIME)
                )
              ),
              GETDATE()
            ) BETWEEN 11 AND 59
              THEN 'Demora leve'
            ELSE 'Critica'
          END AS estado
        FROM emitidos e
        LEFT JOIN locales l ON e.Local = l.Num_local
        WHERE e.anulado = 0
        GROUP BY e.Local, l.Nom_local
      ) AS sub
      GROUP BY estado
      ORDER BY estado;
    `);

    res.json(result.recordset);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Error generando resumen de estados"
    });
  }
});


export default router;