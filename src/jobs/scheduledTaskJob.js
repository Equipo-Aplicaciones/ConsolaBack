import cron from "node-cron";
import runScheduledTasks, {
  FASE_MANANA,
  FASE_MEDIODIA
} from "../services/scheduledTaskRunner.js";
import {
  notificarGestionesQueInician,
  enviarCorreoGestionesQueInician
} from "../services/gestionesAlertService.js";

let ejecutando = false;

// Un solo cron para todo el módulo. Una expresión no puede combinar "09:30" y "12:00", así que
// dispara a las 09:00, 09:30, 12:00 y 12:30 y esta función decide si le toca hacer algo.
// Tolerancia de 15 minutos por si el proceso llega atrasado a la hora.
export function faseActual(fecha = new Date()) {
  const partes = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "America/Santiago"
  }).formatToParts(fecha);

  const hora = Number(partes.find((p) => p.type === "hour").value);
  const minuto = Number(partes.find((p) => p.type === "minute").value);

  if (hora === 9 && minuto >= 15 && minuto < 45) return FASE_MANANA;
  if (hora === 12 && minuto < 15) return FASE_MEDIODIA;

  return null;
}

async function ejecutarScheduledTasks() {
  const fase = faseActual();

  if (!fase) {
    return;
  }

  if (ejecutando) {
    console.log(
      "[CRON PRODUCTOS] Ejecución omitida: proceso anterior aún activo."
    );
    return;
  }

  ejecutando = true;
  const inicio = Date.now();

  try {
    console.log(
      fase === FASE_MANANA
        ? "[CRON PRODUCTOS] Iniciando Activaciones/Desactivaciones de Productos..."
        : "[CRON PRODUCTOS] Iniciando Desactivaciones de mediodía..."
    );

    await runScheduledTasks({ fase });

    // Aviso a los encargados de las gestiones que inician hoy (misma corrida de la mañana, sin otro cron)
    if (fase === FASE_MANANA) {
      try {
        const aviso = await notificarGestionesQueInician();
        console.log(
          `[CRON PRODUCTOS] Gestiones que inician hoy: ${aviso.gestiones}, avisos creados: ${aviso.notificaciones}`
        );
      } catch (error) {
        console.error(`[CRON PRODUCTOS] Error avisando gestiones que inician: ${error.message}`);
      }

      try {
        const correo = await enviarCorreoGestionesQueInician();
        console.log(
          correo.enviado
            ? `[CRON PRODUCTOS] Correo de gestiones que inician hoy enviado (${correo.gestiones})`
            : `[CRON PRODUCTOS] Correo de gestiones que inician hoy no enviado: ${correo.motivo}`
        );
      } catch (error) {
        console.error(`[CRON PRODUCTOS] Error enviando correo de gestiones que inician: ${error.message}`);
      }
    }

  } catch (error) {
    console.error(
      `[CRON PRODUCTOS] Error: ${error.message}`
    );

  } finally {
    const segundos = (
      (Date.now() - inicio) / 1000
    ).toFixed(1);

    console.log(
      `[CRON PRODUCTOS] Finalizado en ${segundos}s`
    );

    ejecutando = false;
  }
}

export const initScheduledTaskJob = () => {
  cron.schedule(
    "0,30 9,12 * * *",
    ejecutarScheduledTasks,
    {
      timezone: "America/Santiago"
    }
  );
};
