import type { Kysely, Transaction } from "kysely";
import type { BindingRegistryDatabase } from "./registry/sqliteBindingRegistry";
import type { BrokerResourceRecord } from "./store";

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

/** Non-destroyed resources in admission-selection shape; the caller decides compatibility. */
export function occupiedResources(resources: readonly BrokerResourceRecord[]) {
  return resources
    .filter((resource) => resource.state !== "destroyed")
    .map((resource) => ({
      id: resource.resourceId,
      state: resource.state as Exclude<BrokerResourceRecord["state"], "destroyed">,
      idleOrder: resource.idleOrder,
      compatible: false,
    }));
}
