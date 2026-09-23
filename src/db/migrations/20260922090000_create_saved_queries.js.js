export async function up(knex) {
  await knex.schema.createTable("saved_queries", (table) => {
    table.increments("id").primary();

    table.string("nombre", 150).notNullable();
    table.text("descripcion");
    table.text("sql_text").notNullable();
    table.boolean("activo").notNullable().defaultTo(true);

    table.timestamps(true, true);
  });

  await knex.schema.createTable("saved_query_runs", (table) => {
    table.increments("id").primary();

    table.integer("saved_query_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("saved_queries")
      .onDelete("CASCADE");

    table.integer("connection_id")
      .unsigned()
      .references("id")
      .inTable("connections")
      .onDelete("SET NULL");

    table.string("username", 100);
    table.text("sql_ejecutado").notNullable();
    table.string("estado", 20).notNullable();
    table.text("mensaje");

    table.timestamp("created_at").defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("saved_query_runs");
  await knex.schema.dropTableIfExists("saved_queries");
}
