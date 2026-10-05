export async function up(knex) {
  await knex.schema.createTable("gestion_instructivos", (table) => {
    table.bigIncrements("id").primary();

    table.bigInteger("gestion_id")
      .notNullable()
      .references("id")
      .inTable("gestiones")
      .onUpdate("CASCADE")
      .onDelete("CASCADE");

    table.string("nombre_archivo", 255).notNullable();
    table.integer("tamano").notNullable();
    table.binary("contenido").notNullable();

    table.integer("subido_por")
      .references("id")
      .inTable("users")
      .onUpdate("CASCADE")
      .onDelete("SET NULL");

    table.timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index("gestion_id");
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("gestion_instructivos");
}
