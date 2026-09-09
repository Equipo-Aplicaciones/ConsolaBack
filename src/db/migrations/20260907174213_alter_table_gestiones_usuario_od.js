export async function up(knex) {
  await knex.schema.alterTable("gestiones", table => {
    table
      .integer("usuario_id")
      .nullable()
      .references("id")
      .inTable("users")
      .onDelete("SET NULL");

    table.index("usuario_id");
  });
};

export async function down(knex) {
  await knex.schema.alterTable("gestiones", table => {
    table.dropIndex("usuario_id");
    table.dropColumn("usuario_id");
  });
};