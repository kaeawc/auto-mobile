import type { Kysely } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.alterTable("device_sessions").addColumn("liveness_owner_token", "text").execute();
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.alterTable("device_sessions").dropColumn("liveness_owner_token").execute();
}
