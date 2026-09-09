export async function up(knex) {
  await knex.schema.alterTable("totem_estado_diario", (table) => {
    table.timestamp("hora_apagado", { useTz: true });
  });
}

export async function down(knex) {
  await knex.schema.alterTable("totem_estado_diario", (table) => {
    table.dropColumn("hora_apagado");
  });
}
