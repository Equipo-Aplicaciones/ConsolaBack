import cron from "node-cron";
import db from "../db/adminDb.js";
import { enviarCorreoAlerta } from "../services/mailService.js";

const EMPRESAS = [
  {
    id: 1,
    nombre: "TARRAGONA"
  },
  {
    id: 3,
    nombre: "ELEMENTAL - PS"
  }
];

let ejecutando = false;

async function consultarEmpresa(empresa) {
  const inicio = Date.now();

  const url =
    `http://localhost:3000/actualizaciones/estado-horario/resumen` +
    `?empresa_id=${empresa.id}`;

  const res = await fetch(url, {
    headers: {
      "x-api-key": process.env.API_KEY
    }
  });

  if (!res.ok) {
    throw new Error(
      `Error consultando ${empresa.nombre} (${res.status})`
    );
  }

  const response = await res.json();

  const data = Array.isArray(response.data)
    ? response.data
    : [];

  const segundos = (
    (Date.now() - inicio) / 1000
  ).toFixed(1);

  console.log(
    `[CRON VENTAS] ${empresa.nombre} consultada en ${segundos}s`
  );

  return data.map(item => ({
    ...item,
    empresa_id: empresa.id,
    empresa_nombre: empresa.nombre,
    nombreLocal:
      item.nombreLocal ||
      item.Nom_local ||
      item.name ||
      "Sin nombre"
  }));
}

async function ejecutarMonitoreoVentas() {
  if (ejecutando) {
    console.log(
      "[CRON VENTAS] Ejecución omitida: proceso anterior aún activo."
    );
    return;
  }

  ejecutando = true;
  const inicio = Date.now();

  try {
    const resultados = [];

    for (const empresa of EMPRESAS) {
      try {
        const dataEmpresa =
          await consultarEmpresa(
            empresa
          );

        resultados.push(
          ...dataEmpresa
        );

      } catch (error) {
        console.error(
          `[CRON VENTAS] Error consultando ${empresa.nombre}: ${error.message}`
        );
      }
    }

    const alertas =
      resultados.filter(item =>
        item.estado === "Critica" ||
        item.estado === "Sin ventas hoy"
      );

    if (alertas.length === 0) {
      return;
    }

    const sinVentas =
      alertas.filter(
        item =>
          item.estado === "Sin ventas hoy"
      ).length;

    const critica =
      alertas.filter(
        item =>
          item.estado === "Critica"
      ).length;

    const resumenEmpresas =
      EMPRESAS.map(empresa => {
        const alertasEmpresa =
          alertas.filter(
            item =>
              item.empresa_id === empresa.id
          );

        return {
          ...empresa,
          total: alertasEmpresa.length,
          sinVentas:
            alertasEmpresa.filter(
              item =>
                item.estado ===
                "Sin ventas hoy"
            ).length,
          critica:
            alertasEmpresa.filter(
              item =>
                item.estado ===
                "Critica"
            ).length
        };

      }).filter(
        empresa =>
          empresa.total > 0
      );

    const contenido =
      `${sinVentas} locales Sin ventas hoy, ` +
      `${critica} locales con demora Crítica.`;

    await db("notificaciones")
      .insert({
        titulo:
          "Alerta de estado de locales",
        contenido,
        leido: false,
        url: "ultima-venta",
        created_at: new Date()
      });

    const htmlRows =
      alertas.map(item => {
        const color =
          item.estado === "Critica"
            ? "#dc3545"
            : "#fd7e14";

        return `
          <tr>
            <td style="padding:8px;border:1px solid #ddd;">
              ${item.empresa_nombre}
            </td>

            <td style="padding:8px;border:1px solid #ddd;">
              ${item.codLocal ?? "-"}
            </td>

            <td style="padding:8px;border:1px solid #ddd;">
              ${item.nombreLocal}
            </td>

            <td style="padding:8px;border:1px solid #ddd;color:${color};font-weight:bold;">
              ${item.estado}
            </td>
          </tr>
        `;
      }).join("");

    const htmlResumenEmpresas =
      resumenEmpresas
        .map(empresa => `
          <li>
            <strong>${empresa.nombre}</strong>:
            ${empresa.sinVentas} sin ventas,
            ${empresa.critica} críticos
          </li>
        `)
        .join("");

    const html = `
      <div style="font-family:Arial,sans-serif;padding:20px;">
        <h2 style="color:#dc3545;">
          🚨 Resumen Monitoreo Ventas
        </h2>

        <p>
          Se detectaron
          <strong>${alertas.length}</strong>
          locales con problemas de distribución.
        </p>

        <ul>
          ${htmlResumenEmpresas}
        </ul>

        <table style="border-collapse:collapse;width:100%;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:8px;border:1px solid #ddd;">
                Empresa
              </th>

              <th style="padding:8px;border:1px solid #ddd;">
                Código
              </th>

              <th style="padding:8px;border:1px solid #ddd;">
                Local
              </th>

              <th style="padding:8px;border:1px solid #ddd;">
                Estado
              </th>
            </tr>
          </thead>

          <tbody>
            ${htmlRows}
          </tbody>
        </table>

        <br>

        <p>
          Por favor contactar a N2 para revisar
          el Distribuidor y realizar seguimiento
          de venta.
        </p>
      </div>
    `;

    await enviarCorreoAlerta({
      subject:
        `🚨 ${alertas.length} locales con problemas de Distribución`,
      html,
      to: "mesadeayuda@tarragona.cl"
    });

  } catch (error) {
    console.error(
      `[CRON VENTAS] Error general: ${error.message}`
    );

  } finally {
    const segundos = (
      (Date.now() - inicio) / 1000
    ).toFixed(1);

    console.log(
      `[CRON VENTAS] Finalizado en ${segundos}s`
    );

    ejecutando = false;
  }
}

export const initCronJobs = () => {
  cron.schedule(
    "30 13,15 * * *",
    ejecutarMonitoreoVentas,
    {
      timezone: "America/Santiago"
    }
  );
};