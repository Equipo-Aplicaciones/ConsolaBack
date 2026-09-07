import cron from "node-cron";
import mgmtDb from "../db/adminDb.js";
import { distribuirVendedoresEmpresa } from "../rrhh/vendedorDistribuidor.js";
import { enviarCorreoAlerta } from "../services/mailService.js";

const TIMEZONE = "America/Santiago";
let tareaProgramada = null;
let ejecutando = false;

async function obtenerEmpresasDistribucion() {
  return mgmtDb("empresas")
    .select("id", "codigo", "nombre")
    .where({ activo: true })
    .whereNot("codigo", "QA")
    .orderBy("id");
}

async function enviarAlertaDistribucion(empresa, resultado) {
  const errores = Array.isArray(resultado.resultados)
    ? resultado.resultados.filter(item => !item.ok)
    : [];

  const contenido = `${resultado.errores} local(es) de ${empresa.nombre} presentaron error durante la distribución de vendedores.`;

  try {
    await mgmtDb("notificaciones").insert({
      titulo: "Alerta distribución de vendedores",
      contenido,
      leido: false,
      url: "scheduled-tasks",
      created_at: new Date()
    });
  } catch (error) {
    console.error(
      `[VENDEDORES][${empresa.codigo}] Error creando notificación:`,
      error.message
    );
  }

  const lista = errores
    .map(item => `
      <li>
        <strong>${item.codLocal} - ${item.nombre}</strong>
        ${item.error ? `: ${item.error}` : ""}
      </li>
    `)
    .join("");

  const subject = `❌ Error distribución de vendedores - ${empresa.nombre}`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
      <h2>Error en distribución de vendedores</h2>

      <p>
        El proceso automático de distribución de vendedores para
        <strong>${empresa.nombre}</strong>
        presentó errores por segunda vez.
      </p>

      <p>
        Locales afectados:
        <strong>${resultado.errores}</strong>
      </p>

      ${lista ? `<ul>${lista}</ul>` : ""}

      <p>
        El lote fue liberado para permitir que las nuevas cargas
        continúen normalmente. Los locales indicados deben ser
        revisados manualmente.
      </p>

      <p>
        Fecha:
        <strong>
          ${new Date().toLocaleString("es-CL", {
            timeZone: TIMEZONE
          })}
        </strong>
      </p>

      <hr>

      <small>
        Este correo fue generado automáticamente por el sistema de administración.
      </small>
    </div>
  `;

  try {
    await enviarCorreoAlerta({
      subject,
      html,
      to: "aplicaciones@tarragona.cl"
    });
  } catch (error) {
    console.error(
      `[VENDEDORES][${empresa.codigo}] Error enviando correo:`,
      error.message
    );
  }
}

async function procesarEmpresa(empresa) {
  const inicio = Date.now();

  try {
    const primerResultado = await distribuirVendedoresEmpresa(
      empresa.codigo
    );

    if (primerResultado.sinTrabajo) {
      return {
        empresa: empresa.codigo,
        parcial: null,
        nuevos: null
      };
    }

    if (primerResultado.reintento) {
      if (primerResultado.errores > 0) {
        await enviarAlertaDistribucion(
          empresa,
          primerResultado
        );
      }

      const nuevos = await distribuirVendedoresEmpresa(
        empresa.codigo
      );

      return {
        empresa: empresa.codigo,
        parcial: primerResultado,
        nuevos
      };
    }

    return {
      empresa: empresa.codigo,
      parcial: null,
      nuevos: primerResultado
    };
  } finally {
    const segundos = (
      (Date.now() - inicio) / 1000
    ).toFixed(1);

    console.log(
      `[CRON VENDEDORES] ${empresa.codigo} finalizada en ${segundos}s`
    );
  }
}

export async function ejecutarDistribucionVendedores() {
  if (ejecutando) {
    console.log(
      "[CRON VENDEDORES] Ejecución omitida: proceso anterior aún activo."
    );

    return {
      ok: false,
      ejecutando: true
    };
  }

  ejecutando = true;
  const inicio = Date.now();

  try {
    const empresas =
      await obtenerEmpresasDistribucion();

    if (!empresas.length) {
      return {
        ok: true,
        empresas: []
      };
    }

    const resultados = await Promise.allSettled(
      empresas.map(empresa =>
        procesarEmpresa(empresa)
      )
    );

    const respuesta = resultados.map(
      (resultado, index) => {
        const empresa = empresas[index];

        if (resultado.status === "fulfilled") {
          return {
            ok: true,
            empresa: empresa.codigo,
            resultado: resultado.value
          };
        }

        console.error(
          `[VENDEDORES][${empresa.codigo}] Error procesando empresa:`,
          resultado.reason
        );

        return {
          ok: false,
          empresa: empresa.codigo,
          error:
            resultado.reason?.message ||
            "Error desconocido"
        };
      }
    );

    return {
      ok: respuesta.every(
        resultado => resultado.ok
      ),
      empresas: respuesta
    };

  } catch (error) {
    console.error(
      "[VENDEDORES] Error general ejecutando distribución:",
      error
    );

    throw error;

  } finally {
    const segundos = (
      (Date.now() - inicio) / 1000
    ).toFixed(1);

    console.log(
      `[CRON VENDEDORES] Distribución completa finalizada en ${segundos}s`
    );

    ejecutando = false;
  }
}

export function iniciarVendedorScheduler() {
  if (tareaProgramada) {
    return tareaProgramada;
  }

  tareaProgramada = cron.schedule(
    "0 18 * * *",
    async () => {
      try {
        await ejecutarDistribucionVendedores();
      } catch (error) {
        console.error(
          "[VENDEDORES] Error en ejecución programada:",
          error
        );
      }
    },
    {
      timezone: TIMEZONE
    }
  );

  return tareaProgramada;
}

export function detenerVendedorScheduler() {
  if (!tareaProgramada) {
    return;
  }

  tareaProgramada.stop();
  tareaProgramada = null;
}

export default iniciarVendedorScheduler;