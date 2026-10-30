// perfil_asignado: perfil (N1, N2 o Admin) al que se asigna la gestión; todos los usuarios de ese
// perfil la ven y la operan. Reemplaza al encargado por usuario (encargado_id queda sin uso).
// Las gestiones que ya tenían encargado pasan al perfil que ese usuario tiene hoy.
export async function up(knex) {
  await knex.schema.alterTable("gestiones", (table) => {
    table.string("perfil_asignado", 20).nullable();
    table.index("perfil_asignado");
  });

  await knex.raw(`
    UPDATE gestiones g
    SET perfil_asignado = u.role
    FROM users u
    WHERE u.id = g.encargado_id
      AND u.role IN ('N1', 'N2', 'Admin')
  `);
}

export async function down(knex) {
  await knex.schema.alterTable("gestiones", (table) => {
    table.dropIndex("perfil_asignado");
    table.dropColumn("perfil_asignado");
  });
}
