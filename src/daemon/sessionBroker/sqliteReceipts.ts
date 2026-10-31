import type { Kysely, Transaction } from "kysely";
import { ActionableError } from "../../models/ActionableError";
import type { Timer } from "../../utils/SystemTimer";
import type { BindingRegistryDatabase } from "./registry/sqliteBindingRegistry";
import {
  SessionExportIdentityMismatchError,
  EXPORT_RETENTION_MS,
  type BrokerExportIdentity,
  type BrokerExportRecord,
} from "./store";

type Executor = Kysely<BindingRegistryDatabase> | Transaction<BindingRegistryDatabase>;
const TERMINAL_REQUEST_STATES = ["released", "failed"] as const;

export async function readExport(
  db: Executor,
  prepareId: string,
): Promise<BrokerExportRecord | undefined> {
  const row = await db
    .selectFrom("session_broker_exports")
    .selectAll()
    .where("prepare_id", "=", prepareId)
    .executeTakeFirst();
  return (
    row && {
      prepareId: row.prepare_id,
      requestId: row.request_id,
      requestDigest: row.request_digest,
      createdAtMs: row.created_at_ms,
      acknowledgedAtMs: row.acknowledged_at_ms,
    }
  );
}

export async function acknowledgeExport(
  db: Kysely<BindingRegistryDatabase>,
  prepareId: string,
  now: number,
): Promise<BrokerExportRecord | undefined> {
  await db
    .updateTable("session_broker_exports")
    .set({ acknowledged_at_ms: now })
    .where("prepare_id", "=", prepareId)
    .where("acknowledged_at_ms", "is", null)
    .execute();
  return readExport(db, prepareId);
}

/** Replay links without consulting the current catalog, after checking the receipt fingerprint. */
export async function linkRequestExport(
  db: Kysely<BindingRegistryDatabase>,
  now: number,
  requestId: string,
  { fingerprint, identity }: { fingerprint: string; identity: BrokerExportIdentity },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const request = await trx
      .selectFrom("session_broker_requests")
      .select("fingerprint")
      .where("request_id", "=", requestId)
      .executeTakeFirst();
    if (!request || request.fingerprint !== fingerprint) {
      throw new SessionExportIdentityMismatchError();
    }
    await linkExport(trx, requestId, identity, now);
  });
}

export async function linkExport(
  trx: Transaction<BindingRegistryDatabase>,
  requestId: string,
  identity: BrokerExportIdentity | undefined,
  now: number,
): Promise<void> {
  if (!identity) {
    return;
  }
  const rows = await trx
    .selectFrom("session_broker_exports")
    .selectAll()
    .where((eb) =>
      eb.or([eb("request_id", "=", requestId), eb("prepare_id", "=", identity.prepareId)]),
    )
    .execute();
  if (rows.length > 0) {
    if (
      rows.length !== 1 ||
      rows[0].request_id !== requestId ||
      rows[0].prepare_id !== identity.prepareId ||
      rows[0].request_digest !== identity.requestDigest
    ) {
      throw new SessionExportIdentityMismatchError();
    }
    return;
  }
  await trx
    .insertInto("session_broker_exports")
    .values({
      prepare_id: identity.prepareId,
      request_id: requestId,
      request_digest: identity.requestDigest,
      created_at_ms: now,
      acknowledged_at_ms: null,
    })
    .execute();
}

/**
 * Deletes terminal receipts that became terminal at least `retentionMs` ago and hold no
 * undestroyed resource, oldest first, at most `limit` per call. Their destroyed resource
 * tombstones go with them unless a retained receipt still names that resource. A receipt with
 * no terminal time (written before retention existed) is stamped now instead, so it gets a
 * full window. A pruned identity answers as unknown, exactly as one never seen.
 */
export async function pruneTerminalRequests(
  db: Kysely<BindingRegistryDatabase>,
  clock: Pick<Timer, "now">,
  retentionMs: number,
  { limit, exportRetentionMs = EXPORT_RETENTION_MS }: { limit: number; exportRetentionMs?: number },
): Promise<number> {
  if (
    !Number.isFinite(retentionMs) ||
    retentionMs < 0 ||
    !Number.isFinite(exportRetentionMs) ||
    exportRetentionMs < 0 ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    throw new ActionableError("Receipt retention needs a non-negative window and a positive limit");
  }
  return db.transaction().execute(async (trx) => {
    const now = clock.now();
    await trx
      .updateTable("session_broker_requests")
      .set({ terminal_at_ms: now })
      .where("state", "in", TERMINAL_REQUEST_STATES)
      .where("terminal_at_ms", "is", null)
      .execute();
    const expired = await trx
      .selectFrom("session_broker_requests")
      .select("request_id")
      .where("state", "in", TERMINAL_REQUEST_STATES)
      .where("terminal_at_ms", "<=", now - retentionMs)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("session_broker_exports")
              .select("prepare_id")
              .whereRef(
                "session_broker_exports.request_id",
                "=",
                "session_broker_requests.request_id",
              )
              .where("acknowledged_at_ms", "is", null)
              .where("created_at_ms", ">", now - exportRetentionMs),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("session_broker_resources")
              .select("session_broker_resources.resource_id")
              .whereRef(
                "session_broker_resources.request_id",
                "=",
                "session_broker_requests.request_id",
              )
              .where("session_broker_resources.state", "!=", "destroyed"),
          ),
        ),
      )
      .orderBy("terminal_at_ms")
      .orderBy("request_id")
      .limit(limit)
      .execute();
    const ids = expired.map((row) => row.request_id);
    if (ids.length === 0) {
      await deleteUnreferencedTombstones(trx);
      return 0;
    }
    await trx
      .updateTable("session_broker_resources")
      .set({ request_id: null })
      .where("request_id", "in", ids)
      .execute();
    await trx.deleteFrom("session_broker_exports").where("request_id", "in", ids).execute();
    await trx.deleteFrom("session_broker_requests").where("request_id", "in", ids).execute();
    await deleteUnreferencedTombstones(trx);
    return ids.length;
  });
}

/** Only receipts name destroyed resources; exports reference requests, not resources. */
export async function deleteUnreferencedTombstones(
  db: Executor,
  resourceId?: string,
): Promise<void> {
  await db
    .deleteFrom("session_broker_resources")
    .where("state", "=", "destroyed")
    .where("request_id", "is", null)
    .$if(resourceId !== undefined, (query) => query.where("resource_id", "=", resourceId!))
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("session_broker_requests")
            .select("request_id")
            .whereRef(
              "session_broker_requests.resource_id",
              "=",
              "session_broker_resources.resource_id",
            ),
        ),
      ),
    )
    .execute();
}
