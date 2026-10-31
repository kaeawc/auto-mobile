import { SqliteAvdSnapshotCleanupRegistry } from "./avdSnapshotCleanupRegistry";
import { SqliteDeviceClaims } from "./sqliteDeviceClaims";
import { Kysely } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BunSqliteHandle } from "../../../db/bunSqliteDialect";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../../db/database";
import { classifySqliteError } from "../../../db/databaseFailureClassification";
import { isInMemoryDatabasePath } from "../../../db/migrationLock";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { IdGenerator } from "../../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { ensureSecureDirectorySync, getAdbServerScopedAutoMobileDir } from "../../../utils/tempDir";
import { BINDINGS_COORDINATION_SCOPE } from "../persistedIdentity";
import { BindingDiscoveryIncompleteError } from "../provisioning/refusal";
import { SqliteSessionBrokerStore } from "../sqliteStore";
import { SqliteDeviceMutationJournal } from "../mutations/sqliteJournal";
import {
  assertPlatformChangeAllowed,
  assertSettlerForState,
  assertValidBindingKey,
  BINDING_JOURNAL_TERMINAL_PHASES,
  BINDING_JOURNAL_TERMINAL_RETENTION_MS,
  bindingMatches,
  computeBindingScopeKey,
  entersFencingState,
  isBindingJournalPhaseOpen,
  journalOwnersEqual,
  journalTargetEntries,
  sameBinding,
  scopeAcceptsBindingChange,
  scopeAcceptsSameSessionClaim,
  type AdvanceBindingJournalInput,
  type AdvanceBindingJournalResult,
  type BindingAssignmentRecord,
  type BindingAssignmentState,
  type BindingBindingCommit,
  type BindingBindingExpectation,
  type BindingCasFailure,
  type BindingExecOwner,
  type BindingExecOwnerLiveness,
  type BindingInit,
  type BindingJournalAssignmentChange,
  type BindingJournalChangeFailure,
  type BindingJournalEntry,
  type BindingJournalOwner,
  type BindingKey,
  type BindingPlatform,
  type BindingProcessIdentity,
  type BindingRegistry,
  type BindingResourceSnapshot,
  type BindingScopeIdentity,
  type BindingScopeRecord,
  type ClaimBindingJournalResult,
  type ClaimExecutionOptions,
  type ClaimExecutionResult,
  type CommitBindingResult,
  type DeviceHolder,
  type EnsureScopeResult,
  type InitBindingResult,
  type ManagedDeviceEntry,
  type OpenBindingJournalInput,
  type OpenBindingJournalResult,
  type ReleaseExecutionResult,
  type UpdateBindingStateOptions,
  type UpdateBindingStateResult,
} from "./bindingRegistry";
import {
  assertSupportedRegistrySchema,
  describeBindingRegistrySchema,
} from "./bindingRegistryMigrations";
import { initializeBindingRegistrySchema } from "./bindingRegistryInitialization";
import {
  assertOpenPhase,
  AssignmentRow,
  BindingRegistryDatabase,
  Executor,
  journalAdvanceColumns,
  JournalRow,
  ScopeRow,
  serializeSpec,
  settlerColumns,
  toAssignment,
  toJournalEntry,
  toScope,
} from "./bindingRegistryRows";
import type { LegacySlotDeviceRetirement } from "./legacySlotDeviceRetirement";
import { defaultBindingExecOwnerLiveness } from "./ownerLiveness";
import { createRegistryDatabase } from "./RegistryDatabase";
import { RegistrySqliteDialect } from "./RegistrySqliteDialect";
import { createRegistryWriteGuard } from "./registryWriteGuard";
export { type BindingRegistryDatabase, parseJournalTarget } from "./bindingRegistryRows";

export { BINDINGS_COORDINATION_SCOPE } from "../persistedIdentity";

/** Scope under the ADB-server coordination root: host-wide, independent of any one adb server. */

export const BINDINGS_REGISTRY_SUBDIR = "registry";

export const BINDINGS_REGISTRY_FILE = "slots.sqlite";

/**
 * The host-wide registry path (#11174). It is NOT under `AUTOMOBILE_DATA_DIR`, `AUTOMOBILE_DB_DIR`
 * or the coordination dir, which can differ per daemon (worktree daemons included); every daemon
 * on the host resolves this same file under the user's home.
 *
 * `AUTOMOBILE_ADB_SERVER_COORDINATION_DIR` is the one override, and it creates a SEPARATE binding
 * authority (#11242 item 8). That is sound for Android only when the daemons sharing it also share
 * the AVD home; iOS simulators are host-global regardless, so two daemons with different overrides
 * must never manage bindings on the same simulator set. Daemons that should share bindings must resolve
 * the same override (or none).
 */
export function defaultBindingRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  return join(
    getAdbServerScopedAutoMobileDir(
      BINDINGS_COORDINATION_SCOPE,
      BINDINGS_REGISTRY_SUBDIR,
      env,
      homeDir,
    ),
    BINDINGS_REGISTRY_FILE,
  );
}

/**
 * Whether the host registry file exists. A host that never served a binding has none, and
 * readers must treat that as "no managed devices" without creating it: only binding acquisition (or
 * another writer) creates the registry.
 */
export function bindingRegistryFileExists(dbPath: string = defaultBindingRegistryPath()): boolean {
  return existsSync(dbPath);
}

export interface SqliteBindingRegistryOptions {
  timer?: Timer;
  /** Decides whether a recorded execution owner is alive. Defaults to PID + process generation. */
  isExecOwnerLive?: BindingExecOwnerLiveness;
}

export interface OpenSqliteBindingRegistryOptions extends SqliteBindingRegistryOptions {
  /** Defaults to {@link defaultBindingRegistryPath}. `:memory:` gives a private in-memory registry. */
  dbPath?: string;
  legacyDeviceRetirement?: Pick<LegacySlotDeviceRetirement, "retire">;
  /** Readers only observe a current schema; they must never run migrations. */
  migrate?: boolean;
  /** Runtime build identity; inject a fixed value in tests. */
  writerVersion?: string;
}

/**
 * bun:sqlite waits for a busy lock synchronously, blocking this daemon's event loop (heartbeat
 * lease handling included). A busy write waits one nominal 250ms busy_timeout, with no dialect retry or
 * backoff. Opening a migrated WAL registry uses reads only and never waits for a peer writer.
 * An open that must migrate can wait one timeout at BEGIN IMMEDIATE (or the first initialization
 * PRAGMA/bookkeeping write for a new file); failure closes without further lock waits. Close skips
 * optimize/checkpoint maintenance and adds no busy_timeout wait. SQLite's sleep granularity plus
 * statement, filesystem and error-handling overhead mean these are not hard wall-clock deadlines;
 * waiting for another opener's migration file lock yields asynchronously. A healthy
 * peer's few short statements and FULL-sync commit (one fsync) have room to finish, while a slow
 * disk or prolonged lock yields a retryable refusal after one short wait, matching the app DB's
 * per-attempt timeout. Callers retry after yielding the event loop. Two connections in
 * one process cannot release each other's lock during this synchronous wait; waiting longer only
 * stalls them. A single uncontended connection never waits. Keep transactions short (#12104).
 */
export const BINDING_REGISTRY_BUSY_TIMEOUT_MS = Math.min(250, SQLITE_BUSY_TIMEOUT_MS);

/** The handle this module opens and hands to the dialect. */
type RegistrySqliteHandle = BunSqliteHandle;

function openRegistrySqlite(dbPath: string): RegistrySqliteHandle {
  const sqliteDb = createRegistryDatabase(dbPath);
  try {
    sqliteDb.exec(`PRAGMA busy_timeout = ${BINDING_REGISTRY_BUSY_TIMEOUT_MS};`);
    sqliteDb.exec("PRAGMA journal_mode = WAL;");
    // Assignment authority must survive power loss; writes are rare, so pay for the fsync.
    sqliteDb.exec("PRAGMA synchronous = FULL;");
    sqliteDb.exec("PRAGMA foreign_keys = ON;");
  } catch (error) {
    sqliteDb.close();
    throw error;
  }
  return sqliteDb;
}

/**
 * Open (creating and migrating as needed) the SQLite-backed binding registry. Each call opens its own
 * connection; every mutation runs in one `BEGIN IMMEDIATE` transaction, so registries in different
 * processes on the same file serialize through SQLite's write lock.
 */
export async function openSqliteBindingRegistry(
  options: OpenSqliteBindingRegistryOptions = {},
): Promise<SqliteBindingRegistry> {
  const dbPath = options.dbPath ?? defaultBindingRegistryPath();
  if (!isInMemoryDatabasePath(dbPath)) {
    ensureSecureDirectorySync(dirname(dbPath));
  }
  let sqlite: RegistrySqliteHandle | undefined;
  const db = new Kysely<BindingRegistryDatabase>({
    dialect: new RegistrySqliteDialect({
      database: () => (sqlite = openRegistrySqlite(dbPath)),
      // Applies to BEGIN and autocommit statements: fail fast so the owning operation can retry
      // the whole unit. Migration DDL is atomic and opens are serialized by a file lock;
      // a busy open is forgotten by factories and refused retryably. Transaction bodies already
      // never retry. Initialization PRAGMAs use raw exec, outside dialect retry; close maintenance
      // is disabled on the registry handle so a failed open adds no more busy waits.
      retry: { maxAttempts: 1 },
    }),
  });
  try {
    await initializeBindingRegistrySchema(db, dbPath, options);
  } catch (error) {
    await db.destroy();
    if (classifySqliteError(error) === "retryable") {
      throw new BindingDiscoveryIncompleteError(errorMessage(error));
    }
    throw error;
  }
  return new SqliteBindingRegistry(db, options, dbPath, sqlite);
}

export class SqliteBindingRegistry implements BindingRegistry {
  private readonly timer: Timer;
  private readonly isExecOwnerLive: BindingExecOwnerLiveness;
  private readonly claims: SqliteDeviceClaims;
  private readonly writeTransaction: ReturnType<typeof createRegistryWriteGuard>;

  constructor(
    private readonly db: Kysely<BindingRegistryDatabase>,
    options: SqliteBindingRegistryOptions = {},
    private readonly dbPath: string = ":memory:",
    sqlite?: RegistrySqliteHandle,
  ) {
    this.timer = options.timer ?? defaultTimer;
    this.isExecOwnerLive = options.isExecOwnerLive ?? defaultBindingExecOwnerLiveness;
    this.writeTransaction = createRegistryWriteGuard({ db, sqlite, dbPath });
    this.claims = new SqliteDeviceClaims(this.db, (write) => this.writeTransaction(write));
  }

  assertSupportedSchema(): Promise<void> {
    return assertSupportedRegistrySchema(this.db, this.dbPath);
  }

  describeSchema() {
    return describeBindingRegistrySchema(this.db);
  }

  /** Shares this connection, transaction lock and physical authority; never opens another DB. */
  sessionBrokerStore(scopeKey: string, ids?: IdGenerator): SqliteSessionBrokerStore {
    return new SqliteSessionBrokerStore(this.db, scopeKey, this.isExecOwnerLive, {
      ids,
      clock: this.timer,
      write: (write) => this.writeTransaction(write),
    });
  }

  /** Complete cleanup references on this already-open registry connection. */
  avdSnapshotCleanupRegistry(): SqliteAvdSnapshotCleanupRegistry {
    return new SqliteAvdSnapshotCleanupRegistry(this.db);
  }

  deviceMutationJournal(): SqliteDeviceMutationJournal {
    return new SqliteDeviceMutationJournal(this.db, this.timer);
  }

  /** The host-wide device claims table (#11811), on this connection and transaction lock. */
  deviceClaims(): SqliteDeviceClaims {
    return this.claims;
  }

  async ensureScope(identity: BindingScopeIdentity): Promise<EnsureScopeResult> {
    const scopeKey = computeBindingScopeKey(identity);
    return this.writeTransaction(async (trx): Promise<EnsureScopeResult> => {
      const nowMs = this.timer.now();
      const existing = await this.readScope(trx, scopeKey);
      if (existing?.state === "valid") {
        await trx
          .updateTable("slot_scopes")
          .set({ last_acquired_at_ms: nowMs })
          .where("scope_key", "=", scopeKey)
          .execute();
        return {
          kind: "ready",
          scope: { ...existing, lastAcquiredAtMs: nowMs },
          created: false,
          revived: false,
        };
      }
      // Only a scope an older build's abandoned-scope sweep marked is revivable; any other
      // invalidation is permanent for this incarnation.
      if (existing && existing.invalidationReason !== "abandoned") {
        return { kind: "scope_invalidated", scope: existing };
      }
      const live = await trx
        .selectFrom("slot_scopes")
        .selectAll()
        .where("managed_host_scope", "=", identity.managedHostScope)
        .where("runner_namespace", "=", identity.runnerNamespace)
        .where("state", "<>", "invalidated")
        .where("scope_key", "<>", scopeKey)
        .executeTakeFirst();
      if (live) {
        return { kind: "incarnation_conflict", current: toScope(live) };
      }
      if (existing) {
        const revived = await trx
          .updateTable("slot_scopes")
          .set({
            state: "valid",
            invalidation_reason: null,
            invalidating_at_ms: null,
            invalidated_at_ms: null,
            last_acquired_at_ms: nowMs,
          })
          .where("scope_key", "=", scopeKey)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { kind: "ready", scope: toScope(revived), created: false, revived: true };
      }
      const row: ScopeRow = {
        scope_key: scopeKey,
        managed_host_scope: identity.managedHostScope,
        runner_namespace: identity.runnerNamespace,
        runner_incarnation: identity.runnerIncarnation,
        state: "valid",
        invalidation_reason: null,
        created_at_ms: nowMs,
        last_acquired_at_ms: nowMs,
        last_released_at_ms: null,
        invalidating_at_ms: null,
        invalidated_at_ms: null,
      };
      await trx.insertInto("slot_scopes").values(row).execute();
      return { kind: "ready", scope: toScope(row), created: true, revived: false };
    });
  }

  async getScope(scopeKey: string): Promise<BindingScopeRecord | null> {
    return this.readScope(this.db, scopeKey);
  }

  async initBinding(key: BindingKey, init: BindingInit): Promise<InitBindingResult> {
    assertValidBindingKey(key);
    const requestedSpecJson = serializeSpec(init.requestedSpec);
    return this.writeTransaction(async (trx) => {
      const scope = await this.readScope(trx, key.scopeKey);
      if (scope?.state !== "valid") {
        return { kind: "scope_not_valid", scope };
      }
      const existing = await this.readAssignment(trx, key);
      if (existing) {
        return { kind: "ready", assignment: existing, created: false };
      }
      const row: AssignmentRow = {
        scope_key: key.scopeKey,
        slot_index: key.bindingIndex,
        role: init.role,
        platform: init.platform,
        generation: 0,
        stable_device_id: null,
        device_name: null,
        requested_spec_json: requestedSpecJson,
        resolved_spec_json: null,
        spec_fingerprint: null,
        state: "provisioning",
        exec_owner_daemon_id: null,
        exec_owner_pid: null,
        exec_owner_process_token: null,
        exec_session_uuid: null,
        ...settlerColumns(null),
        updated_at_ms: this.timer.now(),
      };
      await trx.insertInto("slot_assignments").values(row).execute();
      return { kind: "ready", assignment: toAssignment(row), created: true };
    });
  }

  async removeUnboundBinding(
    key: BindingKey,
    expected: { generation: number; stableDeviceId: null },
  ): Promise<boolean> {
    assertValidBindingKey(key);
    return this.writeTransaction(async (trx) => {
      if (await this.readOpenJournal(trx, key)) {
        return false;
      }
      const deleted = await trx
        .deleteFrom("slot_assignments")
        .where("scope_key", "=", key.scopeKey)
        .where("slot_index", "=", key.bindingIndex)
        .where("generation", "=", expected.generation)
        .where("stable_device_id", "is", null)
        .where("state", "=", "provisioning")
        .where("exec_owner_daemon_id", "is", null)
        .where("exec_owner_pid", "is", null)
        .where("exec_owner_process_token", "is", null)
        .where("exec_session_uuid", "is", null)
        .executeTakeFirst();
      return deleted.numDeletedRows > 0n;
    });
  }

  async commitBinding(
    key: BindingKey,
    expected: BindingBindingExpectation,
    next: BindingBindingCommit,
  ): Promise<CommitBindingResult> {
    assertValidBindingKey(key);
    return this.writeTransaction((trx) => this.commitBindingIn(trx, key, expected, { next }));
  }

  private async commitBindingIn(
    trx: Executor,
    key: BindingKey,
    expected: BindingBindingExpectation,
    { next, journaled = false }: { next: BindingBindingCommit; journaled?: boolean },
  ): Promise<CommitBindingResult> {
    const resolvedSpecJson =
      next.resolvedSpec === null || next.resolvedSpec === undefined
        ? null
        : serializeSpec(next.resolvedSpec);
    const requestedSpecJson =
      next.requestedSpec === undefined ? undefined : serializeSpec(next.requestedSpec);
    const checked = await this.checkBinding(trx, key, expected, { journaled });
    if ("kind" in checked) {
      return checked;
    }
    const platform = assertPlatformChangeAllowed(checked, next);
    if (next.stableDeviceId !== null) {
      const holder = await trx
        .selectFrom("slot_assignments")
        .selectAll()
        .where("platform", "=", platform)
        .where("stable_device_id", "=", next.stableDeviceId)
        .where((eb) =>
          eb.or([eb("scope_key", "<>", key.scopeKey), eb("slot_index", "<>", key.bindingIndex)]),
        )
        .executeTakeFirst();
      if (holder) {
        return { kind: "device_assigned_elsewhere", holder: toAssignment(holder) };
      }
    }

    const deviceChanged =
      next.stableDeviceId !== checked.stableDeviceId || platform !== checked.platform;
    const updated = await trx
      .updateTable("slot_assignments")
      .set({
        generation: checked.generation + 1,
        platform,
        stable_device_id: next.stableDeviceId,
        device_name: next.deviceName,
        resolved_spec_json: resolvedSpecJson,
        spec_fingerprint: next.specFingerprint,
        state: next.state,
        ...settlerColumns(null),
        ...(requestedSpecJson === undefined ? {} : { requested_spec_json: requestedSpecJson }),
        // A different device cannot inherit the previous device's execution owner.
        ...(deviceChanged
          ? {
              exec_owner_daemon_id: null,
              exec_owner_pid: null,
              exec_owner_process_token: null,
              exec_session_uuid: null,
            }
          : {}),
        updated_at_ms: this.timer.now(),
      })
      .where("scope_key", "=", key.scopeKey)
      .where("slot_index", "=", key.bindingIndex)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { kind: "committed", assignment: toAssignment(updated) };
  }

  async updateBindingState(
    key: BindingKey,
    expected: BindingBindingExpectation,
    state: BindingAssignmentState,
    options?: UpdateBindingStateOptions,
  ): Promise<UpdateBindingStateResult> {
    assertValidBindingKey(key);
    const settler = assertSettlerForState(state, options);
    return this.writeTransaction((trx) =>
      this.updateBindingStateIn(trx, key, expected, { state, settler }),
    );
  }

  private async updateBindingStateIn(
    trx: Executor,
    key: BindingKey,
    expected: BindingBindingExpectation,
    {
      state,
      settler,
      journaled = false,
    }: {
      state: BindingAssignmentState;
      settler: BindingProcessIdentity | null;
      journaled?: boolean;
    },
  ): Promise<UpdateBindingStateResult> {
    const checked = await this.checkBinding(trx, key, expected, { journaled });
    if ("kind" in checked) {
      return checked;
    }
    const owner = checked.execOwner;
    if (state === "replacing" && owner && this.isExecOwnerLive(owner)) {
      return { kind: "binding_in_use", owner, assignment: checked };
    }
    const generation = entersFencingState(checked.state, state)
      ? checked.generation + 1
      : checked.generation;
    const updated = await trx
      .updateTable("slot_assignments")
      .set({ state, generation, ...settlerColumns(settler), updated_at_ms: this.timer.now() })
      .where("scope_key", "=", key.scopeKey)
      .where("slot_index", "=", key.bindingIndex)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { kind: "updated", assignment: toAssignment(updated) };
  }

  async claimExecution(
    key: BindingKey,
    expected: BindingBindingExpectation,
    owner: BindingExecOwner,
    options: ClaimExecutionOptions = {},
  ): Promise<ClaimExecutionResult> {
    assertValidBindingKey(key);
    return this.writeTransaction(async (trx): Promise<ClaimExecutionResult> => {
      const checked = await this.checkBinding(trx, key, expected, {
        journaled: false,
        claimingSessionUuid: owner.sessionUuid,
      });
      if ("kind" in checked) {
        return checked;
      }
      if (checked.state !== "ready" || checked.stableDeviceId === null) {
        return { kind: "binding_not_ready", assignment: checked };
      }
      const current = checked.execOwner;
      if (
        current &&
        current.sessionUuid !== owner.sessionUuid &&
        current.sessionUuid !== options.supersedesSessionUuid &&
        this.isExecOwnerLive(current)
      ) {
        return { kind: "binding_in_use", owner: current, assignment: checked };
      }
      const updated = await trx
        .updateTable("slot_assignments")
        .set({
          exec_owner_daemon_id: owner.daemonId,
          exec_owner_pid: owner.pid,
          exec_owner_process_token: owner.processGenerationToken ?? null,
          exec_session_uuid: owner.sessionUuid,
          updated_at_ms: this.timer.now(),
        })
        .where("scope_key", "=", key.scopeKey)
        .where("slot_index", "=", key.bindingIndex)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "claimed", assignment: toAssignment(updated) };
    });
  }

  async releaseExecution(key: BindingKey, sessionUuid: string): Promise<ReleaseExecutionResult> {
    assertValidBindingKey(key);
    return this.writeTransaction(async (trx) => {
      const updated = await trx
        .updateTable("slot_assignments")
        .set({
          exec_owner_daemon_id: null,
          exec_owner_pid: null,
          exec_owner_process_token: null,
          exec_session_uuid: null,
          updated_at_ms: this.timer.now(),
        })
        .where("scope_key", "=", key.scopeKey)
        .where("slot_index", "=", key.bindingIndex)
        .where("exec_session_uuid", "=", sessionUuid)
        .returningAll()
        .executeTakeFirst();
      if (updated) {
        // An execution ending is scope activity: the abandonment clock restarts here.
        await trx
          .updateTable("slot_scopes")
          .set({ last_released_at_ms: updated.updated_at_ms })
          .where("scope_key", "=", key.scopeKey)
          .execute();
        return { released: true, assignment: toAssignment(updated) };
      }
      return { released: false, assignment: await this.readAssignment(trx, key) };
    });
  }

  async recoverSettledBindings(scopeKey?: string): Promise<BindingAssignmentRecord[]> {
    return this.writeTransaction(async (trx) => {
      let query = trx.selectFrom("slot_assignments").selectAll().where("state", "=", "settling");
      if (scopeKey !== undefined) {
        query = query.where("scope_key", "=", scopeKey);
      }
      const settled = (await query.orderBy("scope_key").orderBy("slot_index").execute())
        .map(toAssignment)
        .filter((assignment) => this.isSettled(assignment));
      const recovered: BindingAssignmentRecord[] = [];
      for (const assignment of settled) {
        const row = await trx
          .updateTable("slot_assignments")
          .set({ state: "ready", ...settlerColumns(null), updated_at_ms: this.timer.now() })
          .where("scope_key", "=", assignment.scopeKey)
          .where("slot_index", "=", assignment.bindingIndex)
          .where("generation", "=", assignment.generation)
          .where("state", "=", "settling")
          .returningAll()
          .executeTakeFirstOrThrow();
        recovered.push(toAssignment(row));
      }
      return recovered;
    });
  }

  async getAssignment(key: BindingKey): Promise<BindingAssignmentRecord | null> {
    assertValidBindingKey(key);
    return this.readAssignment(this.db, key);
  }

  async listAssignments(scopeKey: string): Promise<BindingAssignmentRecord[]> {
    const rows = await this.db
      .selectFrom("slot_assignments")
      .selectAll()
      .where("scope_key", "=", scopeKey)
      .orderBy("slot_index")
      .execute();
    return rows.map(toAssignment);
  }

  async findExecutionAssignments(sessionUuid: string): Promise<BindingAssignmentRecord[]> {
    const rows = await this.db
      .selectFrom("slot_assignments")
      .selectAll()
      .where("exec_session_uuid", "=", sessionUuid)
      .orderBy("scope_key")
      .orderBy("slot_index")
      .execute();
    return rows.map(toAssignment);
  }

  async findDeviceHolder(
    platform: BindingPlatform,
    stableDeviceId: string,
  ): Promise<DeviceHolder | null> {
    const assignment = await this.db
      .selectFrom("slot_assignments")
      .selectAll()
      .where("platform", "=", platform)
      .where("stable_device_id", "=", stableDeviceId)
      .executeTakeFirst();
    if (assignment) {
      const scope = await this.readScope(this.db, assignment.scope_key);
      if (scope) {
        return { kind: "binding", scope, assignment: toAssignment(assignment) };
      }
    }
    return null;
  }

  async isDeviceAssignedToValidBinding(
    platform: BindingPlatform,
    stableDeviceId: string,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom("slot_assignments")
      .innerJoin("slot_scopes", "slot_scopes.scope_key", "slot_assignments.scope_key")
      .select("slot_assignments.slot_index")
      .where("slot_assignments.platform", "=", platform)
      .where("slot_assignments.stable_device_id", "=", stableDeviceId)
      .where("slot_scopes.state", "=", "valid")
      .executeTakeFirst();
    return row !== undefined;
  }

  async snapshotManagedDevices(): Promise<ManagedDeviceEntry[]> {
    return (await this.snapshotResources()).managed;
  }

  async snapshotBindingResources(): Promise<BindingResourceSnapshot> {
    return this.snapshotResources();
  }

  private async snapshotResources(): Promise<BindingResourceSnapshot> {
    const assignedQuery = this.db
      .selectFrom("slot_assignments")
      .innerJoin("slot_scopes", "slot_scopes.scope_key", "slot_assignments.scope_key")
      .select([
        "slot_assignments.platform as platform",
        "slot_assignments.stable_device_id as stable_device_id",
        "slot_assignments.scope_key as scope_key",
        "slot_assignments.slot_index as slot_index",
        "slot_assignments.exec_session_uuid as exec_session_uuid",
        "slot_scopes.state as scope_state",
      ])
      .where("slot_assignments.stable_device_id", "is not", null)
      // A revivable (abandoned) scope's kept bindings stay reserved for its returning incarnation.
      .where((eb) =>
        eb.or([
          eb("slot_scopes.state", "<>", "invalidated"),
          eb("slot_scopes.invalidation_reason", "=", "abandoned"),
        ]),
      );

    // SQLite pins one read snapshot for this single statement (including every subquery).
    // The dialect's transaction() uses BEGIN IMMEDIATE, so it must not be used for this read.
    const snapshot = await this.db
      .selectNoFrom([
        jsonArrayFrom(assignedQuery).$castTo<string>().as("assigned"),
        jsonArrayFrom(
          this.db
            .selectFrom("slot_journal")
            .select([
              "id",
              "scope_key",
              "slot_index",
              "kind",
              "phase",
              "platform",
              "from_generation",
              "to_generation",
              "binding_generation",
              "binding_stable_device_id",
              "target_json",
              "owner_daemon_id",
              "owner_pid",
              "owner_process_token",
              "attempts",
              "last_error",
              "next_attempt_at_ms",
              "created_at_ms",
              "updated_at_ms",
            ])
            .where("phase", "not in", BINDING_JOURNAL_TERMINAL_PHASES),
        )
          .$castTo<string>()
          .as("pending"),
      ])
      .executeTakeFirstOrThrow();
    // Decode only the aggregate arrays; target_json must remain a string for the journal codec.
    const assigned: Awaited<ReturnType<typeof assignedQuery.execute>> = JSON.parse(
      snapshot.assigned,
    );
    const pendingRows: JournalRow[] = JSON.parse(snapshot.pending);
    const pending = pendingRows.map(toJournalEntry);
    const entries: ManagedDeviceEntry[] = [
      ...assigned.flatMap((row): ManagedDeviceEntry[] =>
        row.stable_device_id === null
          ? []
          : [
              {
                platform: row.platform,
                stableDeviceId: row.stable_device_id,
                holder: "session_broker",
                scopeKey: row.scope_key,
                bindingIndex: row.slot_index,
                scopeState: row.scope_state,
                execSessionUuid: row.exec_session_uuid,
              },
            ],
      ),
    ];
    return {
      managed: [...entries, ...journalTargetEntries(pending, entries)],
      openJournal: pending,
    };
  }
  async openBindingJournal(
    key: BindingKey,
    input: OpenBindingJournalInput,
  ): Promise<OpenBindingJournalResult> {
    assertValidBindingKey(key);
    assertOpenPhase(input.phase);
    const targetJson = serializeSpec(input.target);
    return this.writeTransaction(async (trx): Promise<OpenBindingJournalResult> => {
      const nowMs = this.timer.now();
      await trx
        .deleteFrom("slot_journal")
        .where("phase", "in", [...BINDING_JOURNAL_TERMINAL_PHASES])
        .where("updated_at_ms", "<", nowMs - BINDING_JOURNAL_TERMINAL_RETENTION_MS)
        .execute();
      const open = await this.readOpenJournal(trx, key);
      if (open) {
        return { kind: "journal_open", entry: open };
      }
      const applied = await this.applyJournalAssignmentChange(trx, key, input.assignment);
      if ("kind" in applied) {
        return applied;
      }
      const row = await trx
        .insertInto("slot_journal")
        .values({
          scope_key: key.scopeKey,
          slot_index: key.bindingIndex,
          kind: input.kind,
          phase: input.phase,
          platform: applied.platform,
          from_generation: input.assignment.expected.generation,
          to_generation:
            applied.generation === input.assignment.expected.generation ? null : applied.generation,
          binding_generation: applied.generation,
          binding_stable_device_id: applied.stableDeviceId,
          target_json: targetJson,
          owner_daemon_id: input.owner.daemonId,
          owner_pid: input.owner.pid,
          owner_process_token: input.owner.processGenerationToken ?? null,
          attempts: 0,
          last_error: null,
          next_attempt_at_ms: nowMs,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "opened", entry: toJournalEntry(row), assignment: applied };
    });
  }

  async advanceBindingJournal(
    id: number,
    input: AdvanceBindingJournalInput,
  ): Promise<AdvanceBindingJournalResult> {
    return this.writeTransaction(async (trx): Promise<AdvanceBindingJournalResult> => {
      const row = await trx
        .selectFrom("slot_journal")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      const entry = row ? toJournalEntry(row) : null;
      if (
        !entry ||
        !isBindingJournalPhaseOpen(entry.phase) ||
        entry.phase !== input.expectedPhase ||
        !journalOwnersEqual(entry.owner, input.owner)
      ) {
        return { kind: "journal_conflict", entry };
      }
      let assignment: BindingAssignmentRecord | null = null;
      if (input.assignment) {
        if (!sameBinding(entry.binding, input.assignment.expected)) {
          return { kind: "journal_conflict", entry };
        }
        const applied = await this.applyJournalAssignmentChange(trx, entry, input.assignment);
        if ("kind" in applied) {
          return applied;
        }
        assignment = applied;
      }
      const updated = await trx
        .updateTable("slot_journal")
        .set(journalAdvanceColumns(entry, input, assignment, this.timer.now()))
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "advanced", entry: toJournalEntry(updated), assignment };
    });
  }

  async claimBindingJournal(
    id: number,
    expected: BindingJournalOwner,
    next: BindingJournalOwner,
  ): Promise<ClaimBindingJournalResult> {
    return this.writeTransaction(async (trx): Promise<ClaimBindingJournalResult> => {
      const row = await trx
        .selectFrom("slot_journal")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      const entry = row ? toJournalEntry(row) : null;
      if (
        !entry ||
        !isBindingJournalPhaseOpen(entry.phase) ||
        !journalOwnersEqual(entry.owner, expected)
      ) {
        return { kind: "journal_conflict", entry };
      }
      const updated = await trx
        .updateTable("slot_journal")
        .set({
          owner_daemon_id: next.daemonId,
          owner_pid: next.pid,
          owner_process_token: next.processGenerationToken ?? null,
          updated_at_ms: this.timer.now(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "claimed", entry: toJournalEntry(updated) };
    });
  }

  async getBindingJournal(id: number): Promise<BindingJournalEntry | null> {
    const row = await this.db
      .selectFrom("slot_journal")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toJournalEntry(row) : null;
  }

  async listOpenBindingJournal(key?: BindingKey): Promise<BindingJournalEntry[]> {
    let query = this.db
      .selectFrom("slot_journal")
      .selectAll()
      .where("phase", "not in", [...BINDING_JOURNAL_TERMINAL_PHASES]);
    if (key) {
      query = query
        .where("scope_key", "=", key.scopeKey)
        .where("slot_index", "=", key.bindingIndex);
    }
    const rows = await query.orderBy("next_attempt_at_ms").orderBy("id").execute();
    return rows.map(toJournalEntry);
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  private async readOpenJournal(
    executor: Executor,
    key: BindingKey,
  ): Promise<BindingJournalEntry | null> {
    const row = await executor
      .selectFrom("slot_journal")
      .selectAll()
      .where("scope_key", "=", key.scopeKey)
      .where("slot_index", "=", key.bindingIndex)
      .where("phase", "not in", [...BINDING_JOURNAL_TERMINAL_PHASES])
      .executeTakeFirst();
    return row ? toJournalEntry(row) : null;
  }

  private async applyJournalAssignmentChange(
    trx: Executor,
    key: BindingKey,
    change: BindingJournalAssignmentChange,
  ): Promise<BindingAssignmentRecord | BindingJournalChangeFailure> {
    const result =
      change.kind === "commit"
        ? await this.commitBindingIn(trx, key, change.expected, {
            next: change.next,
            journaled: true,
          })
        : await this.updateBindingStateIn(trx, key, change.expected, {
            state: change.state,
            settler: assertSettlerForState(change.state, change.options),
            journaled: true,
          });
    return result.kind === "committed" || result.kind === "updated" ? result.assignment : result;
  }

  private async readScope(
    executor: Executor,
    scopeKey: string,
  ): Promise<BindingScopeRecord | null> {
    const row = await executor
      .selectFrom("slot_scopes")
      .selectAll()
      .where("scope_key", "=", scopeKey)
      .executeTakeFirst();
    return row ? toScope(row) : null;
  }

  private async readAssignment(
    executor: Executor,
    key: BindingKey,
  ): Promise<BindingAssignmentRecord | null> {
    const row = await executor
      .selectFrom("slot_assignments")
      .selectAll()
      .where("scope_key", "=", key.scopeKey)
      .where("slot_index", "=", key.bindingIndex)
      .executeTakeFirst();
    return row ? toAssignment(row) : null;
  }

  /**
   * The shared CAS precondition: valid scope, existing binding, unchanged binding. Journaled work may
   * also settle in an `invalidating` scope, whose invalidation waits for exactly that work, and so
   * may an execution claim by the session the binding already records (`claimingSessionUuid`).
   */
  private async checkBinding(
    trx: Executor,
    key: BindingKey,
    expected: BindingBindingExpectation,
    {
      journaled = false,
      claimingSessionUuid,
    }: { journaled?: boolean; claimingSessionUuid?: string } = {},
  ): Promise<BindingAssignmentRecord | BindingCasFailure> {
    const scope = await this.readScope(trx, key.scopeKey);
    const current = await this.readAssignment(trx, key);
    if (
      !scopeAcceptsBindingChange(scope, journaled) &&
      !(
        claimingSessionUuid !== undefined &&
        scopeAcceptsSameSessionClaim(scope, current, claimingSessionUuid)
      )
    ) {
      return { kind: "scope_not_valid", scope };
    }
    if (!current) {
      return { kind: "binding_missing" };
    }
    if (!bindingMatches(current, expected)) {
      return { kind: "stale_binding", current };
    }
    return current;
  }

  private async hasLiveExecOwner(executor: Executor, scopeKey: string): Promise<boolean> {
    const rows = await executor
      .selectFrom("slot_assignments")
      .selectAll()
      .where("scope_key", "=", scopeKey)
      .where((eb) => eb.or([eb("exec_session_uuid", "is not", null), eb("state", "=", "settling")]))
      .execute();
    // A live settler still drives its released work, so it keeps the scope in use too.
    return rows.some((row) => !this.isSettled(toAssignment(row)));
  }

  /** A settling binding is settled once its settler is dead and no live execution owns it. */
  private isSettled(assignment: BindingAssignmentRecord): boolean {
    const { settler, execOwner } = assignment;
    return (
      (settler === null || !this.isExecOwnerLive(settler)) &&
      (execOwner === null || !this.isExecOwnerLive(execOwner))
    );
  }
}
