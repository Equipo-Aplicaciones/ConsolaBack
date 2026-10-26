// roles_ejecutan: roles (además de Admin, que siempre puede) que pueden ejecutar esta consulta
// desde el Panel de Gestión. Vacío = solo Admin.
export async function up(knex) {
  await knex.schema.alterTable("saved_queries", (table) => {
    table.specificType("roles_ejecutan", "text[]")
      .notNullable()
      .defaultTo(knex.raw("'{}'"));
  });
}

export async function down(knex) {
  await knex.schema.alterTable("saved_queries", (table) => {
    table.dropColumn("roles_ejecutan");
  });
}
