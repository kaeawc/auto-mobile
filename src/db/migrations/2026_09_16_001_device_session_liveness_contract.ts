import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.schema
      .alterTable("device_sessions")
      .addColumn("heartbeat_timeout_source", "text")
      .execute();
    await trx.schema.alterTable("device_sessions").addColumn("liveness_policy", "text").execute();
    await trx.schema
      .alterTable("device_sessions")
      .addColumn("pre_cli_heartbeat_timeout_ms", "integer")
      .execute();
    await trx.schema
      .alterTable("device_sessions")
      .addColumn("pre_cli_heartbeat_timeout_source", "text")
      .execute();
    await trx.schema
      .alterTable("device_sessions")
      .addColumn("pre_cli_session_timeout_ms", "integer")
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_sessions").dropColumn("pre_cli_session_timeout_ms").execute();
  await db.schema
    .alterTable("device_sessions")
    .dropColumn("pre_cli_heartbeat_timeout_source")
    .execute();
  await db.schema
    .alterTable("device_sessions")
    .dropColumn("pre_cli_heartbeat_timeout_ms")
    .execute();
  await db.schema.alterTable("device_sessions").dropColumn("liveness_policy").execute();
  await db.schema.alterTable("device_sessions").dropColumn("heartbeat_timeout_source").execute();
}
