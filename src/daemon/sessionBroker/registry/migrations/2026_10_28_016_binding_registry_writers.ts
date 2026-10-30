import type { Kysely } from "kysely";

/** Writer identity is recorded only for migrations executed after this table exists. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("binding_registry_migration_writers")
    .addColumn("migration_name", "text", (column) => column.primaryKey())
    .addColumn("writer_version", "text", (column) => column.notNull())
    .addColumn("recorded_at", "text", (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("binding_registry_migration_writers").ifExists().execute();
}
