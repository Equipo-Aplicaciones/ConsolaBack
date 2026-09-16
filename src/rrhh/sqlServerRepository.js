import sql from "mssql";
import { getSqlServerPool } from "../db/dbCentral.js";

function validarEmpresa(empresa) {
  if (!empresa) {
    throw new Error("Debe indicar la empresa.");
  }

  if (String(empresa).trim().toUpperCase() === "QA") {
    throw new Error("QA no admite operaciones de vendedores.");
  }
}

export async function obtenerVendedoresExistentes(cuiles = [], empresa) {
  if (!cuiles.length) {
    return new Map();
  }

  validarEmpresa(empresa);

  cuiles = [
    ...new Set(
      cuiles
        .map(cuil => String(cuil || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];

  if (!cuiles.length) {
    return new Map();
  }

  const pool = await getSqlServerPool(empresa);
  const request = pool.request();
  const parametros = [];

  cuiles.forEach((cuil, index) => {
    const parametro = `cuil${index}`;

    request.input(
      parametro,
      sql.VarChar(20),
      cuil
    );

    parametros.push(`@${parametro}`);
  });

  const query = `
    SELECT
      UPPER(RTRIM(cuil)) AS cuil,
      puesto,
      locales,
      debaja,
      inhab
    FROM vendedor
    WHERE UPPER(RTRIM(cuil)) IN (${parametros.join(",")})
  `;

  const result = await request.query(query);
  const mapa = new Map();

  result.recordset.forEach(vendedor => {
    mapa.set(
      vendedor.cuil,
      {
        puesto: vendedor.puesto?.trim(),
        locales: vendedor.locales?.trim(),
        debaja: Number(vendedor.debaja),
        inhab: Number(vendedor.inhab)
      }
    );
  });

  return mapa;
}

/** INSERTAR VENDEDORES */
export async function insertarVendedores(vendedores = [], empresa) {
  if (!vendedores.length) {
    return;
  }

  validarEmpresa(empresa);

  const pool = await getSqlServerPool(empresa);

  const ultimo = await pool.request().query(`
    SELECT ISNULL(MAX(vendedor), 0) AS ultimo
    FROM vendedor
  `);

  let correlativo = Number(
    ultimo.recordset[0].ultimo
  );

  for (const vendedor of vendedores) {
    correlativo++;

    const request = pool.request();

    request.input(
      "vendedor",
      sql.Int,
      correlativo
    );

    request.input(
      "nombre",
      sql.VarChar(25),
      String(vendedor.nombre || "").substring(0, 25)
    );

    request.input(
      "puesto",
      sql.VarChar(20),
      vendedor.perfil
    );

    request.input(
      "cuil",
      sql.VarChar(20),
      String(vendedor.cuil || "").trim().toUpperCase()
    );

    request.input(
      "locales",
      sql.VarChar(20),
      vendedor.local
    );

    const query = `
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
        licencia
      )
      VALUES (
        @vendedor,
        @nombre,
        @puesto,
        dbo.ClaveMRC(@cuil),
        @cuil,
        @locales,
        0,
        0,
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
        0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,
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
        GETDATE(),
        ''
      )
    `;

    await request.query(query);
  }
}

/** DESACTIVAR VENDEDORES */
export async function desactivarVendedores(vendedores = [], empresa) {
  if (!vendedores.length) {
    return;
  }

  validarEmpresa(empresa);

  const pool = await getSqlServerPool(empresa);

  for (const vendedor of vendedores) {
    const request = pool.request();

    request.input(
      "cuil",
      sql.VarChar(20),
      String(vendedor.cuil || "").trim().toUpperCase()
    );

    await request.query(`
      UPDATE vendedor
      SET
        debaja = 1,
        inhab = 1,
        fe_egreso = GETDATE()
      WHERE UPPER(RTRIM(cuil)) = @cuil
    `);
  }
}

/** ACTUALIZAR VENDEDORES */
export async function actualizarVendedores(vendedores = [], empresa) {
  if (!vendedores.length) {
    return;
  }

  validarEmpresa(empresa);

  const pool = await getSqlServerPool(empresa);

  for (const vendedor of vendedores) {
    if (!vendedor.cambios?.length) {
      continue;
    }

    const request = pool.request();

    request.input(
      "cuil",
      sql.VarChar(20),
      String(vendedor.cuil || "").trim().toUpperCase()
    );

    const set = [];

    if (vendedor.cambios.includes("LOCAL")) {
      request.input(
        "locales",
        sql.VarChar(20),
        vendedor.local
      );

      set.push(
        "locales = @locales"
      );
    }

    if (vendedor.cambios.includes("PERFIL")) {
      request.input(
        "puesto",
        sql.VarChar(20),
        vendedor.perfil
      );

      set.push(
        "puesto = @puesto"
      );
    }

    if (vendedor.cambios.includes("ESTADO")) {
      request.input(
        "debaja",
        sql.Bit,
        0
      );

      request.input(
        "inhab",
        sql.Bit,
        0
      );

      set.push(
        "debaja = @debaja"
      );

      set.push(
        "inhab = @inhab"
      );
    }

    set.push(
      "fe_ingreso = GETDATE()"
    );

    const query = ` UPDATE vendedor SET ${set.join(",\n          ")}
      WHERE UPPER(RTRIM(cuil)) = @cuil`;

    await request.query(query);
  }
}

export async function obtenerVendedoresParaDistribucion(cuiles = [], empresa) {
  if (!cuiles.length) {
    return [];
  }

  validarEmpresa(empresa);

  const cuilesNormalizados = [
    ...new Set(
      cuiles
        .map(cuil => String(cuil || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];

  if (!cuilesNormalizados.length) {
    return [];
  }

  const pool = await getSqlServerPool(empresa);
  const vendedores = [];

  console.log(
    `[VENDEDORES][${empresa}] Consultando ${cuilesNormalizados.length} CUIL individualmente`
  );

  for (const cuil of cuilesNormalizados) {
    console.log(
      `[VENDEDORES][${empresa}] Consultando CUIL ${cuil}`
    );

    const request = pool.request();

    request.input(
      "cuil",
      sql.VarChar(20),
      cuil
    );

    const result = await request.query(`
      SELECT
        vendedor,
        nombre,
        puesto,
        clave,
        cuil,
        locales,
        debaja,
        inhab,
        fe_ingreso,
        fe_egreso
      FROM vendedor
      WHERE RTRIM(cuil) = @cuil
    `);

    console.log(
      `[VENDEDORES][${empresa}] CUIL ${cuil}: ${result.recordset.length} resultado(s)`
    );

    for (const registro of result.recordset) {
      vendedores.push({
        vendedor: Number(registro.vendedor),
        nombre: registro.nombre?.trim() || "",
        puesto: registro.puesto?.trim() || "",
        clave: registro.clave ?? "",
        cuil: registro.cuil?.trim().toUpperCase() || "",
        locales: registro.locales?.trim() || "",
        debaja: Number(registro.debaja || 0),
        inhab: Number(registro.inhab || 0),
        fe_ingreso: registro.fe_ingreso || null,
        fe_egreso: registro.fe_egreso || null
      });
    }
  }

  console.log(
    `[VENDEDORES][${empresa}] Consulta Central finalizada: ${vendedores.length} vendedores`
  );

  return vendedores;
}
