// usuario_id: destinatario de una notificación personal. Si es NULL, la notificación sigue
// siendo por rol (según su url), como hasta ahora.
export async function up(knex) {
  await knex.schema.alterTable("notificaciones", (table) => {
    table.integer("usuario_id")
      .nullable()
      .references("id")
      .inTable("users")
      .onUpdate("CASCADE")
      .onDelete("CASCADE");

    table.index(["usuario_id"], "idx_notificaciones_usuario_id");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("notificaciones", (table) => {
    table.dropIndex(["usuario_id"], "idx_notificaciones_usuario_id");
    table.dropColumn("usuario_id");
  });
}
