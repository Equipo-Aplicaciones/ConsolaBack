export async function up(knex) {
  await knex.schema.createTable("ayuda_contactos", (table) => {
    table.bigIncrements("id").primary();

    table.string("nombre", 200).notNullable();
    table.string("telefono", 80).notNullable();
    table.string("link", 500);
    table.text("descripcion");

    table.specificType("roles_visibles", "text[]")
      .notNullable()
      .defaultTo(knex.raw("'{}'"));

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
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("ayuda_contactos");
}
