import cron from "node-cron";
import { monitorearTotems } from "../services/totemsStatusService.js";

let ejecutando = false;

async function ejecutarMonitoreoTotems() {
  if (ejecutando) {
    console.log("[CRON TÓTEMS] Ejecución omitida: monitoreo anterior aún activo.");
    return;
  }

  ejecutando = true;
  const inicio = Date.now();

  try {
    const resultado = await monitorearTotems();
    const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

    console.log(
      `[CRON TÓTEMS] Finalizado en ${segundos}s - Todos ON: ${resultado.todosOn}`
    );
  } catch (error) {
    const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

    console.error(
      `[CRON TÓTEMS] Error después de ${segundos}s:`,
      error.message
    );
  } finally {
    ejecutando = false;
  }
}

export function totemsStatusJob() {
  const opciones = {
    timezone: "America/Santiago"
  };

  cron.schedule(
    "35,45,55 10 * * *",
    ejecutarMonitoreoTotems,
    opciones
  );

  cron.schedule(
    "5,15,25,35,45,55 11 * * *",
    ejecutarMonitoreoTotems,
    opciones
  );

  cron.schedule(
    "5,15,25,35 12 * * *",
    ejecutarMonitoreoTotems,
    opciones
  );

  cron.schedule(
    "45 13-20 * * *",
    ejecutarMonitoreoTotems,
    opciones
  );
}