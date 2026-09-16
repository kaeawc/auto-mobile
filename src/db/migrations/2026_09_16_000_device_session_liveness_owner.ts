import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_sessions").addColumn("liveness_owner_token", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_sessions").dropColumn("liveness_owner_token").execute();
}
