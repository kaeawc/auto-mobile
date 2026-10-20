import type { Kysely, Transaction } from "kysely";
import type { BindingRegistryDatabase } from "./registry/sqliteBindingRegistry";

/** Failed receipts occupy a session only while their exact resource is still owned and live. */
export async function countSessionAdmissions(
  db: Kysely<BindingRegistryDatabase> | Transaction<BindingRegistryDatabase>,
  requestId: string,
): Promise<number> {
  const row = await db
    .selectFrom("session_broker_requests")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("state", "!=", "released")
    .where("request_id", "!=", requestId)
    .where(({ or, eb, exists, selectFrom }) =>
      or([
        eb("state", "!=", "failed"),
        exists(
          selectFrom("session_broker_resources")
            .select("resource_id")
            .whereRef(
              "session_broker_resources.resource_id",
              "=",
              "session_broker_requests.resource_id",
            )
            .whereRef(
              "session_broker_resources.request_id",
              "=",
              "session_broker_requests.request_id",
            )
            .where("session_broker_resources.state", "!=", "destroyed"),
        ),
      ]),
    )
    .executeTakeFirstOrThrow();
  return row.count;
}
