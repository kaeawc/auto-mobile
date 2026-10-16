import type { Kysely, Selectable, Transaction } from "kysely";
import {
  SESSION_OWNER_EXITED_CODE,
  SESSION_OWNER_EXITED_MESSAGE,
  type SessionBrokerFailure,
} from "../../devices/sessionBrokerResult";
import { ActionableError } from "../../models/ActionableError";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { BindingRegistryDatabase } from "./registry/sqliteBindingRegistry";
import type { BindingExecOwnerLiveness, BindingProcessIdentity } from "./registry/bindingRegistry";
import { chooseIdleEvictions, selectAdmission, type BrokerLimits } from "./admission";
import {
  abandonedRequestIdentity,
  SESSION_REQUEST_ABANDONED_CODE,
  SESSION_REQUEST_ABANDONED_MESSAGE,
  sessionRequestFingerprint,
} from "./requestIdentity";
import {
  destructionTicket,
  type BrokerAbandonment,
  type BrokerAdmission,
  type BrokerAdmissionInput,
  type BrokerRequestRecord,
  type BrokerRequestsTable,
  type BrokerResourceRecord,
  type BrokerResourcesTable,
  type DestructionTicket,
} from "./store";

type Executor = Kysely<BindingRegistryDatabase> | Transaction<BindingRegistryDatabase>;

const TERMINAL_REQUEST_STATES = ["released", "failed"] as const;

function isTerminalState(state: BrokerRequestsTable["state"] | undefined): boolean {
  return state === "released" || state === "failed";
}

function requestRecord(row: Selectable<BrokerRequestsTable>): BrokerRequestRecord {
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
  };
}

function resourceRecord(row: Selectable<BrokerResourcesTable>): BrokerResourceRecord {
  return {
    resourceId: row.resource_id,
    allocationIndex: row.allocation_index,
    scopeKey: row.scope_key,
    profile: JSON.parse(row.profile_json),
    state: row.state,
    requestId: row.request_id,
    revision: row.revision,
    idleOrder: row.idle_order,
  };
}

function sameOwner(left: BindingProcessIdentity, right: BindingProcessIdentity): boolean {
  return (
    left.daemonId === right.daemonId &&
    left.pid === right.pid &&
    left.processGenerationToken === right.processGenerationToken
  );
}

function ownsReadyBinding(
  binding: Selectable<BindingRegistryDatabase["slot_assignments"]> | undefined,
  sessionId: string,
  owner: BindingProcessIdentity,
): boolean {
  return Boolean(
    binding?.stable_device_id &&
    binding.state === "ready" &&
    binding.exec_session_uuid === sessionId &&
    binding.exec_owner_daemon_id === owner.daemonId &&
    binding.exec_owner_pid === owner.pid &&
    binding.exec_owner_process_token === (owner.processGenerationToken ?? null),
  );
}

function ownerIdentity(owner: BindingProcessIdentity): BindingProcessIdentity {
  return {
    daemonId: owner.daemonId,
    pid: owner.pid,
    ...(owner.processGenerationToken === undefined
      ? {}
      : { processGenerationToken: owner.processGenerationToken }),
  };
}

function requireValue<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    throw new ActionableError(message);
  }
  return value;
}

function occupiedResources(resources: readonly BrokerResourceRecord[]) {
  return resources
    .filter((resource) => resource.state !== "destroyed")
    .map((resource) => ({
      id: resource.resourceId,
      state: resource.state as Exclude<BrokerResourceRecord["state"], "destroyed">,
      idleOrder: resource.idleOrder,
      compatible: false,
    }));
}

/**
 * Durable reservation and receipt layer of the host registry. Physical device ownership remains
 * in its assignment rows and native work remains in its journal. Every mutation uses that same
 * BEGIN IMMEDIATE transaction boundary. No platform work or awaitable predicate runs inside it.
 *
 * A destroyed row is a tombstone, not a free allocation binding. Physical reuse only happens through
 * a clean idle row and always receives a new request/session binding. Recovery never promotes an
 * interrupted resource to idle.
 */
export class SqliteSessionBrokerStore {
  constructor(
    private readonly db: Kysely<BindingRegistryDatabase>,
    private readonly scopeKey: string,
    private readonly isOwnerLive: BindingExecOwnerLiveness,
    private readonly ids: IdGenerator = defaultIdGenerator,
    private readonly clock: Pick<Timer, "now"> = defaultTimer,
  ) {}

  async getRequest(requestId: string): Promise<BrokerRequestRecord | undefined> {
    return this.readRequest(this.db, requestId);
  }

  async getSession(sessionId: string): Promise<BrokerRequestRecord | undefined> {
    const row = await this.db
      .selectFrom("session_broker_requests")
      .selectAll()
      .where("session_id", "=", sessionId)
      .executeTakeFirst();
    return row && requestRecord(row);
  }

  async listResources(): Promise<BrokerResourceRecord[]> {
    return this.readResources(this.db);
  }

  async listRequests(): Promise<BrokerRequestRecord[]> {
    const rows = await this.db.selectFrom("session_broker_requests").selectAll().execute();
    return rows.map(requestRecord);
  }

  /**
   * The receipts a recovery pass can still act on, read without a write transaction: every
   * non-terminal request, plus an abandoned one whose granted session may still need draining
   * because its device is not yet confirmed destroyed. Settled terminal receipts are skipped, so
   * the pass costs nothing per finished request however many accumulate.
   */
  async listRecoverableRequests(): Promise<BrokerRequestRecord[]> {
    const rows = await this.db
      .selectFrom("session_broker_requests")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("state", "not in", TERMINAL_REQUEST_STATES),
          eb.and([
            eb("state", "=", "failed"),
            eb("error_code", "=", SESSION_REQUEST_ABANDONED_CODE),
            eb("session_id", "is not", null),
            eb.exists(
              eb
                .selectFrom("session_broker_resources")
                .select("session_broker_resources.resource_id")
                .whereRef(
                  "session_broker_resources.resource_id",
                  "=",
                  "session_broker_requests.resource_id",
                )
                .where("session_broker_resources.state", "!=", "destroyed"),
            ),
          ]),
        ]),
      )
      .execute();
    return rows.map(requestRecord);
  }

  /**
   * Deletes terminal receipts that became terminal at least `retentionMs` ago and hold no
   * undestroyed resource, oldest first, at most `limit` per call. Their destroyed resource
   * tombstones go with them unless a retained receipt still names that resource. A receipt with
   * no terminal time (written before retention existed) is stamped now instead, so it gets a
   * full window. A pruned identity answers as unknown, exactly as one never seen.
   */
  async pruneTerminalRequests(retentionMs: number, limit: number): Promise<number> {
    if (!Number.isFinite(retentionMs) || retentionMs < 0 || !Number.isInteger(limit) || limit < 1) {
      throw new ActionableError(
        "Receipt retention needs a non-negative window and a positive limit",
      );
    }
    return this.db.transaction().execute(async (trx) => {
      const now = this.clock.now();
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
        return 0;
      }
      // Tombstones still named by a retained receipt keep answering its profile.
      await trx
        .deleteFrom("session_broker_resources")
        .where("request_id", "in", ids)
        .where("state", "=", "destroyed")
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("session_broker_requests")
                .select("session_broker_requests.request_id")
                .whereRef(
                  "session_broker_requests.resource_id",
                  "=",
                  "session_broker_resources.resource_id",
                )
                .where("session_broker_requests.request_id", "not in", ids),
            ),
          ),
        )
        .execute();
      await trx
        .updateTable("session_broker_resources")
        .set({ request_id: null })
        .where("request_id", "in", ids)
        .execute();
      await trx.deleteFrom("session_broker_requests").where("request_id", "in", ids).execute();
      return ids.length;
    });
  }

  /** A failed catalog/default lookup consumes its operation identity without consuming capacity. */
  async recordPreAdmissionFailure(
    input: Pick<BrokerAdmissionInput, "requestId" | "fingerprint" | "parameters" | "owner">,
    failure: SessionBrokerFailure,
  ): Promise<BrokerRequestRecord> {
    if (!input.requestId.trim() || !input.fingerprint.trim()) {
      throw new ActionableError("Session request identity and fingerprint must be non-empty");
    }
    return this.db.transaction().execute(async (trx) => {
      const previous = await this.readRequest(trx, input.requestId);
      if (previous) {
        if (previous.fingerprint !== input.fingerprint) {
          throw new ActionableError(
            "Session request identity was already used with different parameters",
          );
        }
        return previous;
      }
      const row = await trx
        .insertInto("session_broker_requests")
        .values({
          request_id: input.requestId,
          fingerprint: input.fingerprint,
          parameters_json: JSON.stringify(input.parameters),
          owner_json: JSON.stringify(input.owner),
          state: "failed",
          resource_id: null,
          session_id: null,
          error: failure.message,
          error_code: failure.code,
          retryable: failure.retryable ? 1 : 0,
          terminal_at_ms: this.clock.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return requestRecord(row);
    });
  }

  async admit(input: BrokerAdmissionInput): Promise<BrokerAdmission> {
    if (!input.requestId.trim() || !input.fingerprint.trim()) {
      throw new ActionableError("Session request identity and fingerprint must be non-empty");
    }
    return this.db.transaction().execute(async (trx) => {
      const previous = await this.readRequest(trx, input.requestId);
      if (previous) {
        if (previous.fingerprint !== input.fingerprint) {
          throw new ActionableError(
            "Session request identity was already used with different parameters",
          );
        }
        return { kind: "existing", request: previous };
      }
      const row = await trx
        .insertInto("session_broker_requests")
        .values({
          request_id: input.requestId,
          fingerprint: input.fingerprint,
          parameters_json: JSON.stringify(input.parameters),
          owner_json: JSON.stringify(input.owner),
          state: "acquiring",
          resource_id: null,
          session_id: null,
          error: null,
          error_code: null,
          retryable: null,
          terminal_at_ms: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.reserve(trx, requestRecord(row), input);
    });
  }

  /**
   * Atomically consumes an uncommitted identity or terminalizes its current allocation. The
   * consumer token is checked against the original parameters, while an absent identity gets an
   * internal token-bound receipt that a later prepare cannot turn into an allocation.
   */
  async abandon(
    requestId: string,
    owner: BindingProcessIdentity,
    livenessOwnerToken: string,
  ): Promise<BrokerAbandonment> {
    if (!requestId.trim() || !livenessOwnerToken) {
      throw new ActionableError("Session request identity and liveness owner token are required");
    }
    return this.db.transaction().execute(async (trx) => {
      const previous = await this.readRequest(trx, requestId);
      if (!previous) {
        const tombstone = abandonedRequestIdentity(livenessOwnerToken);
        const row = await trx
          .insertInto("session_broker_requests")
          .values({
            request_id: requestId,
            fingerprint: tombstone.fingerprint,
            parameters_json: JSON.stringify(tombstone.parameters),
            owner_json: JSON.stringify(owner),
            state: "failed",
            resource_id: null,
            session_id: null,
            error: SESSION_REQUEST_ABANDONED_MESSAGE,
            error_code: SESSION_REQUEST_ABANDONED_CODE,
            retryable: 0,
            terminal_at_ms: this.clock.now(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { request: requestRecord(row) };
      }
      if (
        previous.fingerprint !== sessionRequestFingerprint(previous.parameters, livenessOwnerToken)
      ) {
        throw new ActionableError("Session request belongs to another liveness owner");
      }
      if (previous.state === "released" || previous.state === "failed") {
        return {
          request: previous,
          ...(await this.currentDestructionTicket(trx, previous)),
        };
      }
      if (!sameOwner(previous.owner, owner)) {
        throw new ActionableError("Session request belongs to another daemon process generation");
      }
      let ticket: DestructionTicket | undefined;
      if (previous.resourceId) {
        const resource = await this.ownedResource(trx, previous);
        if (resource.state !== "destroyed") {
          const destroying =
            resource.state === "destroying"
              ? resource
              : await this.updateResource(trx, resource, { state: "destroying" });
          ticket = destructionTicket(destroying);
        }
      }
      const request = await this.updateRequest(trx, requestId, {
        state: "failed",
        error: SESSION_REQUEST_ABANDONED_MESSAGE,
        error_code: SESSION_REQUEST_ABANDONED_CODE,
        retryable: 0,
      });
      return { request, ...(ticket ? { ticket } : {}) };
    });
  }

  /** Only the owner of a pending eviction may resume, after its resource is confirmed absent. */
  async continueAdmission(input: BrokerAdmissionInput): Promise<BrokerAdmission> {
    return this.db.transaction().execute(async (trx) => {
      const request = await this.ownedRequest(trx, input.requestId, input.owner);
      if (request.fingerprint !== input.fingerprint || request.state !== "acquiring") {
        throw new ActionableError("Cannot continue a changed or terminal session request");
      }
      const resource = requireValue(
        await this.readResource(
          trx,
          requireValue(request.resourceId, "No admission eviction to resume"),
        ),
        "Admission resource disappeared",
      );
      if (resource.state !== "destroyed" || resource.requestId !== request.requestId) {
        throw new ActionableError(
          "Admission must wait for confirmed eviction before reserving another device",
        );
      }
      return this.reserve(trx, request, input);
    });
  }

  async activate(
    requestId: string,
    owner: BindingProcessIdentity,
    sessionId: string,
  ): Promise<BrokerRequestRecord> {
    if (!sessionId.trim()) {
      throw new ActionableError("A prepared session must have a non-empty session UUID");
    }
    return this.db.transaction().execute(async (trx) => {
      const request = await this.ownedRequest(trx, requestId, owner);
      if (request.state === "active" && request.sessionId === sessionId) {
        return request;
      }
      const resource = await this.ownedResource(trx, request);
      if (request.state !== "acquiring" || resource.state !== "reserved") {
        throw new ActionableError("Only the current acquiring request can activate a reservation");
      }
      const binding = await trx
        .selectFrom("slot_assignments")
        .selectAll()
        .where("scope_key", "=", resource.scopeKey)
        .where("slot_index", "=", resource.allocationIndex)
        .executeTakeFirst();
      if (!ownsReadyBinding(binding, sessionId, owner)) {
        throw new ActionableError(
          "Prepared session does not own the current physical device binding",
        );
      }
      await this.updateResource(trx, resource, { state: "active" });
      return this.updateRequest(trx, requestId, { state: "active", session_id: sessionId });
    });
  }

  async beginRelease(
    sessionId: string,
    owner: BindingProcessIdentity,
  ): Promise<BrokerRequestRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("session_broker_requests")
        .selectAll()
        .where("session_id", "=", sessionId)
        .executeTakeFirst();
      if (!row) {
        return undefined;
      }
      // Terminal receipts survive provider restart. Reading a committed release is not a new
      // mutation and must not require the dead daemon to own it again.
      if (row.state === "released" || row.state === "failed") {
        return requestRecord(row);
      }
      const request = await this.ownedRequest(trx, row.request_id, owner);
      if (request.state !== "active") {
        return request;
      }
      const resource = await this.ownedResource(trx, request);
      if (resource.state !== "active") {
        throw new ActionableError("Active session lost its resource ownership");
      }
      await this.updateResource(trx, resource, { state: "resetting" });
      return this.updateRequest(trx, request.requestId, { state: "releasing" });
    });
  }

  /**
   * Called only after all session work is joined and a clean baseline has been verified. The
   * native adapter must supply that proof; command success alone is insufficient. Terminal
   * receipt and idle/cleanup ownership are committed together.
   */
  async completeCleanRelease(
    requestId: string,
    owner: BindingProcessIdentity,
    limits: BrokerLimits,
  ): Promise<readonly DestructionTicket[]> {
    return this.db.transaction().execute(async (trx) => {
      const request = await this.ownedRequest(trx, requestId, owner);
      if (request.state === "released") {
        return [];
      }
      const resource = await this.ownedResource(trx, request);
      if (request.state !== "releasing" || resource.state !== "resetting") {
        throw new ActionableError("Only a joined, resetting session can return a clean device");
      }
      const binding = await trx
        .selectFrom("slot_assignments")
        .selectAll()
        .where("scope_key", "=", resource.scopeKey)
        .where("slot_index", "=", resource.allocationIndex)
        .executeTakeFirst();
      const journal = await this.openJournal(trx, resource);
      if (
        !binding?.stable_device_id ||
        binding.state !== "ready" ||
        binding.exec_session_uuid ||
        journal
      ) {
        throw new ActionableError(
          "Physical device still has execution or journal work; it cannot enter the idle pool",
        );
      }
      const resources = await this.readResources(trx);
      const idleOrder = Math.max(0, ...resources.map((entry) => entry.idleOrder)) + 1;
      await this.updateResource(trx, resource, {
        state: "idle",
        request_id: null,
        idle_order: idleOrder,
      });
      await this.updateRequest(trx, requestId, { state: "released" });
      return this.trimIdle(trx, limits);
    });
  }

  /** Failure is terminal for the request, but keeps a discoverable destruction obligation. */
  async fail(
    requestId: string,
    owner: BindingProcessIdentity,
    error: string,
    errorCode = "session_preparation_failed",
    retryable = false,
  ): Promise<DestructionTicket | undefined> {
    return this.failWhere(requestId, owner, { error, errorCode, retryable });
  }

  /**
   * Terminalizes an acquisition that ended without committing, decided in the same transaction
   * as the write: a recovery pass's earlier snapshot must never fail a request whose preparation
   * has since activated it.
   */
  async failInterruptedAcquisition(
    requestId: string,
    owner: BindingProcessIdentity,
    error: string,
  ): Promise<DestructionTicket | undefined> {
    return this.failWhere(requestId, owner, {
      error,
      errorCode: "session_preparation_failed",
      retryable: false,
      onlyFrom: "acquiring",
    });
  }

  private async failWhere(
    requestId: string,
    owner: BindingProcessIdentity,
    failure: {
      error: string;
      errorCode: string;
      retryable: boolean;
      onlyFrom?: BrokerRequestRecord["state"];
    },
  ): Promise<DestructionTicket | undefined> {
    const { error, errorCode, retryable, onlyFrom } = failure;
    return this.db.transaction().execute(async (trx) => {
      const request = await this.ownedRequest(trx, requestId, owner);
      if (
        request.state === "released" ||
        request.state === "failed" ||
        (onlyFrom !== undefined && request.state !== onlyFrom)
      ) {
        return undefined;
      }
      let ticket: DestructionTicket | undefined;
      if (request.resourceId) {
        const resource = await this.ownedResource(trx, request);
        if (resource.state !== "destroyed") {
          ticket = destructionTicket(
            await this.updateResource(trx, resource, { state: "destroying" }),
          );
        }
      }
      await this.updateRequest(trx, requestId, {
        state: "failed",
        error,
        error_code: errorCode,
        retryable: retryable ? 1 : 0,
      });
      return ticket;
    });
  }

  /** Zero-pool release follows the same durable cleanup path, without pretending it was clean. */
  async releaseByDestruction(
    requestId: string,
    owner: BindingProcessIdentity,
  ): Promise<DestructionTicket | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const request = await this.ownedRequest(trx, requestId, owner);
      if (request.state === "released" || request.state === "failed") {
        return undefined;
      }
      if (request.state !== "releasing") {
        throw new ActionableError("Session must relinquish its execution before destruction");
      }
      const resource = await this.ownedResource(trx, request);
      if (resource.state === "destroying") {
        return destructionTicket(resource);
      }
      return destructionTicket(await this.updateResource(trx, resource, { state: "destroying" }));
    });
  }

  /**
   * The existing native journal must have confirmed authoritative absence and cleared the
   * physical binding. An old deletion receipt cannot free a new incarnation of a resource.
   */
  async confirmDestroyed(ticket: DestructionTicket): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const resource = await this.readResource(trx, ticket.resourceId);
      if (!resource || resource.revision !== ticket.revision) {
        return false;
      }
      if (resource.state === "destroyed") {
        return true;
      }
      if (resource.state !== "destroying") {
        return false;
      }
      if (await this.physicalWorkPending(trx, resource)) {
        return false;
      }
      // Keep the revision so replaying exactly this confirmed destruction is idempotent.
      await trx
        .updateTable("session_broker_resources")
        .set({ state: "destroyed" })
        .where("resource_id", "=", resource.resourceId)
        .execute();
      if (resource.requestId) {
        await this.settleRequestAfterDestruction(trx, resource);
      }
      return true;
    });
  }

  /**
   * Recovery first takes durable ownership, fences the prior owner, and requires destruction.
   * A live or uncertain owner is retained. The caller must bound uncertainty and arrange another
   * recovery pass, never infer an idle device from process exit.
   */
  async recoverRequest(
    requestId: string,
    owner: BindingProcessIdentity,
  ): Promise<DestructionTicket | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const request = requireValue(
        await this.readRequest(trx, requestId),
        "Unknown session request",
      );
      if (sameOwner(request.owner, owner) || this.isOwnerLive(request.owner)) {
        return undefined;
      }
      if (request.state === "released" || request.state === "failed") {
        return undefined;
      }
      let ticket: DestructionTicket | undefined;
      if (request.resourceId) {
        const resource = await this.ownedResource(trx, request);
        if (resource.state !== "destroyed") {
          ticket = destructionTicket(
            await this.updateResource(trx, resource, { state: "destroying" }),
          );
        }
      }
      await this.updateRequest(trx, requestId, {
        owner_json: JSON.stringify(owner),
        state: "failed",
        error: SESSION_OWNER_EXITED_MESSAGE,
        error_code: SESSION_OWNER_EXITED_CODE,
      });
      return ticket;
    });
  }

  /**
   * Graceful shutdown keeps an active session's device for the restarted provider (#12451). The
   * request stays active and owned by this process; the durable mark tells the successor that the
   * owner relinquished it on purpose, which a crashed owner never records.
   */
  async relinquishForRestart(
    requestId: string,
    owner: BindingProcessIdentity,
  ): Promise<BrokerRequestRecord> {
    return this.db.transaction().execute(async (trx) => {
      const request = await this.ownedRequest(trx, requestId, owner);
      if (request.state !== "active" || request.restartHandoff) {
        return request;
      }
      return this.updateRequest(trx, requestId, {
        owner_json: JSON.stringify({ ...ownerIdentity(request.owner), restartHandoff: true }),
      });
    });
  }

  /**
   * A successor adopts a gracefully relinquished session only once the native layer has re-owned
   * its exact binding for the same session UUID. Until then the receipt is left untouched for a
   * later pass; it is never converted into a release or a replacement device.
   */
  async adoptRestartHandoff(
    requestId: string,
    owner: BindingProcessIdentity,
  ): Promise<"adopted" | "pending" | "not-handoff"> {
    return this.db.transaction().execute(async (trx) => {
      const request = requireValue(
        await this.readRequest(trx, requestId),
        "Unknown session request",
      );
      if (!request.restartHandoff || request.state !== "active" || !request.sessionId) {
        return "not-handoff";
      }
      if (sameOwner(request.owner, owner)) {
        return "adopted";
      }
      if (this.isOwnerLive(request.owner)) {
        return "pending";
      }
      const resource = await this.ownedResource(trx, request);
      const binding = await trx
        .selectFrom("slot_assignments")
        .selectAll()
        .where("scope_key", "=", resource.scopeKey)
        .where("slot_index", "=", resource.allocationIndex)
        .executeTakeFirst();
      if (resource.state !== "active" || !ownsReadyBinding(binding, request.sessionId, owner)) {
        return "pending";
      }
      await this.updateRequest(trx, requestId, {
        owner_json: JSON.stringify(ownerIdentity(owner)),
      });
      return "adopted";
    });
  }

  private async settleRequestAfterDestruction(
    trx: Transaction<BindingRegistryDatabase>,
    resource: BrokerResourceRecord,
  ): Promise<void> {
    const request = await this.readRequest(trx, requireValue(resource.requestId, "No request"));
    if (request?.resourceId !== resource.resourceId) {
      return;
    }
    if (request.state === "releasing") {
      await this.updateRequest(trx, request.requestId, { state: "released" });
    } else if (request.state === "failed") {
      // Confirmed cleanup changes the receipt's answer, so its replay window restarts here.
      await trx
        .updateTable("session_broker_requests")
        .set({ terminal_at_ms: this.clock.now() })
        .where("request_id", "=", request.requestId)
        .execute();
    }
  }

  private async reserve(
    trx: Transaction<BindingRegistryDatabase>,
    request: BrokerRequestRecord,
    input: BrokerAdmissionInput,
  ): Promise<BrokerAdmission> {
    const resources = await this.readResources(trx);
    const active = await trx
      .selectFrom("session_broker_requests")
      .select(["request_id", "state", "resource_id"])
      .where("state", "!=", "released")
      .where("request_id", "!=", request.requestId)
      .execute();
    // A failed request may still have a live native session or ambiguous creation. Retain its
    // session admission as well as its device admission until cleanup is confirmed.
    const sessionCount = active.filter(
      (entry) =>
        entry.state !== "failed" ||
        resources.some(
          (resource) =>
            resource.resourceId === entry.resource_id &&
            resource.requestId === entry.request_id &&
            resource.state !== "destroyed",
        ),
    ).length;
    const decision = selectAdmission(
      {
        activeOrAcquiringSessions: sessionCount,
        resources: occupiedResources(resources).map((resource) => ({
          ...resource,
          compatible:
            resource.state === "idle" &&
            input.matches(
              requireValue(
                resources.find((entry) => entry.resourceId === resource.id),
                "Missing resource",
              ).profile,
            ),
        })),
      },
      input.limits,
    );
    if (decision.kind === "refuse") {
      return {
        kind: "refused",
        reason: decision.reason,
        request: await this.updateRequest(trx, request.requestId, {
          state: "failed",
          error: decision.reason,
          error_code: "capacity_exhausted",
          // Capacity frees up; the stored refusal itself never changes, so the retry needs a new ID.
          retryable: 1,
        }),
      };
    }
    let resource: BrokerResourceRecord;
    // Resolve before eviction too: an impossible creation request must not destroy a useful
    // idle device. A cache hit never depends on creation defaults being installed.
    const creationProfile = decision.kind === "reuse" ? undefined : input.resolveCreation();
    if (decision.kind === "create") {
      const row = await trx
        .insertInto("session_broker_resources")
        .values({
          resource_id: this.ids.next(),
          scope_key: this.scopeKey,
          profile_json: JSON.stringify(creationProfile),
          state: "reserved",
          request_id: request.requestId,
          revision: 1,
          idle_order: 0,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      resource = resourceRecord(row);
    } else {
      const selected = requireValue(
        resources.find((entry) => entry.resourceId === decision.resourceId),
        "Admission resource disappeared",
      );
      resource = await this.updateResource(trx, selected, {
        state: decision.kind === "reuse" ? "reserved" : "destroying",
        request_id: request.requestId,
      });
    }
    return {
      kind: decision.kind,
      resource,
      request: await this.updateRequest(trx, request.requestId, {
        resource_id: resource.resourceId,
      }),
    };
  }

  private async trimIdle(
    trx: Transaction<BindingRegistryDatabase>,
    limits: BrokerLimits,
  ): Promise<DestructionTicket[]> {
    const resources = await this.readResources(trx);
    const selected = chooseIdleEvictions(
      { activeOrAcquiringSessions: 0, resources: occupiedResources(resources) },
      limits,
    );
    const tickets: DestructionTicket[] = [];
    for (const id of selected) {
      const resource = requireValue(
        resources.find((entry) => entry.resourceId === id),
        "Idle resource disappeared",
      );
      tickets.push(
        destructionTicket(await this.updateResource(trx, resource, { state: "destroying" })),
      );
    }
    return tickets;
  }

  private async readRequest(
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

  private async currentDestructionTicket(
    db: Executor,
    request: BrokerRequestRecord,
  ): Promise<Pick<BrokerAbandonment, "ticket">> {
    if (!request.resourceId) {
      return {};
    }
    const resource = await this.readResource(db, request.resourceId);
    return resource?.requestId === request.requestId && resource.state === "destroying"
      ? { ticket: destructionTicket(resource) }
      : {};
  }

  private async openJournal(db: Executor, resource: BrokerResourceRecord) {
    return db
      .selectFrom("slot_journal")
      .select("id")
      .where("scope_key", "=", resource.scopeKey)
      .where("slot_index", "=", resource.allocationIndex)
      .where("phase", "not in", ["committed", "rolled_back"])
      .executeTakeFirst();
  }

  private async physicalWorkPending(
    db: Executor,
    resource: BrokerResourceRecord,
  ): Promise<boolean> {
    const assignment = await db
      .selectFrom("slot_assignments")
      .select(["stable_device_id", "exec_session_uuid", "state"])
      .where("scope_key", "=", resource.scopeKey)
      .where("slot_index", "=", resource.allocationIndex)
      .executeTakeFirst();
    const journal = await this.openJournal(db, resource);
    return Boolean(
      assignment?.stable_device_id ||
      assignment?.exec_session_uuid ||
      assignment?.state === "settling" ||
      assignment?.state === "cleanup_pending" ||
      journal,
    );
  }

  private async readResource(
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

  private async readResources(db: Executor): Promise<BrokerResourceRecord[]> {
    const rows = await db
      .selectFrom("session_broker_resources")
      .selectAll()
      .orderBy("allocation_index")
      .execute();
    return rows.map(resourceRecord);
  }

  private async ownedRequest(
    db: Executor,
    id: string,
    owner: BindingProcessIdentity,
  ): Promise<BrokerRequestRecord> {
    const request = requireValue(await this.readRequest(db, id), "Unknown session request");
    if (!sameOwner(request.owner, owner)) {
      throw new ActionableError("Session request belongs to another daemon process generation");
    }
    return request;
  }

  private async ownedResource(
    db: Executor,
    request: BrokerRequestRecord,
  ): Promise<BrokerResourceRecord> {
    const resource = requireValue(
      await this.readResource(
        db,
        requireValue(request.resourceId, "Request has no device reservation"),
      ),
      "Request resource disappeared",
    );
    if (resource.requestId !== request.requestId) {
      throw new ActionableError("Session request no longer owns this device reservation");
    }
    return resource;
  }

  private async updateResource(
    trx: Transaction<BindingRegistryDatabase>,
    resource: BrokerResourceRecord,
    changes: Partial<Pick<BrokerResourcesTable, "state" | "request_id" | "idle_order">>,
  ): Promise<BrokerResourceRecord> {
    const row = await trx
      .updateTable("session_broker_resources")
      .set({ ...changes, revision: resource.revision + 1 })
      .where("resource_id", "=", resource.resourceId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return resourceRecord(row);
  }

  private async updateRequest(
    trx: Transaction<BindingRegistryDatabase>,
    id: string,
    changes: Partial<
      Pick<
        BrokerRequestsTable,
        "state" | "resource_id" | "session_id" | "error" | "error_code" | "retryable" | "owner_json"
      >
    >,
  ): Promise<BrokerRequestRecord> {
    const terminal = isTerminalState(changes.state) ? { terminal_at_ms: this.clock.now() } : {};
    const row = await trx
      .updateTable("session_broker_requests")
      .set({ ...changes, ...terminal })
      .where("request_id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return requestRecord(row);
  }
}
