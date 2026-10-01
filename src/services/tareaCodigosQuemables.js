import sql from "mssql";
import mgmtDb from "../db/adminDb.js";
import { getSqlServerPool } from "../db/dbCentral.js";
import { enviarCorreoAlerta } from "../services/mailService.js";

const CODIGOS_POR_USUARIO = 15;

const USUARIOS = [
  {
    nombre: "Alfonso Goldschmidt",
    email: "agoldschmidt@tarragona.cl"
  }
];

async function ejecutarTareaCodigosQuemables() {
  try {
    const totalCodigos = USUARIOS.length * CODIGOS_POR_USUARIO;
    const fecha = new Date();
    const mes = String(fecha.getMonth() + 1).padStart(2, "0");
    const prefijo = `51${mes}`;
    const pool = await getSqlServerPool("EMPRESA1");
    const request = pool.request();

    request.input("cantidad",sql.Int,totalCodigos);
    request.input("prefijo",sql.VarChar(10),`${prefijo}%`);

    const query = `SELECT TOP (@cantidad) codigo
        FROM CodigoUnico.dbo.codigos
        WHERE codigo LIKE @prefijo
        ORDER BY id DESC`;

    const result = await request.query(query);
    const codigos = result.recordset.map(r => r.codigo.trim());
    console.log();
    

    if (!codigos.length) {
      console.log("No existen códigos para enviar.");
      return;
    }

    let indice = 0;
    for (const usuario of USUARIOS) {
      const codigosUsuario = codigos.slice(
        indice,
        indice + CODIGOS_POR_USUARIO
      );

      indice += CODIGOS_POR_USUARIO;

      if (!codigosUsuario.length) {
        continue;
      }

      const html = `
        <p>Estimado(a) <strong>${usuario.nombre}</strong>:</p>

        <p>
          Junto con saludar, informamos que se han generado
          los códigos de descuento correspondientes al período actual,
          para ser utilizados en compras realizadas en nuestros locales.
        </p>

        <p>
          Los códigos asignados son:
        </p>

        <ul>

          ${codigosUsuario
            .map(codigo => `<li><strong>${codigo}</strong></li>`)
            .join("")}

        </ul>

        <p>
          Estos códigos son personales y deben ser utilizados de acuerdo
          con las políticas internas de la empresa.
        </p>

        <br>

        <p>
          Saludos cordiales.
        </p>

        <strong>
          Departamento de Recursos Humanos
        </strong>

        <hr>

        <small>
          Este correo fue generado automáticamente.
          Por favor no responder este mensaje.
        </small>
      `;

      await enviarCorreoAlerta({
        to: usuario.email,
        bcc: "aplicaciones@tarragona.cl",
        subject: "Asignación de códigos de descuento",
        html,
        usarCc: false,
        usarBcc: true
      });

    }
    //Crear resultado de la Tarea para guardar
    await mgmtDb("scheduled_task_results").insert({
        task_id: 8,
        connection_id: 10,
        estado: `OK`,
        mensaje: "Envio de Codigos terminado",
        created_at: new Date()
    }).onConflict(["task_id", "connection_id"])
        .merge({
        estado: "OK",
        mensaje: "Envio de Codigos terminado",
        created_at: new Date()
    });

    //crear notificacion
    const contenido =`Codigos de descuento enviado a Socios`;
    await mgmtDb("notificaciones").insert({
        titulo: "Envio de correo a Socios",
        contenido,
        leido: false,
        url: `scheduled-tasks`,
        created_at: new Date()
    });


  } catch (error) {
    console.error(error);
    await mgmtDb("scheduled_task_results")
        .insert({
            task_id: 8,
            connection_id: 10,
            estado: "ERROR",
            mensaje: error,
            created_at: new Date()
        })
        .onConflict(["task_id", "connection_id"])
        .merge({
            estado: "ERROR",
            mensaje: error,
            created_at: new Date()
        });
    }

}
export default ejecutarTareaCodigosQuemables;