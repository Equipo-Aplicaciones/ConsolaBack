import mgmtDb from "../db/adminDb.js";
import sql from "mssql";
import { makeMssqlConfig } from "../db/connections.js";
import { enviarCorreoAlerta } from "../services/mailService.js";

function obtenerDiaSemana() {
  // JS: domingo=0 ... sábado=6
  // Nosotros: lunes=1 ... domingo=7
  const dia = new Date().getDay();
  return dia === 0 ? 7 : dia;
}


async function runScheduledTasks({ taskId = null, connectionIds = null } = {}) {

  const diaSemana = obtenerDiaSemana();
  //obtenemos las conexiones activas de los locales
  let conexiones;

  //verificar si hay tareas activas para hoy
  let query = mgmtDb("scheduled_tasks")
    .select("id","codigo","nombre","visible")
    .where({ activo:true });

  if(taskId){
      query.where("id",taskId);
  }else{
      query
      .where("dia_activar",diaSemana)
  }

  const tareas = await query;
  
  //si hay tareas activas para hoy, obtenemos los codigos de los articulos asociados a esas tareas y las conexiones activas
  if (tareas.length>0) {    
    const codigosTareas = await mgmtDb("scheduled_task_articles")
    .select("codigo_articulo", "task_id")
    .whereIn("task_id", tareas.map((t) => t.id));

    if (connectionIds?.length > 0) {
      conexiones = await mgmtDb("connections")
        .whereIn("id", connectionIds)
        .where("activo", true)
        .where("empresa_id", 2)
        .select("id", "codLocal", "name", "host");
    } else {
      conexiones = await mgmtDb("connections")
        .where("activo", true)
        .where("empresa_id", 2)
        .select("id", "codLocal", "name", "host");
    }


    if (!conexiones.length) {
      console.log("ℹ️ No hay conexiones activas");
    } else {    
      for (const connRow of conexiones) { //recorremos las conexiones activas y ejecutamos la tarea de activacion de productos
        try {
          const config = makeMssqlConfig(connRow.host);
          const pool = await sql.connect(config);
          let invisibl = 0;
          if(taskId && tareas.length > 0){
            invisibl = tareas[0].visible ? 0 : 1;
          }
          await pool.request().query(`
            UPDATE articulo
            SET invisibl = ${invisibl}
            WHERE codigo IN (${codigosTareas.map((c) => c.codigo_articulo).join(",")})`);
            
            await pool.close();

            // Guardar resultados en la tabla scheduled_task_results
            for (const tarea of tareas) {
              await mgmtDb("scheduled_task_results").insert({
                task_id: tarea.id,
                connection_id: connRow.id,
                estado: `OK`,
                mensaje: "Tarea ejecutada correctamente",
                created_at: new Date()
              }).onConflict(["task_id", "connection_id"])
              .merge({
                estado: "OK",
                mensaje: "Tarea ejecutada correctamente",
                created_at: new Date()
              });
            }
            
          } catch (err) {
            for (const tarea of tareas) {
              // Guardar resultados en la tabla scheduled_task_results en caso de error
              await mgmtDb("scheduled_task_results").insert({
                task_id: tarea.id,
                connection_id: connRow.id,
                estado: `Error`,
                mensaje: err.message,
                created_at: new Date()
              }).onConflict(["task_id", "connection_id"])
              .merge({
                estado: "ERROR",
                mensaje: err.message,
                created_at: new Date()
              });
            }
          }
        }
        console.log("Fin de activación por local, creando notificacion");
        
        if(taskId === null && tareas.length > 0) { //si no se especifica un taskId, se ejecutan todas las tareas activas para hoy y se envía una notificación
          for (const tarea of tareas) {
            // Guardar notificación de activación de productos
            const contenido =`${tarea.nombre} Ejecutada en ${conexiones.length} locales`;
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
            .update({ visible: true,ultima_ejecucion: new Date() });
          }
        
        //Envio de correo
          const subject = `✅ ${tareas.length} promoción(es) ejecutada(s) automáticamente`;
          const lista = tareas
            .map( t => `<li><strong>${t.codigo}</strong> - ${t.nombre}</li>`)
            .join("");

          const html = `
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
              <h2>Promociones ejecutadas automáticamente</h2>
              <p>
                El proceso automático ejecutó correctamente
                <strong>${tareas.length}</strong>
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

      }
    
  }//fin de if tareas.length>0

  // El bloque de desactivación de abajo solo aplica a la corrida automática
  // diaria (sin taskId). En un run manual, el bloque de activación de arriba
  // ya cubrió ambas direcciones (lee el checkbox "Producto Visible" y aplica
  // ese estado al POS) — dejar correr este bloque también pisaría ese
  // resultado, forzando invisibl=1 sin mirar "visible" para nada.
  if (taskId) {
    return;
  }

  //verificar si hay tareas de desactivacion activas para hoy
  // (solo llega aquí la corrida automática diaria, ver el return de arriba)
  const tareasoFF = await mgmtDb("scheduled_tasks")
        .select("id", "codigo", "nombre","visible","requiere_confirmacion")
        .where({
          dia_desactivar: diaSemana,
          activo: true
        });
  if (tareasoFF.length > 0) { //si hay tareas de desactivacion activas para hoy, obtenemos los codigos de los articulos asociados a esas tareas y las conexiones activas
    const codigosoFF = await mgmtDb("scheduled_task_articles")
          .select("codigo_articulo", "task_id")
          .whereIn("task_id", tareasoFF.map((t) => t.id));

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
          const subject = `✅ ${tareas.length} promoción(es) ejecutada(s) automáticamente`;
            const lista = tareas
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
        // recorremos las conexiones activas y ejecutamos la tarea de desactivacion de productos
        conexiones = await mgmtDb("connections")
          .where("activo", true)
          .where("empresa_id", 2)
          .select("id", "codLocal", "name", "host");
        
        for (const connRow of conexiones) {
          try {
            const config = makeMssqlConfig(connRow.host);
            const pool = await sql.connect(config);
            
            await pool.request().query(`
              UPDATE articulo SET invisibl = 1
              WHERE codigo IN (${codigosoFF.map((c) => c.codigo_articulo).join(",")})`);
              
            await pool.close();
            // Guardar resultados en la tabla scheduled_task_results
            for (const tareaOff of tareasoFF) {
              await mgmtDb("scheduled_task_results")
                .insert({
                  task_id: tareaOff.id,
                  connection_id: connRow.id,
                  estado: "OK",
                  mensaje: "Productos desactivados correctamente",
                  created_at: new Date()
                })
                .onConflict(["task_id", "connection_id"])
                .merge({
                  estado: "OK",
                  mensaje: "Productos desactivados correctamente",
                  created_at: new Date()
                });
            }
          } catch (err) {
            for (const tareaOff of tareasoFF) {
              // Guardar resultados en la tabla scheduled_task_results en caso de error
              await mgmtDb("scheduled_task_results").insert({
                task_id: tareaOff.id,
                connection_id: connRow.id,
                estado: `❌ Error`,
                mensaje: err.message,
                created_at: new Date()
              }).onConflict(["task_id", "connection_id"])
                .merge({
                  estado: "ERROR",
                  mensaje: err.message,
                  created_at: new Date()
                });
            }
          }
        }
        
        for (const tareaOff of tareasoFF) { 
          // Guardar notificación de desactivación de productos
          const contenido = `${tareaOff.nombre} Ejecutada en ${conexiones.length} locales`;
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
        
}

export default runScheduledTasks;