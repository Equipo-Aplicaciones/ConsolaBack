export async function up(knex) {
  await knex.schema.alterTable("editor_menu_versiones", (table) => {
    table.jsonb("cambios_detalle").notNullable().defaultTo("[]");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("editor_menu_versiones", (table) => {
    table.dropColumn("cambios_detalle");
  });
}
