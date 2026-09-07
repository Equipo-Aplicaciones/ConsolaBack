import cron from "node-cron";
import runScheduledTasks from "../services/scheduledTaskRunner.js";

let ejecutando = false;

async function ejecutarScheduledTasks() {
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
      "[CRON PRODUCTOS] Iniciando Activaciones/Desactivaciones de Productos..."
    );

    await runScheduledTasks();

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
    "30 9 * * *",
    ejecutarScheduledTasks,
    {
      timezone: "America/Santiago"
    }
  );
};