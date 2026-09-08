export async function up(knex) {
  await knex.schema.alterTable("connections", (table) => {
    table.string("formato", 20);
  });

  await knex.raw(`
    ALTER TABLE connections
    ADD CONSTRAINT connections_formato_check
    CHECK (formato IS NULL OR formato = ANY (ARRAY['CALLE', 'MALL', 'SUPER', 'TERMINAL']))
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE connections
    DROP CONSTRAINT IF EXISTS connections_formato_check
  `);

  await knex.schema.alterTable("connections", (table) => {
    table.dropColumn("formato");
  });
}
