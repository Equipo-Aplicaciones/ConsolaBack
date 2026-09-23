export async function up(knex) {
  await knex.schema.alterTable("connections", (table) => {
    table.jsonb("caracteristicas").notNullable().defaultTo("{}");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("connections", (table) => {
    table.dropColumn("caracteristicas");
  });
}
