import mgmtDb from "../db/adminDb.js";
import ping from "ping";

/**
 * =====================================================
 * CONFIGURACIÓN
 * =====================================================
 */

const TOTEM_START_OCTET = 131;
const PING_TIMEOUT = 2;


/**
 * =====================================================
 * FECHA ACTUAL
 * =====================================================
 */

function obtenerFechaActual() {

  const ahora = new Date();

  const year = ahora.getFullYear();
  const month = String(ahora.getMonth() + 1).padStart(2, "0");
  const day = String(ahora.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}


/**
 * =====================================================
 * CONSTRUIR IP DEL TÓTEM
 * =====================================================
 *
 * Ejemplo:
 *
 * host: 10.10.15
 *
 * Totem 1 -> 10.10.15.131
 * Totem 2 -> 10.10.15.132
 * Totem 3 -> 10.10.15.133
 *
 * También acepta:
 *
 * host: 10.10.15.13
 *
 * y utiliza solamente los primeros 3 octetos.
 */

function construirIpTotem(host, numeroTotem) {

  if (!host) {
    return null;
  }

  const partes = String(host)
    .trim()
    .split(".")
    .filter(Boolean);

  if (partes.length < 3) {
    return null;
  }

  const ipBase = partes
    .slice(0, 3)
    .join(".");

  const ultimoOcteto =
    TOTEM_START_OCTET + (numeroTotem - 1);

  return `${ipBase}.${ultimoOcteto}`;
}


/**
 * =====================================================
 * PING
 * =====================================================
 */

async function comprobarPing(ip) {

  if (!ip) {
    return false;
  }

  try {

    const resultado = await ping.promise.probe(
      ip,
      {
        timeout: PING_TIMEOUT,
        min_reply: 1
      }
    );

    return resultado.alive === true;

  } catch (error) {

    console.error(
      `[TOTEMS] Error haciendo ping a ${ip}:`,
      error.message
    );

    return false;
  }
}


/**
 * =====================================================
 * CANTIDAD DE TÓTEMS
 * =====================================================
 *
 * ck = cantidad de tótems configurados.
 */

function obtenerCantidadTotems(connection) {

  const cantidad = Number(connection.ck);

  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    return 0;
  }

  return Math.floor(cantidad);
}


/**
 * =====================================================
 * OBTENER / ACTUALIZAR ESTADO DE UN TÓTEM
 * =====================================================
 */

async function obtenerEstadoTotem(
  connection,
  numeroTotem,
  fecha
) {

  const ip = construirIpTotem(
    connection.host,
    numeroTotem
  );

  /**
   * IP inválida
   */
  if (!ip) {

    console.error(
      `[TOTEMS] IP inválida. Local ${connection.codLocal}, ` +
      `host: ${connection.host}`
    );

    return {
      ip: null,
      estado: "OFF",
      horaEncendido: null
    };
  }


  /**
   * Ejecutar ping
   */
  const estaOnline = await comprobarPing(ip);

  const estadoActual = estaOnline ? "ON" : "OFF";


  /**
   * ===================================================
   * BUSCAR REGISTRO DEL DÍA
   * ===================================================
   */

  const registro = await mgmtDb("totem_estado_diario")
    .where({
      connection_id: connection.id,
      totem_numero: numeroTotem,
      fecha
    })
    .first();


  /**
   * ===================================================
   * NO EXISTE REGISTRO
   * ===================================================
   *
   * Se crea el registro correspondiente al día.
   *
   * Si comienza ON:
   *   hora_encendido = ahora
   *
   * Si comienza OFF:
   *   hora_encendido = NULL
   *
   * ultima_revision siempre = ahora.
   */

  if (!registro) {

    const ahora = mgmtDb.fn.now();

    await mgmtDb("totem_estado_diario") .insert({
        connection_id: connection.id,
        codLocal: connection.codLocal,
        totem_numero: numeroTotem,
        ip,
        fecha,
        estado: estadoActual,

        hora_encendido:
          estadoActual === "ON"
            ? ahora
            : null,

        // Primera observación del día: si arranca OFF, es el momento
        // más temprano que tenemos como "apagado" (no sabemos desde
        // cuándo antes de empezar a monitorear).
        hora_apagado:
          estadoActual === "OFF"
            ? ahora
            : null,

        ultima_revision: ahora,

        created_at: ahora,
        updated_at: ahora
      });

    return {
      ip,
      estado: estadoActual,
      horaEncendido:
        estadoActual === "ON"
          ? new Date()
          : null
    };
  }


  /**
   * ===================================================
   * REGISTRO EXISTENTE
   * ===================================================
   *
   * IMPORTANTE:
   *
   * ultima_revision se actualiza SIEMPRE.
   *
   * hora_encendido solamente cambia:
   *
   * OFF -> ON
   *
   * Nunca se modifica mientras permanece ON.
   */

  /**
   * ---------------------------------------------------
   * YA ESTABA ON
   * ---------------------------------------------------
   */

  if (registro.estado === "ON") {

    /**
     * ON -> OFF
     *
     * Aquí registramos la hora en que se apagó.
     */

    if (estadoActual === "OFF") {

      await mgmtDb("totem_estado_diario")
        .where({
          id: registro.id
        })
        .update({
          estado: "OFF",
          ip,
          hora_apagado: mgmtDb.fn.now(),
          ultima_revision: mgmtDb.fn.now(),
          updated_at: mgmtDb.fn.now()
        });

      return {
        ip,
        estado: "OFF",
        horaEncendido: registro.hora_encendido
      };
    }

    /**
     * ON -> ON
     *
     * Sin cambios de estado.
     */

    await mgmtDb("totem_estado_diario")
      .where({
        id: registro.id
      })
      .update({
        estado: estadoActual,
        ip,
        ultima_revision: mgmtDb.fn.now(),
        updated_at: mgmtDb.fn.now()
      });

    return {
      ip,
      estado: estadoActual,
      horaEncendido: registro.hora_encendido
    };
  }


  /**
   * ---------------------------------------------------
   * ESTABA OFF
   * ---------------------------------------------------
   */

  if (registro.estado === "OFF") {

    /**
     * OFF -> ON
     *
     * Aquí registramos la hora de encendido.
     */

    if (estadoActual === "ON") {

      await mgmtDb("totem_estado_diario")
        .where({
          id: registro.id
        })
        .update({
          estado: "ON",
          ip,
          hora_encendido: mgmtDb.fn.now(),
          hora_apagado: null,
          ultima_revision: mgmtDb.fn.now(),
          updated_at: mgmtDb.fn.now()
        });

      return {
        ip,
        estado: "ON",
        horaEncendido: new Date()
      };
    }


    /**
     * -------------------------------------------------
     * OFF -> OFF
     * -------------------------------------------------
     *
     * No modificamos hora_encendido.
     * Continúa NULL.
     *
     * Solamente actualizamos:
     *
     * - estado
     * - IP
     * - ultima_revision
     * - updated_at
     */

    await mgmtDb("totem_estado_diario")
      .where({
        id: registro.id
      })
      .update({
        estado: "OFF",
        ip,
        ultima_revision: mgmtDb.fn.now(),
        updated_at: mgmtDb.fn.now()
      });

    return {
      ip,
      estado: "OFF",
      horaEncendido: null
    };
  }


  /**
   * ===================================================
   * CASO NO PREVISTO
   * ===================================================
   */

  await mgmtDb("totem_estado_diario")
    .where({
      id: registro.id
    })
    .update({
      estado: estadoActual,
      ip,
      ultima_revision: mgmtDb.fn.now(),
      updated_at: mgmtDb.fn.now()
    });

  return {
    ip,
    estado: estadoActual,
    horaEncendido: registro.hora_encendido
  };
}


/**
 * =====================================================
 * MONITOREAR TODOS LOS TÓTEMS
 * =====================================================
 */

export async function monitorearTotems() {
  const fecha = obtenerFechaActual();
  /**OBTENER LOCALES
   * Por ahora monitoreamos solamente empresa_id = 2
   * (Tarragona).
   */

  const conexiones = await mgmtDb("connections")
    .where("activo", true)
    .where("kiosko", true)
    .where("empresa_id", 2)
    .select("id", "empresa_id", "codLocal", "name", "host", "ck");


  /**
   * No existen locales
   */

  if (!conexiones.length) {

    return {
      fecha,
      totalLocales: 0,
      totalTotems: 0,
      totalOn: 0,
      totalOff: 0,
      todosOn: true,
      resultados: []
    };
  }


  let totalTotems = 0;
  let totalOn = 0;
  let totalOff = 0;

  const resultados = [];


  /** PROCESAR LOCALES */

  for (const connection of conexiones) {
    const cantidadTotems = obtenerCantidadTotems(connection);

    if (cantidadTotems === 0) {
      continue;
    }

    /** nPROCESAR TÓTEMS  */

    for ( let numeroTotem = 1; numeroTotem <= cantidadTotems; numeroTotem++ ) {
      totalTotems++;

      try {
        const resultado = await obtenerEstadoTotem(
            connection, numeroTotem, fecha );

        if (resultado.estado === "ON") {
          totalOn++;
        } else {
          totalOff++;
        }


        resultados.push({
          connectionId: connection.id,
          empresaId: connection.empresa_id,
          codLocal: connection.codLocal,
          local: connection.name,
          totem: numeroTotem,
          ip: resultado.ip,
          estado: resultado.estado,
          horaEncendido:
            resultado.horaEncendido
        });

      } catch (error) {

        totalOff++;

        console.error(
          `[TOTEMS] Error procesando local ${connection.codLocal}, ` +
          `tótem ${numeroTotem}:`,
          error.message
        );

      }
    }
  }


  /**
   * ===================================================
   * DETERMINAR SI TODOS ESTÁN ON
   * ===================================================
   */

  const todosOn =
    totalTotems > 0 &&
    totalOn === totalTotems;


  return {
    fecha,
    totalLocales: conexiones.length,
    totalTotems,
    totalOn,
    totalOff,
    todosOn,
    resultados
  };
}


/**
 * =====================================================
 * EXPORTS
 * =====================================================
 */

export {
  construirIpTotem,
  comprobarPing
};