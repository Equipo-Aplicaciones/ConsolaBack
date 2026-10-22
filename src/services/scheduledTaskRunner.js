import mgmtDb from "../db/adminDb.js";
import sql from "mssql";
import { makeMssqlConfig } from "../db/connections.js";
import { enviarCorreoAlerta } from "../services/mailService.js";

const CAMPOS_TOGGLE_PERMITIDOS = ["invisibl", "web"];
const TABLAS_VACIABLES = ["comandae"];
const CODIGO_ARTICULO = /^\d{1,9}$/;

const escapar = (texto) =>
  String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function textoResultado(nombre, { conexiones, errores }) {
  if (!conexiones.length) {
    return `${nombre}: sin locales activos asociados`;
  }

  if (!errores.length) {
    return `${nombre} Ejecutada en ${conexiones.length} locales`;
  }

  return `${nombre} ejecutada en ${conexiones.length - errores.length} de ${conexiones.length} locales (${errores.length} con error)`;
}

// Valor de dia_activar / dia_desactivar que significa "todos los días"
const DIA_TODOS = 0;

// Fases de la corrida automática: a las 09:30 (MANANA) se activa; a las 12:00 (MEDIODIA) solo se
// desactivan las tareas que se activan ese mismo día.
export const FASE_MANANA = "MANANA";
export const FASE_MEDIODIA = "MEDIODIA";

function obtenerDiaSemana() {
  // lunes=1 ... domingo=7, según la hora de Santiago (no la del servidor)
  const dia = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "America/Santiago"
  }).format(new Date());

  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[dia];
}

async function registrarResultado(taskId, connectionId, estado, mensaje) {
  await mgmtDb("scheduled_task_results")
    .insert({
      task_id: taskId,
      connection_id: connectionId,
      estado,
      mensaje,
      created_at: new Date()
    })
    .onConflict(["task_id", "connection_id"])
    .merge({
      estado,
      mensaje,
      created_at: new Date()
    });
}

async function obtenerCodigosArticulos(taskId) {
  const rows = await mgmtDb("scheduled_task_articles")
    .select("codigo_articulo")
    .where("task_id", taskId);

  return rows.map((r) => r.codigo_articulo);
}

async function obtenerEmpresaIdsTarea(taskId) {
  const rows = await mgmtDb("scheduled_task_empresas")
    .select("empresa_id")
    .where("task_id", taskId);

  return rows.map((r) => r.empresa_id);
}

async function obtenerConexionesTarea(empresaIds, connectionIds) {
  if (!empresaIds.length) {
    return [];
  }

  let query = mgmtDb("connections")
    .whereIn("empresa_id", empresaIds)
    .where("activo", true)
    .select("id", "codLocal", "name", "host");

  if (connectionIds?.length > 0) {
    query = query.whereIn("id", connectionIds);
  }

  return query;
}

async function ejecutarToggleArticulo(pool, tarea, invisibl) {
  const codigos = await obtenerCodigosArticulos(tarea.id);

  if (!codigos.length) {
    return "Sin artículos asociados a la tarea";
  }

  const invalidos = codigos.filter(
    (c) => !CODIGO_ARTICULO.test(String(c).trim())
  );

  if (invalidos.length) {
    throw new Error(`Códigos de artículo inválidos: ${invalidos.join(", ")}`);
  }

  const campo = CAMPOS_TOGGLE_PERMITIDOS.includes(tarea.campo_objetivo)
    ? tarea.campo_objetivo
    : "invisibl";

  // "invisibl" es un indicador de ocultar (1 = oculto); "web" es de mostrar (1 = visible en la web).
  const oculto = Number(invisibl) ? 1 : 0;
  const valor = campo === "web" ? 1 - oculto : oculto;

  // articulo.codigo es texto: se compara como texto (no como número) para no convertir toda la columna.
  const request = pool.request();
  const parametros = codigos.map((c, i) => {
    request.input(`c${i}`, sql.VarChar(30), String(c).trim());
    return `@c${i}`;
  });

  const resultado = await request.query(`
    UPDATE articulo
    SET ${campo} = ${valor}
    WHERE codigo IN (${parametros.join(",")})
  `);

  const filas = resultado.rowsAffected.reduce((a, b) => a + b, 0);

  if (!filas) {
    throw new Error(
      `Ningún artículo del local coincide con los códigos de la tarea (${codigos.join(", ")})`
    );
  }

  return `Tarea ejecutada correctamente (${filas} artículo(s) actualizado(s))`;
}

async function ejecutarVaciarTabla(pool, tarea) {
  if (!TABLAS_VACIABLES.includes(tarea.tabla_objetivo)) {
    throw new Error(
      `Tabla no permitida para vaciar: ${tarea.tabla_objetivo}`
    );
  }

  await pool.request().query(`DELETE FROM ${tarea.tabla_objetivo}`);

  return "Tabla vaciada correctamente";
}

async function ejecutarTareaEnConexion(pool, tarea, invisibl) {
  if (tarea.tipo_accion === "VACIAR_TABLA") {
    return ejecutarVaciarTabla(pool, tarea);
  }

  return ejecutarToggleArticulo(pool, tarea, invisibl);
}

async function ejecutarTareaEnLocales(tarea, invisibl, connectionIds) {
  const empresaIds = await obtenerEmpresaIdsTarea(tarea.id);
  const conexiones = await obtenerConexionesTarea(empresaIds, connectionIds);

  if (!conexiones.length) {
    console.log(
      `ℹ️ Tarea ${tarea.codigo}: sin conexiones activas para sus empresas asociadas`
    );
    return { conexiones, errores: [] };
  }

  const errores = [];

  for (const connRow of conexiones) {
    try {
      const config = makeMssqlConfig(connRow.host);
      const pool = await new sql.ConnectionPool(config).connect();

      try {
        const mensaje = await ejecutarTareaEnConexion(pool, tarea, invisibl);
        await registrarResultado(tarea.id, connRow.id, "OK", mensaje);
      } finally {
        await pool.close();
      }
    } catch (err) {
      errores.push({
        codLocal: connRow.codLocal,
        nombre: connRow.name,
        mensaje: err.message
      });
      await registrarResultado(tarea.id, connRow.id, "ERROR", err.message);
    }
  }

  return { conexiones, errores };
}

async function runScheduledTasks({ taskId = null, connectionIds = null, fase = FASE_MANANA } = {}) {

  const diaSemana = obtenerDiaSemana();
  const hoy = [diaSemana, DIA_TODOS];
  const resumenes = []; // por tarea ejecutada: locales totales y con error (lo usan las rutas manuales)

  //verificar si hay tareas activas para hoy
  // (las de tipo OTRO las ejecuta su propio cron aparte — este runner nunca las toca)
  let query = mgmtDb("scheduled_tasks")
    .select(
      "id",
      "codigo",
      "nombre",
      "visible",
      "tipo_accion",
      "campo_objetivo",
      "tabla_objetivo"
    )
    .where({ activo: true })
    .whereNot("tipo_accion", "OTRO");

  if (taskId) {
    query.where("id", taskId);
  } else {
    query.whereIn("dia_activar", hoy);
  }

  // En la corrida del mediodía no se activa nada: solo se desactiva (más abajo).
  const tareas = !taskId && fase === FASE_MEDIODIA ? [] : await query;

  //si hay tareas activas para hoy, ejecutamos cada una en los locales de sus propias empresas
  if (tareas.length > 0) {
    const resultadosToggle = [];

    for (const tarea of tareas) { //recorremos cada tarea y ejecutamos en los locales de sus empresas asociadas
      let invisibl = 0;

      if (taskId && tarea.tipo_accion !== "VACIAR_TABLA") {
        invisibl = tarea.visible ? 0 : 1;
      }

      const resultado = await ejecutarTareaEnLocales(
        tarea,
        invisibl,
        connectionIds
      );
      const { conexiones, errores } = resultado;

      resumenes.push({
        id: tarea.id,
        codigo: tarea.codigo,
        nombre: tarea.nombre,
        total: conexiones.length,
        errores: errores.length
      });

      if (tarea.tipo_accion !== "VACIAR_TABLA") {
        resultadosToggle.push({ tarea, ...resultado });
      }

      console.log(
        `Fin de activación de ${tarea.codigo} (${conexiones.length} locales, ${errores.length} con error), creando notificacion`
      );

      if (taskId === null) { //si no se especifica un taskId, se ejecutan todas las tareas activas para hoy y se envía una notificación
        if (tarea.tipo_accion === "VACIAR_TABLA") {
          await mgmtDb("scheduled_tasks")
            .where("id", tarea.id)
            .update({ ultima_ejecucion: new Date() });

          // Vaciar tabla no genera aviso si sale bien; si falla en algún local, se notifica
          if (errores.length || !conexiones.length) {
            await mgmtDb("notificaciones").insert({
              titulo: "Error al vaciar tabla",
              contenido: textoResultado(tarea.nombre, resultado),
              leido: false,
              url: `scheduled-tasks`,
              created_at: new Date()
            });
          }
        } else {
          // Guardar notificación de activación de productos (con los locales que fallaron, si hubo)
          await mgmtDb("notificaciones").insert({
            titulo:
              errores.length || !conexiones.length
                ? "Error en activación de productos"
                : "Alerta de activación de productos",
            contenido: textoResultado(tarea.nombre, resultado),
            leido: false,
            url: `scheduled-tasks`,
            created_at: new Date()
          });

          // `visible` guarda el estado deseado (lo usa "Reintentar" para repetir el mismo cambio en los locales
          // con error), así que se actualiza aunque algún local haya fallado.
          await mgmtDb("scheduled_tasks")
            .where("id", tarea.id)
            .update({ visible: true, ultima_ejecucion: new Date() });
        }
      }
    }

    //Envio de correo (solo para tareas de activación/desactivación de artículos)
    if (taskId === null && resultadosToggle.length > 0) {
      const conProblemas = resultadosToggle.filter(
        (r) => r.errores.length || !r.conexiones.length
      );
      const subject = conProblemas.length
        ? `⚠️ ${resultadosToggle.length} promoción(es) ejecutada(s) automáticamente, ${conProblemas.length} con problemas`
        : `✅ ${resultadosToggle.length} promoción(es) ejecutada(s) automáticamente`;
      const lista = resultadosToggle
        .map(({ tarea: t, conexiones, errores }) => {
          const detalle = !conexiones.length
            ? " — ⚠ sin locales activos asociados"
            : errores.length
              ? ` — ⚠ ${errores.length} de ${conexiones.length} locales con error:<ul>${errores
                  .slice(0, 15)
                  .map(
                    (e) =>
                      `<li>${escapar(e.codLocal)} - ${escapar(e.nombre)}: ${escapar(e.mensaje)}</li>`
                  )
                  .join("")}${errores.length > 15 ? `<li>…y ${errores.length - 15} más</li>` : ""}</ul>`
              : ` — ${conexiones.length} locales`;

          return `<li><strong>${escapar(t.codigo)}</strong> - ${escapar(t.nombre)}${detalle}</li>`;
        })
        .join("");

      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
          <h2>Promociones ejecutadas automáticamente</h2>
          <p>
            El proceso automático ejecutó
            <strong>${resultadosToggle.length}</strong>
            promoción(es)${conProblemas.length ? `, <strong>${conProblemas.length}</strong> con problemas (revisar en Tareas → Resultados)` : " correctamente"}.
          </p>
          <ul>${lista}</ul>
          <p>
            Fecha de ejecución:
            <strong>${new Date().toLocaleString("es-CL")}</strong>
          </p>
          <hr>
          <small>
            Este correo fue generado automáticamente por el sistema de administración.
          </small>
        </div>
      `;

      await enviarCorreoAlerta({
        subject,
        html,
        to: "aplicaciones@tarragona.cl"
      });
    }

  }//fin de if tareas.length>0

  // El bloque de desactivación de abajo solo aplica a la corrida automática
  // diaria (sin taskId), y solo a tareas de tipo TOGGLE_ARTICULO — VACIAR_TABLA
  // no tiene concepto de desactivación. En un run manual, el bloque de
  // activación de arriba ya cubrió ambas direcciones para TOGGLE_ARTICULO
  // (lee el checkbox "Producto Visible" y aplica ese estado al POS) — dejar
  // correr este bloque también pisaría ese resultado.
  if (taskId) {
    return { resumenes };
  }

  //verificar si hay tareas de desactivacion activas para hoy
  // (solo llega aquí la corrida automática diaria, ver el return de arriba)
  const candidatasOff = await mgmtDb("scheduled_tasks")
        .select("id", "codigo", "nombre","visible","requiere_confirmacion","campo_objetivo","dia_activar")
        .where({
          activo: true,
          tipo_accion: "TOGGLE_ARTICULO"
        })
        .whereIn("dia_desactivar", hoy);

  // Una tarea que también se activa hoy (p. ej. "todos los días") se desactiva en la corrida del mediodía;
  // si hoy solo le toca desactivar, se hace en la de la mañana como siempre.
  const tareasoFF = candidatasOff.filter(
    (t) => hoy.includes(t.dia_activar) === (fase === FASE_MEDIODIA)
  );
  if (tareasoFF.length > 0) { //si hay tareas de desactivacion activas para hoy, las ejecutamos en los locales de sus propias empresas
    for(const tareaOff of tareasoFF) {
      if (tareaOff.requiere_confirmacion) {
        const contenido = `${tareaOff.nombre} requiere confirmación para desactivación`;
        // tareas que requieren confirmación no se ejecutan automáticamente, se genera una notificación para que el usuario confirme la desactivación
        await mgmtDb("notificaciones").insert({
            titulo: "Alerta de desactivación de productos",
            contenido,
            leido: false,
            url: `scheduled-tasks`,
            created_at: new Date()
          });
          //envio de correo para desactivacion
          const subject = `⚠️ Requiere confirmación para desactivar: ${tareaOff.codigo}`;

            const html = `
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
                <h2>Se requiere confirmación para desactivación de productos</h2>
                <p>
                  La siguiente promoción requiere confirmación para su desactivación:
                  <strong>${escapar(tareaOff.codigo)}</strong> - ${escapar(tareaOff.nombre)}
                  <hr>
                  Debe Ejecutarse manualmente
                </p>

                <hr>
                <small>
                  Este correo fue generado automáticamente por el sistema de administración.
                </small>
              </div>
            `;

            await enviarCorreoAlerta({
              subject,
              html,
              to: "aplicaciones@tarragona.cl"
            });
      } else {
        const resultadoOff = await ejecutarTareaEnLocales(tareaOff, 1, null);

        // Guardar notificación de desactivación de productos (con los locales que fallaron, si hubo)
        await mgmtDb("notificaciones").insert({
            titulo:
              resultadoOff.errores.length || !resultadoOff.conexiones.length
                ? "Error en desactivación de productos"
                : "Alerta de desactivación de productos",
            contenido: textoResultado(tareaOff.nombre, resultadoOff),
            leido: false,
            url: `scheduled-tasks`,
            created_at: new Date()
          });

        //modifica el campo visible de la tabla scheduled_tasks para que no se vuelva a ejecutar la tarea hasta el siguiente día de desactivación
        await mgmtDb("scheduled_tasks")
            .where("id", tareaOff.id)
            .update({ visible: false });
      }
    }
  }

  return { resumenes };
}

export default runScheduledTasks;
