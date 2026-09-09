export async function up(knex) {
  await knex.schema.alterTable("gestiones", table => {
    table
      .integer("encargado_id")
      .nullable()
      .references("id")
      .inTable("users")
      .onDelete("SET NULL");

    table.index("encargado_id");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("gestiones", table => {
    table.dropIndex("encargado_id");
    table.dropColumn("encargado_id");
  });
}