// Incidencias por local (falla de base de datos, cambio de IIS, etc.) y su seguimiento.
export async function up(knex) {
  await knex("estados").insert([
    { codigo: "ABIERTA", nombre: "Abierta", grupo: "INCIDENCIA", orden: 1 },
    { codigo: "EN_SEGUIMIENTO", nombre: "En seguimiento", grupo: "INCIDENCIA", orden: 2 },
    { codigo: "RESUELTA", nombre: "Resuelta", grupo: "INCIDENCIA", orden: 3 }
  ]);

  await knex.schema.createTable("incidencias", (table) => {
    table.bigIncrements("id").primary();

    table.integer("connection_id")
      .notNullable()
      .references("id")
      .inTable("connections")
      .onUpdate("CASCADE")
      .onDelete("RESTRICT");

    table.string("titulo", 200).notNullable();
    table.text("descripcion");
    table.string("categoria", 100);

    table.integer("estado_id")
      .notNullable()
      .references("id")
      .inTable("estados")
      .onUpdate("CASCADE")
      .onDelete("RESTRICT");

    // Cuándo ocurrió (puede ser anterior al registro)
    table.timestamp("fecha_incidencia", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.timestamp("resuelta_at", { useTz: true });

    table.integer("creado_por")
      .references("id")
      .inTable("users")
      .onUpdate("CASCADE")
      .onDelete("SET NULL");

    table.timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index("connection_id");
    table.index("estado_id");
    table.index("categoria");
  });

  await knex.schema.createTable("incidencia_seguimientos", (table) => {
    table.bigIncrements("id").primary();

    table.bigInteger("incidencia_id")
      .notNullable()
      .references("id")
      .inTable("incidencias")
      .onUpdate("CASCADE")
      .onDelete("CASCADE");

    table.text("comentario").notNullable();

    // Estado al que pasó la incidencia con este seguimiento (null = no cambió)
    table.integer("estado_id")
      .references("id")
      .inTable("estados")
      .onUpdate("CASCADE")
      .onDelete("SET NULL");

    table.integer("usuario_id")
      .references("id")
      .inTable("users")
      .onUpdate("CASCADE")
      .onDelete("SET NULL");

    table.timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index("incidencia_id");
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("incidencia_seguimientos");
  await knex.schema.dropTableIfExists("incidencias");
  await knex("estados").where({ grupo: "INCIDENCIA" }).delete();
}
