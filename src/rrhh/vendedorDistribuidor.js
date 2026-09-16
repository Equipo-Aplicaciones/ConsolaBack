import sql from "mssql";
import mgmtDb from "../db/adminDb.js";
import { makeMssqlConfig } from "../db/connections.js";
import { obtenerVendedoresParaDistribucion } from "./sqlServerRepository.js";

const GRUPO_ESTADO = "VENDEDOR_IMPORT";
const TASK_DISTRIBUCION_VENDEDORES = 9;

function normalizarCuil(cuil) {
  return String(cuil ?? "").trim().toUpperCase();
}

async function obtenerEstadoId(codigo) {
  const estado = await mgmtDb("estados")
    .where({
      grupo: GRUPO_ESTADO,
      codigo,
      activo: true
    })
    .first("id");

  if (!estado) {
    throw new Error(`No existe el estado ${GRUPO_ESTADO}/${codigo}.`);
  }

  return estado.id;
}

async function obtenerEmpresa(codigoEmpresa) {
  const codigo = String(codigoEmpresa || "").trim().toUpperCase();

  if (!codigo) {
    throw new Error("Debe indicar la empresa.");
  }

  const empresa = await mgmtDb("empresas")
    .where({
      codigo,
      activo: true
    })
    .first(
      "id",
      "codigo",
      "nombre"
    );

  if (!empresa) {
    throw new Error(
      `La empresa ${codigo} no existe o se encuentra inactiva.`
    );
  }

  if (String(empresa.codigo).trim().toUpperCase() === "QA") {
    throw new Error(
      "QA no admite distribución de vendedores."
    );
  }

  return empresa;
}

function obtenerRegistrosPreview(preview) {
  if (!preview?.preview) {
    return [];
  }

  const registros =
    typeof preview.preview === "string"
      ? JSON.parse(preview.preview)
      : preview.preview;

  if (!Array.isArray(registros)) {
    throw new Error(
      `El contenido del preview ${preview.id} no es válido.`
    );
  }

  return registros;
}

function obtenerCuilesPreviews(previews = []) {
  const acciones = new Set([
    "CREATE",
    "UPDATE",
    "DEACTIVATE"
  ]);

  const cuiles = new Set();

  for (const preview of previews) {
    const registros = obtenerRegistrosPreview(preview);

    for (const registro of registros) {
      if (!acciones.has(registro.accion)) {
        continue;
      }

      const cuil = normalizarCuil(registro.cuil);

      if (cuil) {
        cuiles.add(cuil);
      }
    }
  }

  return [...cuiles];
}

async function obtenerLocalesActivos(empresaId) {
  return mgmtDb("connections")
    .where({
      empresa_id: empresaId,
      activo: true
    })
    .select(
      "id",
      "codLocal",
      "name",
      "host"
    )
    .orderBy("codLocal");
}

async function obtenerPreviews(empresa, estadoId) {
  return mgmtDb("vendedor_import_preview")
    .where({
      empresa: empresa.codigo,
      estado_id: estadoId
    })
    .whereNotNull("central_actualizado_at")
    .orderBy("created_at", "asc");
}

async function obtenerResultadoLocal(connectionId) {
  return mgmtDb("scheduled_task_results")
    .where({
      task_id: TASK_DISTRIBUCION_VENDEDORES,
      connection_id: connectionId
    })
    .first(
      "estado",
      "mensaje",
      "created_at"
    );
}

async function registrarResultadoLocal(
  connectionId,
  estado,
  mensaje
) {
  await mgmtDb("scheduled_task_results")
    .insert({
      task_id: TASK_DISTRIBUCION_VENDEDORES,
      connection_id: connectionId,
      estado,
      mensaje,
      created_at: new Date()
    })
    .onConflict([
      "task_id",
      "connection_id"
    ])
    .merge({
      estado,
      mensaje,
      created_at: new Date()
    });
}

async function obtenerVendedorLocal(
  transaction,
  vendedorCentral
) {
  const request = new sql.Request(transaction);

  request.input(
    "cuil",
    sql.VarChar(20),
    vendedorCentral.cuil
  );

  request.input(
    "vendedor",
    sql.Int,
    vendedorCentral.vendedor
  );

  const result = await request.query(`
    SELECT
      vendedor,
      UPPER(RTRIM(cuil)) AS cuil
    FROM vendedor
    WHERE UPPER(RTRIM(cuil)) = @cuil
       OR vendedor = @vendedor
  `);

  return result.recordset;
}

async function insertarVendedorLocal(
  transaction,
  vendedorCentral
) {
  const request = new sql.Request(transaction);

  request.input(
    "vendedor",
    sql.Int,
    vendedorCentral.vendedor
  );

  request.input(
    "nombre",
    sql.VarChar(25),
    String(vendedorCentral.nombre ?? "").substring(0, 25)
  );

  request.input(
    "puesto",
    sql.VarChar(20),
    vendedorCentral.puesto ?? ""
  );

  request.input(
    "clave",
    sql.VarChar(50),
    vendedorCentral.clave ?? ""
  );

  request.input(
    "cuil",
    sql.VarChar(20),
    vendedorCentral.cuil
  );

  request.input(
    "locales",
    sql.VarChar(20),
    vendedorCentral.locales ?? ""
  );

  request.input(
    "debaja",
    sql.Bit,
    Number(vendedorCentral.debaja) ? 1 : 0
  );

  request.input(
    "inhab",
    sql.Bit,
    Number(vendedorCentral.inhab) ? 1 : 0
  );

  request.input(
    "fe_ingreso",
    sql.DateTime,
    vendedorCentral.fe_ingreso ?? new Date()
  );

  request.input(
    "fe_egreso",
    sql.DateTime,
    vendedorCentral.fe_egreso ?? null
  );

  await request.query(`
    INSERT INTO vendedor (
      vendedor,
      nombre,
      puesto,
      clave,
      cuil,
      locales,
      debaja,
      inhab,
      tx,
      direccion,
      barrio,
      telefono,
      pais,
      estado_civ,
      edad,
      sexo,
      estudios,
      trabajos,
      camino_fot,
      foto,
      comision,
      rindio,
      fact_pen,
      color,
      fact1,
      fact2,
      fact3,
      fact4,
      fact5,
      fact6,
      fact7,
      fact8,
      fact9,
      fact10,
      fact11,
      fact12,
      art1,
      art2,
      art3,
      art4,
      art5,
      art6,
      art7,
      art8,
      art9,
      art10,
      art11,
      art12,
      imp1,
      imp2,
      imp3,
      imp4,
      imp5,
      imp6,
      imp7,
      imp8,
      imp9,
      imp10,
      imp11,
      imp12,
      com1,
      com2,
      com3,
      com4,
      com5,
      com6,
      com7,
      com8,
      com9,
      com10,
      com11,
      com12,
      observ,
      faltante,
      sobrante,
      chora,
      hora_i,
      hora_e,
      local,
      legajo,
      mensjor,
      horasxdia,
      empresa,
      nomemp,
      legajoext,
      usuariosql,
      paswsql,
      idhuella,
      idvendedorga,
      fe_ingreso,
      fe_egreso,
      licencia
    )
    VALUES (
      @vendedor,
      @nombre,
      @puesto,
      @clave,
      @cuil,
      @locales,
      @debaja,
      @inhab,
      1,
      '',
      '',
      '',
      '',
      '',
      0,
      '',
      '',
      '',
      '',
      0x,
      0,
      0,
      0,
      '',
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      '',
      '',
      '',
      0,
      '',
      '',
      0,
      '',
      0,
      0,
      0,
      '',
      @cuil,
      '',
      '',
      0,
      0,
      @fe_ingreso,
      @fe_egreso,
      ''
    )
  `);
}

async function actualizarVendedorLocal(
  transaction,
  vendedorCentral
) {
  const request = new sql.Request(transaction);

  request.input(
    "vendedor",
    sql.Int,
    vendedorCentral.vendedor
  );

  request.input(
    "cuil",
    sql.VarChar(20),
    vendedorCentral.cuil
  );

  request.input(
    "nombre",
    sql.VarChar(25),
    String(vendedorCentral.nombre ?? "").substring(0, 25)
  );

  request.input(
    "puesto",
    sql.VarChar(20),
    vendedorCentral.puesto ?? ""
  );

  request.input(
    "locales",
    sql.VarChar(20),
    vendedorCentral.locales ?? ""
  );

  request.input(
    "debaja",
    sql.Bit,
    Number(vendedorCentral.debaja) ? 1 : 0
  );

  request.input(
    "inhab",
    sql.Bit,
    Number(vendedorCentral.inhab) ? 1 : 0
  );

  request.input(
    "fe_ingreso",
    sql.DateTime,
    vendedorCentral.fe_ingreso ?? null
  );

  request.input(
    "fe_egreso",
    sql.DateTime,
    vendedorCentral.fe_egreso ?? null
  );

  await request.query(`
    UPDATE vendedor
    SET
      nombre = @nombre,
      puesto = @puesto,
      locales = @locales,
      debaja = @debaja,
      inhab = @inhab,
      fe_ingreso = COALESCE(@fe_ingreso, fe_ingreso),
      fe_egreso = @fe_egreso
    WHERE vendedor = @vendedor
      AND UPPER(RTRIM(cuil)) = @cuil
  `);
}

async function sincronizarVendedor(
  transaction,
  vendedorCentral
) {
  const existentes = await obtenerVendedorLocal(
    transaction,
    vendedorCentral
  );

  const porCuil = existentes.find(
    vendedor =>
      normalizarCuil(vendedor.cuil) === vendedorCentral.cuil
  );

  const porCodigo = existentes.find(
    vendedor =>
      Number(vendedor.vendedor) ===
      Number(vendedorCentral.vendedor)
  );

  if (!porCuil && !porCodigo) {
    await insertarVendedorLocal(
      transaction,
      vendedorCentral
    );

    return "INSERT";
  }

  if (
    porCuil &&
    Number(porCuil.vendedor) !==
      Number(vendedorCentral.vendedor)
  ) {
    throw new Error(
      `CUIL ${vendedorCentral.cuil}: vendedor Central ${vendedorCentral.vendedor}, vendedor local ${porCuil.vendedor}.`
    );
  }

  if (
    porCodigo &&
    normalizarCuil(porCodigo.cuil) !==
      vendedorCentral.cuil
  ) {
    throw new Error(
      `Código vendedor ${vendedorCentral.vendedor} está asociado localmente al CUIL ${normalizarCuil(porCodigo.cuil)} y en Central al CUIL ${vendedorCentral.cuil}.`
    );
  }

  await actualizarVendedorLocal(
    transaction,
    vendedorCentral
  );

  return "UPDATE";
}

async function distribuirEnLocal(local, vendedores) {
  let pool;
  let transaction;

  try {
    const config = {
      ...makeMssqlConfig(local.host),
      connectionTimeout: 10000,
      requestTimeout: 30000
    };

    pool = await new sql.ConnectionPool(config).connect();

    transaction = new sql.Transaction(pool);

    await transaction.begin();

    let insertados = 0;
    let actualizados = 0;

    for (const vendedor of vendedores) {
      const accion = await sincronizarVendedor(
        transaction,
        vendedor
      );

      if (accion === "INSERT") {
        insertados++;
      } else {
        actualizados++;
      }
    }

    await transaction.commit();

    await registrarResultadoLocal(
      local.id,
      "OK",
      `Distribución correcta. ${insertados} creados, ${actualizados} actualizados.`
    );

    return {
      connectionId: local.id,
      codLocal: local.codLocal,
      nombre: local.name,
      ok: true,
      insertados,
      actualizados
    };
  } catch (error) {
    if (transaction) {
      try {
        await transaction.rollback();
      } catch {}
    }

    await registrarResultadoLocal(
      local.id,
      "ERROR",
      error.message
    );

    return {
      connectionId: local.id,
      codLocal: local.codLocal,
      nombre: local.name,
      ok: false,
      error: error.message
    };
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {}
    }
  }
}

async function marcarPreviews(
  previewIds,
  estadoId,
  distribuido = false
) {
  if (!previewIds.length) {
    return;
  }

  const cambios = {
    estado_id: estadoId
  };

  if (distribuido) {
    cambios.distribuido_at = mgmtDb.fn.now();
  }

  await mgmtDb("vendedor_import_preview")
    .whereIn(
      "id",
      previewIds
    )
    .update(cambios);
}

export async function distribuirVendedoresEmpresa(
  codigoEmpresa
) {
  const empresa = await obtenerEmpresa(codigoEmpresa);

  const [
    estadoPreviewId,
    estadoParcialId,
    estadoDistribuidoId
  ] = await Promise.all([
    obtenerEstadoId("PREVIEW"),
    obtenerEstadoId("DISTRIBUCION_PARCIAL"),
    obtenerEstadoId("DISTRIBUIDO")
  ]);

  const parciales = await obtenerPreviews(
    empresa,
    estadoParcialId
  );

  const esReintento = parciales.length > 0;

  const previews = esReintento
    ? parciales
    : await obtenerPreviews(
        empresa,
        estadoPreviewId
      );

  if (!previews.length) {
    return {
      ok: true,
      empresa: empresa.codigo,
      sinTrabajo: true
    };
  }

  const previewIds = previews.map(
    preview => preview.id
  );

  const cuiles = obtenerCuilesPreviews(previews);

  if (!cuiles.length) {
    await marcarPreviews(
      previewIds,
      estadoDistribuidoId,
      true
    );

    return {
      ok: true,
      empresa: empresa.codigo,
      sinTrabajo: false,
      sinCambios: true,
      previews: previewIds
    };
  }

  const vendedores =
    await obtenerVendedoresParaDistribucion(
      cuiles,
      empresa.codigo
    );

  let locales = await obtenerLocalesActivos(
    empresa.id
  );

  if (esReintento) {
    const localesError = [];

    for (const local of locales) {
      const resultado = await obtenerResultadoLocal(
        local.id
      );

      if (
        String(resultado?.estado || "")
          .trim()
          .toUpperCase() === "ERROR"
      ) {
        localesError.push(local);
      }
    }

    locales = localesError;
  }

  if (esReintento && !locales.length) {
    await marcarPreviews(
      previewIds,
      estadoDistribuidoId,
      true
    );

    return {
      ok: true,
      empresa: empresa.codigo,
      reintento: true,
      previews: previewIds,
      localesProcesados: 0,
      distribuidos: 0,
      errores: 0
    };
  }

  const resultados = [];

  for (const local of locales) {
    const resultado = await distribuirEnLocal(
      local,
      vendedores
    );

    resultados.push(resultado);
  }

  const errores = resultados.filter(
    resultado => !resultado.ok
  );

  if (!errores.length) {
    await marcarPreviews(
      previewIds,
      estadoDistribuidoId,
      true
    );
  } else if (!esReintento) {
    await marcarPreviews(
      previewIds,
      estadoParcialId,
      false
    );
  } else {
    await marcarPreviews(
      previewIds,
      estadoDistribuidoId,
      true
    );
  }

  return {
    ok: errores.length === 0,
    empresa: empresa.codigo,
    reintento: esReintento,
    previews: previewIds,
    cantidadCuiles: cuiles.length,
    cantidadVendedores: vendedores.length,
    localesProcesados: resultados.length,
    distribuidos:
      resultados.length - errores.length,
    errores: errores.length,
    resultados
  };
}

export default distribuirVendedoresEmpresa;