export async function up(knex) {
  await knex.schema.alterTable("scheduled_tasks", (table) => {
    table.string("tipo_accion", 30).notNullable().defaultTo("TOGGLE_ARTICULO");
    table.string("campo_objetivo", 50).defaultTo("invisibl");
    table.string("tabla_objetivo", 100);
  });

  await knex.raw(`
    ALTER TABLE scheduled_tasks ALTER COLUMN dia_activar DROP NOT NULL
  `);
  await knex.raw(`
    ALTER TABLE scheduled_tasks ALTER COLUMN dia_desactivar DROP NOT NULL
  `);

  await knex.schema.createTable("scheduled_task_empresas", (table) => {
    table.increments("id").primary();

    table.integer("task_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("scheduled_tasks")
      .onDelete("CASCADE");

    table.integer("empresa_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("empresas");

    table.unique(["task_id", "empresa_id"]);
  });

  // Las tareas 8 (Códigos quemables) y 9 (Distribución Vendedores) son entradas
  // "monitor": las ejecutan sus propios crons (tareaCodigosQuemables.js,
  // vendedorScheduler.js) y solo escriben resultados en scheduled_task_results
  // para verse en este módulo — no las debe tocar scheduledTaskRunner.js.
  const IDS_TAREAS_OTRO = [8, 9];

  await knex("scheduled_tasks")
    .whereIn("id", IDS_TAREAS_OTRO)
    .update({ tipo_accion: "OTRO" });

  // Backfill: hoy todas las demás tareas corren, hardcodeado, solo contra empresa_id = 2.
  const tareas = await knex("scheduled_tasks")
    .whereNotIn("id", IDS_TAREAS_OTRO)
    .select("id");

  if (tareas.length) {
    await knex("scheduled_task_empresas").insert(
      tareas.map((t) => ({ task_id: t.id, empresa_id: 2 }))
    );
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("scheduled_task_empresas");

  await knex.schema.alterTable("scheduled_tasks", (table) => {
    table.dropColumn("tipo_accion");
    table.dropColumn("campo_objetivo");
    table.dropColumn("tabla_objetivo");
  });
}
