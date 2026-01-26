import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add screenshot_path column to navigation_nodes table
  await db.schema
    .alterTable("navigation_nodes")
    .addColumn("screenshot_path", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // SQLite doesn't support dropping columns directly, so we need to recreate the table
  // For simplicity, we'll use a workaround since SQLite 3.35.0+ supports DROP COLUMN
  await db.schema
    .alterTable("navigation_nodes")
    .dropColumn("screenshot_path")
    .execute();
}
