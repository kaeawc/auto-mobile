import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("installed_apps")
    .addColumn("metadata_json", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("installed_apps")
    .dropColumn("metadata_json")
    .execute();
}
