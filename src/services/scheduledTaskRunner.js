import mgmtDb from "../db/adminDb.js";
import sql from "mssql";
import { makeMssqlConfig } from "../db/connections.js";
import { enviarCorreoAlerta } from "../services/mailService.js";

const CAMPOS_TOGGLE_PERMITIDOS = ["invisibl", "web"];
const TABLAS_VACIABLES = ["comandae"];

function obtenerDiaSemana() {
  // JS: domingo=0 ... sábado=6
  // Nosotros: lunes=1 ... domingo=7
  const dia = new Date().getDay();
  return dia === 0 ? 7 : dia;
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

  const campo = CAMPOS_TOGGLE_PERMITIDOS.includes(tarea.campo_objetivo)
    ? tarea.campo_objetivo
    : "invisibl";

  await pool.request().query(`
    UPDATE articulo
    SET ${campo} = ${invisibl}
    WHERE codigo IN (${codigos.join(",")})
  `);

  return "Tarea ejecutada correctamente";
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
    return conexiones;
  }

  for (const connRow of conexiones) {
    try {
      const config = makeMssqlConfig(connRow.host);
      const pool = await sql.connect(config);

      try {
        const mensaje = await ejecutarTareaEnConexion(pool, tarea, invisibl);
        await registrarResultado(tarea.id, connRow.id, "OK", mensaje);
      } finally {
        await pool.close();
      }
    } catch (err) {
      await registrarResultado(tarea.id, connRow.id, "ERROR", err.message);
    }
  }

  return conexiones;
}

async function runScheduledTasks({ taskId = null, connectionIds = null } = {}) {

  const diaSemana = obtenerDiaSemana();

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
    query.where("dia_activar", diaSemana);
  }

  const tareas = await query;

  //si hay tareas activas para hoy, ejecutamos cada una en los locales de sus propias empresas
  if (tareas.length > 0) {
    const tareasToggle = tareas.filter(
      (t) => t.tipo_accion !== "VACIAR_TABLA"
    );

    for (const tarea of tareas) { //recorremos cada tarea y ejecutamos en los locales de sus empresas asociadas
      let invisibl = 0;

      if (taskId && tarea.tipo_accion !== "VACIAR_TABLA") {
        invisibl = tarea.visible ? 0 : 1;
      }

      const conexiones = await ejecutarTareaEnLocales(
        tarea,
        invisibl,
        connectionIds
      );

      console.log(
        `Fin de activación de ${tarea.codigo} (${conexiones.length} locales), creando notificacion`
      );

      if (taskId === null) { //si no se especifica un taskId, se ejecutan todas las tareas activas para hoy y se envía una notificación
        if (tarea.tipo_accion === "VACIAR_TABLA") {
          await mgmtDb("scheduled_tasks")
            .where("id", tarea.id)
            .update({ ultima_ejecucion: new Date() });
        } else {
          // Guardar notificación de activación de productos
          const contenido = `${tarea.nombre} Ejecutada en ${conexiones.length} locales`;
          await mgmtDb("notificaciones").insert({
            titulo: "Alerta de activación de productos",
            contenido,
            leido: false,
            url: `scheduled-tasks`,
            created_at: new Date()
          });

          //modifica el campo visible de la tabla scheduled_tasks para que no se vuelva a ejecutar la tarea hasta el siguiente día de activación
          await mgmtDb("scheduled_tasks")
            .where("id", tarea.id)
            .update({ visible: true, ultima_ejecucion: new Date() });
        }
      }
    }

    //Envio de correo (solo para tareas de activación/desactivación de artículos)
    if (taskId === null && tareasToggle.length > 0) {
      const subject = `✅ ${tareasToggle.length} promoción(es) ejecutada(s) automáticamente`;
      const lista = tareasToggle
        .map( t => `<li><strong>${t.codigo}</strong> - ${t.nombre}</li>`)
        .join("");

      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
          <h2>Promociones ejecutadas automáticamente</h2>
          <p>
            El proceso automático ejecutó correctamente
            <strong>${tareasToggle.length}</strong>
            promoción(es).
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
    return;
  }

  //verificar si hay tareas de desactivacion activas para hoy
  // (solo llega aquí la corrida automática diaria, ver el return de arriba)
  const tareasoFF = await mgmtDb("scheduled_tasks")
        .select("id", "codigo", "nombre","visible","requiere_confirmacion","campo_objetivo")
        .where({
          dia_desactivar: diaSemana,
          activo: true,
          tipo_accion: "TOGGLE_ARTICULO"
        });
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
          const subject = `✅ ${tareasoFF.length} promoción(es) ejecutada(s) automáticamente`;
            const lista = tareasoFF
              .map( t => `<li><strong>${t.codigo}</strong> - ${t.nombre}</li>`)
              .join("");

            const html = `
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
                <h2>Se requiere confirmación para desactivación de productos</h2>
                <p>
                  La siguiente promoción requiere confirmación para su desactivación:
                  <strong>${tareaOff.codigo}</strong> - ${tareaOff.nombre}
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
        const conexionesOff = await ejecutarTareaEnLocales(tareaOff, 1, null);

        // Guardar notificación de desactivación de productos
        const contenido = `${tareaOff.nombre} Ejecutada en ${conexionesOff.length} locales`;
        await mgmtDb("notificaciones").insert({
            titulo: "Alerta de desactivación de productos",
            contenido,
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

}

export default runScheduledTasks;
