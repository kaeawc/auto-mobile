import { activationHardware } from "./profile";
import { sameProcess } from "./brokerSupport";
import { countSessionAdmissions, occupiedResources } from "./sqliteAdmissions";
import { completedAcquisitionTiming, pendingAcquisitionTiming } from "./timingRecorder";
import { requestRecord, resourceRecord, readRequest, readResource } from "./sqliteRecords";
import { SqliteBrokerTimingStore } from "./sqliteTimingStore";
import type { SessionPreparationTiming } from "./devicePort";
import { SessionRequestOwnerMismatchError } from "./SessionRequestOwnerMismatchError";
import { SessionBrokerInvariantError } from "./SessionBrokerInvariantError";
import type { Kysely, Selectable, Transaction } from "kysely";
import {
  readExport,
  acknowledgeExport,
  linkRequestExport,
  linkExport,
  pruneTerminalRequests,
  deleteUnreferencedTombstones,
} from "./sqliteReceipts";
import {
  SESSION_OWNER_EXITED_CODE,
  SESSION_OWNER_EXITED_MESSAGE,
  type SessionBrokerFailure,
  type SessionBrokerTiming,
} from "../../devices/sessionBrokerResult";
import { ActionableError } from "../../models/ActionableError";
import type { SessionDeviceProfile } from "../../devices/sessionRequirements";
import type { BrokerTimingSample } from "./store";
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
  drainableIdle,
  type BrokerExportIdentity,
  type BrokerExportRecord,
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

function isTerminalState(state: BrokerRequestsTable["state"] | undefined): boolean {
  return state === "released" || state === "failed";
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
    throw new SessionBrokerInvariantError(message);
  }
  return value;
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
  private readonly timingStore: SqliteBrokerTimingStore;

  private readonly ids: IdGenerator;
  private readonly clock: Pick<Timer, "now">;

  constructor(
    private readonly db: Kysely<BindingRegistryDatabase>,
    private readonly scopeKey: string,
    private readonly isOwnerLive: BindingExecOwnerLiveness,
    {
      ids = defaultIdGenerator,
      clock = defaultTimer,
    }: { ids?: IdGenerator; clock?: Pick<Timer, "now"> } = {},
  ) {
    this.ids = ids;
    this.clock = clock;
    this.timingStore = new SqliteBrokerTimingStore(db, clock);
  }

  async getRequest(requestId: string): Promise<BrokerRequestRecord | undefined> {
    return readRequest(this.db, requestId);
  }

  recordTiming(
    requestId: string,
    timing: SessionBrokerTiming,
    profile?: SessionDeviceProfile,
  ): Promise<void> {
    return this.timingStore.recordTiming(requestId, timing, profile);
  }

  timingSamples(sinceMs: number, untilMs: number, limit: number): Promise<BrokerTimingSample[]> {
    return this.timingStore.timingSamples(sinceMs, untilMs, limit);
  }

  getExport(prepareId: string): Promise<BrokerExportRecord | undefined> {
    return readExport(this.db, prepareId);
  }

  acknowledgeExport(
    prepareId: string,
    now = this.clock.now(),
  ): Promise<BrokerExportRecord | undefined> {
    return acknowledgeExport(this.db, prepareId, now);
  }

  linkRequestExport(
    requestId: string,
    fingerprint: string,
    identity: BrokerExportIdentity,
  ): Promise<void> {
    return linkRequestExport(this.db, this.clock.now(), requestId, { fingerprint, identity });
  }

  async getSession(sessionId: string): Promise<BrokerRequestRecord | undefined> {
    const row = await this.db
      .selectFrom("session_broker_requests")
      .selectAll()
      .where("session_id", "=", sessionId)
      .executeTakeFirst();
    return row && requestRecord(row);
  }

  async listResources(resourceId?: string): Promise<BrokerResourceRecord[]> {
    if (resourceId !== undefined) {
      const resource = await readResource(this.db, resourceId);
      return resource ? [resource] : [];
    }
    return this.readResources(this.db);
  }

  async getResource(resourceId: string): Promise<BrokerResourceRecord | undefined> {
    // Preserve the receipt-read failure/race injection seam while querying only this row.
    return (await this.listResources(resourceId))[0];
  }

  listLiveResources(): Promise<BrokerResourceRecord[]> {
    return this.readResources(this.db, true);
  }

  async listRequests(): Promise<BrokerRequestRecord[]> {
    const rows = await this.db.selectFrom("session_broker_requests").selectAll().execute();
    return rows.map(requestRecord);
  }

  /**
   * The receipts a recovery pass can still act on, read without a write transaction: every
   * non-terminal request (an IN list, as NOT IN scans all receipts), plus an abandoned one whose granted session may still need draining
   * because its device is not yet confirmed destroyed. Settled terminal receipts are skipped, so
   * the pass costs nothing per finished request however many accumulate.
   */
  async listRecoverableRequests(): Promise<BrokerRequestRecord[]> {
    const rows = await this.db
      .selectFrom("session_broker_requests")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("state", "in", ["acquiring", "active", "releasing"]),
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

  pruneTerminalRequests(
    retentionMs: number,
    limit: number,
    exportRetentionMs?: number,
  ): Promise<number> {
    return pruneTerminalRequests(this.db, this.clock, retentionMs, { limit, exportRetentionMs });
  }

  /** A failed catalog/default lookup consumes its operation identity without consuming capacity. */
  async recordPreAdmissionFailure(
    input: Pick<
      BrokerAdmissionInput,
      "requestId" | "fingerprint" | "parameters" | "owner" | "export"
    >,
    failure: SessionBrokerFailure,
  ): Promise<BrokerRequestRecord> {
    if (!input.requestId.trim() || !input.fingerprint.trim()) {
      throw new ActionableError("Session request identity and fingerprint must be non-empty");
    }
    return this.db.transaction().execute(async (trx) => {
      const previous = await readRequest(trx, input.requestId);
      if (previous) {
        if (previous.fingerprint !== input.fingerprint) {
          throw new ActionableError(
            "Session request identity was already used with different parameters",
          );
        }
        await linkExport(trx, input.requestId, input.export, this.clock.now());
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
      await linkExport(trx, input.requestId, input.export, this.clock.now());
      return requestRecord(row);
    });
  }

  async admit(input: BrokerAdmissionInput): Promise<BrokerAdmission> {
    if (!input.requestId.trim() || !input.fingerprint.trim()) {
      throw new ActionableError("Session request identity and fingerprint must be non-empty");
    }
    return this.db.transaction().execute(async (trx) => {
      const previous = await readRequest(trx, input.requestId);
      if (previous) {
        if (previous.fingerprint !== input.fingerprint) {
          throw new ActionableError(
            "Session request identity was already used with different parameters",
          );
        }
        await linkExport(trx, input.requestId, input.export, this.clock.now());
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
      await linkExport(trx, input.requestId, input.export, this.clock.now());
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
      const previous = await readRequest(trx, requestId);
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
      if (!sameProcess(previous.owner, owner)) {
        throw new SessionRequestOwnerMismatchError(previous.restartHandoff === true);
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
      if (request.resourceId === null) {
        return this.reserve(trx, request, input);
      }
      const resource = requireValue(
        await readResource(
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
    preparation?: SessionPreparationTiming & { profile?: SessionDeviceProfile },
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
      await this.updateResource(trx, resource, {
        state: "active",
        ...activationHardware(resource, preparation?.profile),
      });
      return this.updateRequest(trx, requestId, {
        state: "active",
        session_id: sessionId,
        ...completedAcquisitionTiming(request, resource, preparation, this.clock.now()),
      });
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
        throw new SessionBrokerInvariantError(
          "Only a joined, resetting session can return a clean device",
        );
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
        throw new SessionBrokerInvariantError(
          "Physical device still has execution or journal work; it cannot enter the idle pool",
        );
      }
      const resources = await this.readResources(trx, true);
      const idleOrder =
        resources.reduce((latest, entry) => Math.max(latest, entry.idleOrder), 0) + 1;
      await this.updateResource(trx, resource, {
        state: "idle",
        request_id: null,
        idle_order: idleOrder,
      });
      await this.updateRequest(trx, requestId, { state: "released" });
      return this.trimIdle(trx, limits, resource.resourceId, requestId);
    });
  }

  /** Failure is terminal for the request, but keeps a discoverable destruction obligation. */
  async fail(
    requestId: string,
    owner: BindingProcessIdentity,
    error: string,
    {
      errorCode = "session_preparation_failed",
      retryable = false,
    }: { errorCode?: string; retryable?: boolean } = {},
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
   * Drain of the idle pool (operator, or idle expiry with its observed revisions): each claimed
   * resource leaves the reusable set in one transaction, so no acquisition can reserve it.
   */
  async drainIdle(observed?: readonly DestructionTicket[]): Promise<DestructionTicket[]> {
    return this.db.transaction().execute(async (trx) => {
      const resources = await this.readResources(trx, true);
      const tickets: DestructionTicket[] = [];
      for (const resource of resources.filter((entry) => drainableIdle(entry, observed))) {
        tickets.push(
          destructionTicket(await this.updateResource(trx, resource, { state: "destroying" })),
        );
      }
      return tickets;
    });
  }

  /**
   * The existing native journal must have confirmed authoritative absence and cleared the
   * physical binding. An old deletion receipt cannot free a new incarnation of a resource.
   */
  async confirmDestroyed(ticket: DestructionTicket): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const resource = await readResource(trx, ticket.resourceId);
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
      // Retained receipts still need the profile and idempotent destruction revision.
      await trx
        .updateTable("session_broker_resources")
        .set({ state: "destroyed" })
        .where("resource_id", "=", resource.resourceId)
        .execute();
      if (resource.requestId) {
        await this.settleRequestAfterDestruction(trx, resource);
      } else {
        await deleteUnreferencedTombstones(trx, resource.resourceId);
      }
      await this.timingStore.confirmDestroyed(trx, resource.requestId);
      return true;
    });
  }

  /**
   * Recovery first takes durable ownership, fences the prior owner, and requires destruction.
   * A relinquished release stays releasing until destruction confirms its released receipt;
   * other interrupted requests fail with session_owner_exited.
   * A live or uncertain owner is retained. The caller must bound uncertainty and arrange another
   * recovery pass, never infer an idle device from process exit.
   */
  async recoverRequest(
    requestId: string,
    owner: BindingProcessIdentity,
  ): Promise<DestructionTicket | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const request = requireValue(await readRequest(trx, requestId), "Unknown session request");
      if (sameProcess(request.owner, owner) || this.isOwnerLive(request.owner)) {
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
            request.state === "releasing" && resource.state === "destroying"
              ? resource
              : await this.updateResource(trx, resource, { state: "destroying" }),
          );
        }
      }
      await this.updateRequest(trx, requestId, {
        owner_json: JSON.stringify(owner),
        state: request.state === "releasing" ? "releasing" : "failed",
        error: request.state === "releasing" ? null : SESSION_OWNER_EXITED_MESSAGE,
        error_code: request.state === "releasing" ? null : SESSION_OWNER_EXITED_CODE,
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
      const request = requireValue(await readRequest(trx, requestId), "Unknown session request");
      if (!request.restartHandoff || request.state !== "active" || !request.sessionId) {
        return "not-handoff";
      }
      if (sameProcess(request.owner, owner)) {
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
    const request = await readRequest(trx, requireValue(resource.requestId, "No request"));
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
    const resources = await this.readResources(trx, true);
    const sessionCount = await countSessionAdmissions(trx, request.requestId);
    const decision = selectAdmission(
      {
        activeOrAcquiringSessions: sessionCount,
        resetWaitThresholdMs: input.resetReadiness?.thresholdMs,
        resources: occupiedResources(resources).map((resource) => ({
          ...resource,
          compatible:
            (resource.state === "idle" || resource.state === "resetting") &&
            input.matches(
              requireValue(
                resources.find((entry) => entry.resourceId === resource.id),
                "Missing resource",
              ).profile,
            ),
          expectedReadyMs:
            input.resetReadiness?.canWait?.(resource.id) === false
              ? undefined
              : input.resetReadiness?.expectedReadyMs.get(resource.id),
        })),
      },
      input.limits,
    );
    if (decision.kind === "wait") {
      input.resetReadiness?.reserveWait?.(request.requestId, decision.resourceId);
      const resetting = requireValue(
        resources.find((resource) => resource.resourceId === decision.resourceId),
        "Waiting resource disappeared",
      );
      return {
        ...decision,
        request: await this.updateRequest(trx, request.requestId, {
          ...pendingAcquisitionTiming(input, request, resetting, {
            kind: "wait",
            now: this.clock.now(),
          }),
        }),
      };
    }
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
        reuse_count: (selected.reuseCount ?? 0) + (decision.kind === "reuse" ? 1 : 0),
      });
    }
    return {
      kind: decision.kind,
      resource,
      request: await this.updateRequest(trx, request.requestId, {
        resource_id: resource.resourceId,
        ...pendingAcquisitionTiming(input, request, resource, {
          kind: decision.kind,
          now: this.clock.now(),
          creationProfile,
        }),
      }),
    };
  }

  private async trimIdle(
    trx: Transaction<BindingRegistryDatabase>,
    limits: BrokerLimits,
    returningResourceId?: string,
    returningRequestId?: string,
  ): Promise<DestructionTicket[]> {
    const resources = await this.readResources(trx, true);
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
      const changes =
        resource.resourceId === returningResourceId && returningRequestId
          ? { state: "destroying" as const, request_id: returningRequestId }
          : { state: "destroying" as const };
      tickets.push(destructionTicket(await this.updateResource(trx, resource, changes)));
    }
    return tickets;
  }

  private async currentDestructionTicket(
    db: Executor,
    request: BrokerRequestRecord,
  ): Promise<Pick<BrokerAbandonment, "ticket">> {
    if (!request.resourceId) {
      return {};
    }
    const resource = await readResource(db, request.resourceId);
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

  private async readResources(db: Executor, liveOnly = false): Promise<BrokerResourceRecord[]> {
    const rows = await db
      .selectFrom("session_broker_resources")
      .selectAll()
      .$if(liveOnly, (query) => query.where("state", "!=", "destroyed"))
      .orderBy("allocation_index")
      .execute();
    return rows.map(resourceRecord);
  }

  private async ownedRequest(
    db: Executor,
    id: string,
    owner: BindingProcessIdentity,
  ): Promise<BrokerRequestRecord> {
    const request = requireValue(await readRequest(db, id), "Unknown session request");
    if (!sameProcess(request.owner, owner)) {
      throw new SessionRequestOwnerMismatchError(request.restartHandoff === true);
    }
    return request;
  }

  private async ownedResource(
    db: Executor,
    request: BrokerRequestRecord,
  ): Promise<BrokerResourceRecord> {
    const resource = requireValue(
      await readResource(db, requireValue(request.resourceId, "Request has no device reservation")),
      "Request resource disappeared",
    );
    if (resource.requestId !== request.requestId) {
      throw new SessionBrokerInvariantError(
        "Session request no longer owns this device reservation",
      );
    }
    return resource;
  }

  private async updateResource(
    trx: Transaction<BindingRegistryDatabase>,
    resource: BrokerResourceRecord,
    changes: Partial<
      Pick<
        Selectable<BrokerResourcesTable>,
        "state" | "request_id" | "idle_order" | "reuse_count" | "profile_json"
      >
    >,
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
        Selectable<BrokerRequestsTable>,
        | "state"
        | "resource_id"
        | "session_id"
        | "error"
        | "error_code"
        | "retryable"
        | "owner_json"
        | "timing_json"
        | "timing_profile_json"
        | "timing_updated_at_ms"
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
