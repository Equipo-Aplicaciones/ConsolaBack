export async function up(knex) {
  await knex.schema.alterTable("ayuda_documentos", (table) => {
    table.specificType("roles_visibles", "text[]")
      .notNullable()
      .defaultTo(knex.raw("'{}'"));
  });
}

export async function down(knex) {
  await knex.schema.alterTable("ayuda_documentos", (table) => {
    table.dropColumn("roles_visibles");
  });
}
