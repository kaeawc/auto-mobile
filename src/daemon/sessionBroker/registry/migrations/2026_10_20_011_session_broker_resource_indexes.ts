import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("session_broker_resources_request_id")
    .ifNotExists()
    .on("session_broker_resources")
    .column("request_id")
    .execute();
  await db.schema
    .createIndex("session_broker_requests_resource_id")
    .ifNotExists()
    .on("session_broker_requests")
    .column("resource_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("session_broker_requests_resource_id").ifExists().execute();
  await db.schema.dropIndex("session_broker_resources_request_id").ifExists().execute();
}
