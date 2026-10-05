export async function up(knex) {
  await knex.schema.createTable("ayuda_documentos", (table) => {
    table.bigIncrements("id").primary();

    table.string("titulo", 200).notNullable();
    table.text("descripcion");
    table.string("categoria", 100);

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

    table.timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index("categoria");
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("ayuda_documentos");
}
