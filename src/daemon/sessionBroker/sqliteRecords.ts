import type { Kysely, Selectable, Transaction } from "kysely";
import type { BindingRegistryDatabase } from "./registry/sqliteBindingRegistry";
import type { BindingProcessIdentity } from "./registry/bindingRegistry";
import type {
  BrokerRequestsTable,
  BrokerResourcesTable,
  BrokerRequestRecord,
  BrokerResourceRecord,
} from "./store";
import { parseTimingReceipt } from "./timingSchema";

type Executor = Kysely<BindingRegistryDatabase> | Transaction<BindingRegistryDatabase>;

export async function readRequest(
  db: Executor,
  requestId: string,
): Promise<BrokerRequestRecord | undefined> {
  const row = await db
    .selectFrom("session_broker_requests")
    .selectAll()
    .where("request_id", "=", requestId)
    .executeTakeFirst();
  return row && requestRecord(row);
}

export async function readResource(
  db: Executor,
  resourceId: string,
): Promise<BrokerResourceRecord | undefined> {
  const row = await db
    .selectFrom("session_broker_resources")
    .selectAll()
    .where("resource_id", "=", resourceId)
    .executeTakeFirst();
  return row && resourceRecord(row);
}

export function requestRecord(row: Selectable<BrokerRequestsTable>): BrokerRequestRecord {
  const receipt = row.timing_json
    ? parseTimingReceipt(row.timing_json, row.timing_profile_json)
    : undefined;
  const { restartHandoff, ...owner } = JSON.parse(row.owner_json) as BindingProcessIdentity & {
    restartHandoff?: unknown;
  };
  return {
    requestId: row.request_id,
    fingerprint: row.fingerprint,
    parameters: JSON.parse(row.parameters_json),
    owner,
    ...(restartHandoff === true ? { restartHandoff: true as const } : {}),
    state: row.state,
    resourceId: row.resource_id,
    sessionId: row.session_id,
    error: row.error,
    errorCode: row.error_code,
    retryable: row.retryable === 1,
    ...(receipt ? { timing: receipt.timing, timingProfile: receipt.profile } : {}),
  };
}

export function resourceRecord(row: Selectable<BrokerResourcesTable>): BrokerResourceRecord {
  return {
    resourceId: row.resource_id,
    allocationIndex: row.allocation_index,
    scopeKey: row.scope_key,
    profile: JSON.parse(row.profile_json),
    state: row.state,
    requestId: row.request_id,
    revision: row.revision,
    idleOrder: row.idle_order,
    reuseCount: row.reuse_count,
  };
}
