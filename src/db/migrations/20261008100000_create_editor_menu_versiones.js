export async function up(knex) {
  await knex.schema.createTable("editor_menu_versiones", (table) => {
    table.bigIncrements("id").primary();

    table.string("agregador", 30).notNullable();
    table.string("nombre_archivo", 255).notNullable();
    table.text("descripcion").notNullable();
    table.jsonb("cambios").notNullable().defaultTo("[]");
    table.integer("cantidad_imagenes").notNullable().defaultTo(0);

    table.text("contenido").notNullable();
    table.integer("tamano").notNullable();

    table.integer("subido_por")
      .references("id")
      .inTable("users")
      .onUpdate("CASCADE")
      .onDelete("SET NULL");

    table.timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index("created_at");
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("editor_menu_versiones");
}
