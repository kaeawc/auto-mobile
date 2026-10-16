import { BINDINGS_COORDINATION_SCOPE } from "../persistedIdentity";
export { BINDINGS_COORDINATION_SCOPE } from "../persistedIdentity";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { jsonArrayFrom } from "kysely/helpers/sqlite";
import { Kysely, type Generated, type Selectable, type Transaction, SqliteAdapter } from "kysely";
import { BunSqliteDialect } from "../../../db/bunSqliteDialect";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../../db/database";
import { classifySqliteError } from "../../../db/databaseFailureClassification";
import { errorMessage } from "../../../utils/describeUnknownError";
import { BindingDiscoveryIncompleteError } from "../provisioning/refusal";
import { isInMemoryDatabasePath } from "../../../db/migrationLock";
import { ActionableError } from "../../../models/ActionableError";
import { ensureSecureDirectorySync, getAdbServerScopedAutoMobileDir } from "../../../utils/tempDir";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { defaultBindingExecOwnerLiveness } from "./ownerLiveness";
import { SqliteSessionBrokerStore } from "../sqliteStore";
import type { BrokerRequestsTable, BrokerResourcesTable } from "../store";
import type { IdGenerator } from "../../../utils/IdGenerator";
import type { LegacySlotDeviceRetirement } from "./legacySlotDeviceRetirement";
import { SqliteLegacySlotRetirementStore } from "./sqliteLegacySlotRetirementStore";
import { migrateBindingRegistry, assertBindingRegistryCurrent } from "./bindingRegistryMigrations";
import {
  type BindingResourceSnapshot,
  isBindingJournalPhaseOpen,
  journalOwnersEqual,
  journalTargetEntries,
  sameBinding,
  scopeAcceptsSameSessionClaim,
  scopeAcceptsBindingChange,
  BINDING_JOURNAL_TERMINAL_PHASES,
  BINDING_JOURNAL_TERMINAL_RETENTION_MS,
  type AdvanceBindingJournalInput,
  type AdvanceBindingJournalResult,
  type ClaimBindingJournalResult,
  type OpenBindingJournalInput,
  type OpenBindingJournalResult,
  type BindingJournalAssignmentChange,
  type BindingJournalChangeFailure,
  type BindingJournalEntry,
  type BindingJournalKind,
  type BindingJournalOwner,
  type BindingJournalPhase,
  type BindingJournalTarget,
  assertSettlerForState,
  assertValidBindingKey,
  bindingMatches,
  computeBindingScopeKey,
  entersFencingState,
  type ClaimExecutionOptions,
  type ClaimExecutionResult,
  type CommitBindingResult,
  type DeviceHolder,
  type EnsureScopeResult,
  type InitBindingResult,
  type ManagedDeviceEntry,
  type ReleaseExecutionResult,
  type BindingAssignmentRecord,
  type BindingAssignmentState,
  type BindingBindingCommit,
  type BindingBindingExpectation,
  type BindingCasFailure,
  type BindingExecOwner,
  type BindingExecOwnerLiveness,
  type BindingInit,
  type BindingKey,
  type BindingPlatform,
  type BindingProcessIdentity,
  type BindingRegistry,
  type BindingScopeIdentity,
  type BindingScopeInvalidationReason,
  type BindingScopeRecord,
  type BindingScopeState,
  type UpdateBindingStateOptions,
  type UpdateBindingStateResult,
  assertPlatformChangeAllowed,
} from "./bindingRegistry";

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

interface BindingScopesTable {
  scope_key: string;
  managed_host_scope: string;
  runner_namespace: string;
  runner_incarnation: string;
  state: BindingScopeState;
  invalidation_reason: BindingScopeInvalidationReason | null;
  created_at_ms: number;
  last_acquired_at_ms: number;
  last_released_at_ms: number | null;
  invalidating_at_ms: number | null;
  invalidated_at_ms: number | null;
}

interface BindingAssignmentsTable {
  scope_key: string;
  slot_index: number;
  role: string;
  platform: BindingPlatform;
  generation: number;
  stable_device_id: string | null;
  device_name: string | null;
  requested_spec_json: string;
  resolved_spec_json: string | null;
  spec_fingerprint: string | null;
  state: BindingAssignmentState;
  exec_owner_daemon_id: string | null;
  exec_owner_pid: number | null;
  exec_owner_process_token: string | null;
  exec_session_uuid: string | null;
  settler_daemon_id: string | null;
  settler_pid: number | null;
  settler_process_token: string | null;
  updated_at_ms: number;
}

interface BindingJournalTable {
  id: Generated<number>;
  scope_key: string;
  slot_index: number;
  kind: BindingJournalKind;
  phase: BindingJournalPhase;
  platform: BindingPlatform;
  from_generation: number;
  to_generation: number | null;
  binding_generation: number;
  binding_stable_device_id: string | null;
  target_json: string;
  owner_daemon_id: string;
  owner_pid: number;
  owner_process_token: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface BindingRegistryDatabase {
  slot_scopes: BindingScopesTable;
  slot_assignments: BindingAssignmentsTable;
  slot_journal: BindingJournalTable;
  session_broker_requests: BrokerRequestsTable;
  session_broker_resources: BrokerResourcesTable;
}

type Executor = Kysely<BindingRegistryDatabase> | Transaction<BindingRegistryDatabase>;
type ScopeRow = Selectable<BindingScopesTable>;
type AssignmentRow = Selectable<BindingAssignmentsTable>;
type JournalRow = Selectable<BindingJournalTable>;

function toScope(row: ScopeRow): BindingScopeRecord {
  return {
    scopeKey: row.scope_key,
    managedHostScope: row.managed_host_scope,
    runnerNamespace: row.runner_namespace,
    runnerIncarnation: row.runner_incarnation,
    state: row.state,
    createdAtMs: row.created_at_ms,
    lastAcquiredAtMs: row.last_acquired_at_ms,
    lastReleasedAtMs: row.last_released_at_ms,
    invalidationReason: row.invalidation_reason,
    invalidatingAtMs: row.invalidating_at_ms,
    invalidatedAtMs: row.invalidated_at_ms,
  };
}

function parseSpecJson(json: string | null): unknown {
  if (json === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(json);
  return parsed;
}

function toExecOwner(row: AssignmentRow): BindingExecOwner | null {
  if (
    row.exec_owner_daemon_id === null ||
    row.exec_owner_pid === null ||
    row.exec_session_uuid === null
  ) {
    return null;
  }
  return {
    daemonId: row.exec_owner_daemon_id,
    pid: row.exec_owner_pid,
    sessionUuid: row.exec_session_uuid,
    processGenerationToken: row.exec_owner_process_token,
  };
}

function toSettler(row: AssignmentRow): BindingProcessIdentity | null {
  if (row.settler_daemon_id === null || row.settler_pid === null) {
    return null;
  }
  return {
    daemonId: row.settler_daemon_id,
    pid: row.settler_pid,
    processGenerationToken: row.settler_process_token,
  };
}

function settlerColumns(settler: BindingProcessIdentity | null) {
  return {
    settler_daemon_id: settler?.daemonId ?? null,
    settler_pid: settler?.pid ?? null,
    settler_process_token: settler?.processGenerationToken ?? null,
  };
}

function toAssignment(row: AssignmentRow): BindingAssignmentRecord {
  return {
    scopeKey: row.scope_key,
    bindingIndex: row.slot_index,
    role: row.role,
    platform: row.platform,
    generation: row.generation,
    stableDeviceId: row.stable_device_id,
    deviceName: row.device_name,
    requestedSpec: parseSpecJson(row.requested_spec_json),
    resolvedSpec: parseSpecJson(row.resolved_spec_json),
    specFingerprint: row.spec_fingerprint,
    state: row.state,
    execOwner: toExecOwner(row),
    settler: toSettler(row),
    updatedAtMs: row.updated_at_ms,
  };
}

function nullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ActionableError(`Binding journal target field '${field}' is not a string`);
  }
  return value;
}

function isBindingPlatform(value: unknown): value is BindingPlatform {
  return value === "android" || value === "ios";
}

export function parseJournalTarget(json: string): BindingJournalTarget {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new ActionableError("Binding journal target is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const newPlatform = record.newPlatform;
  if (newPlatform !== undefined && newPlatform !== null && !isBindingPlatform(newPlatform)) {
    throw new ActionableError("Binding journal target field 'newPlatform' is not a platform");
  }
  return {
    ...(newPlatform ? { newPlatform } : {}),
    ...(record.removalRequested === true ? { removalRequested: true as const } : {}),
    oldStableId: nullableString(record, "oldStableId"),
    oldName: nullableString(record, "oldName"),
    newName: nullableString(record, "newName"),
    newStableId: nullableString(record, "newStableId"),
    requestedSpec: record.requestedSpec ?? null,
    resolvedSpec: record.resolvedSpec ?? null,
    specFingerprint: nullableString(record, "specFingerprint"),
  };
}

function toJournalEntry(row: JournalRow): BindingJournalEntry {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    bindingIndex: row.slot_index,
    kind: row.kind,
    phase: row.phase,
    platform: row.platform,
    fromGeneration: row.from_generation,
    toGeneration: row.to_generation,
    binding: { generation: row.binding_generation, stableDeviceId: row.binding_stable_device_id },
    target: parseJournalTarget(row.target_json),
    owner: {
      daemonId: row.owner_daemon_id,
      pid: row.owner_pid,
      processGenerationToken: row.owner_process_token,
    },
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAtMs: row.next_attempt_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function serializeSpec(spec: unknown): string {
  const json = JSON.stringify(spec ?? null);
  if (json === undefined) {
    throw new ActionableError("Binding spec must be JSON-serializable");
  }
  return json;
}

/** The journal columns one advance writes: phase, merged target, binding and attempt bookkeeping. */
function journalAdvanceColumns(
  entry: BindingJournalEntry,
  input: AdvanceBindingJournalInput,
  assignment: BindingAssignmentRecord | null,
  nowMs: number,
) {
  return {
    phase: input.phase,
    target_json: serializeSpec({ ...entry.target, ...input.target }),
    to_generation:
      assignment && assignment.generation !== entry.binding.generation
        ? assignment.generation
        : entry.toGeneration,
    ...(assignment
      ? {
          binding_generation: assignment.generation,
          binding_stable_device_id: assignment.stableDeviceId,
        }
      : {}),
    ...(input.attempt
      ? {
          attempts: entry.attempts + 1,
          last_error: input.attempt.error,
          next_attempt_at_ms: input.attempt.nextAttemptAtMs,
        }
      : {}),
    updated_at_ms: nowMs,
  };
}

function assertOpenPhase(phase: BindingJournalPhase): void {
  if (!isBindingJournalPhaseOpen(phase)) {
    throw new ActionableError(`A binding journal entry cannot open at phase '${phase}'`);
  }
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

/** The slice of a bun:sqlite handle this module touches before handing it to the dialect. */
interface RegistrySqliteHandle {
  exec(sql: string): void;
  close(): void;
}

function openRegistrySqlite(dbPath: string): RegistrySqliteHandle {
  // Resolved lazily, like database.ts, so importing this module never requires the Bun runtime.
  const { Database } = require("bun:sqlite") as {
    Database: new (path: string) => RegistrySqliteHandle;
  };
  // The shared driver still finalizes statements, rejects queued work and closes the handle.
  // Only this registry handle skips its close-time maintenance: both PRAGMAs can each wait a
  // fresh busy_timeout behind a peer writer, even after a failed open. SQLite's automatic WAL
  // checkpoints and durable FULL-sync commits suffice; explicit shutdown truncation is optional.
  class RegistryDatabase extends Database {
    override exec(sql: string): void {
      if (sql === "PRAGMA optimize;" || sql === "PRAGMA wal_checkpoint(TRUNCATE);") {
        return;
      }
      super.exec(sql);
    }
  }
  const sqliteDb = new RegistryDatabase(dbPath);
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

// SQLite supports transactional DDL. Kysely's default SQLite adapter opts out; here a busy
// migration must roll back its ALTERs AND migration records before a factory retries the open.
// Kept registry-local so the per-daemon database retains its existing migration behavior.
class RegistrySqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}

class RegistrySqliteDialect extends BunSqliteDialect {
  override createAdapter(): SqliteAdapter {
    return new RegistrySqliteAdapter();
  }
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
  const db = new Kysely<BindingRegistryDatabase>({
    dialect: new RegistrySqliteDialect({
      database: () => openRegistrySqlite(dbPath),
      // Applies to BEGIN and autocommit statements: fail fast so the owning operation can retry
      // the whole unit. Migration DDL is atomic and opens are serialized by a file lock;
      // a busy open is forgotten by factories and refused retryably. Transaction bodies already
      // never retry. Initialization PRAGMAs use raw exec, outside dialect retry; close maintenance
      // is disabled on the registry handle so a failed open adds no more busy waits.
      retry: { maxAttempts: 1 },
    }),
  });
  try {
    if (options.migrate === false) {
      await assertBindingRegistryCurrent(db, dbPath);
    } else {
      await migrateBindingRegistry(
        db,
        dbPath,
        () =>
          options.legacyDeviceRetirement?.retire(new SqliteLegacySlotRetirementStore(db)) ??
          Promise.resolve(),
      );
    }
  } catch (error) {
    await db.destroy();
    if (classifySqliteError(error) === "retryable") {
      throw new BindingDiscoveryIncompleteError(errorMessage(error));
    }
    throw error;
  }
  return new SqliteBindingRegistry(db, options);
}

export class SqliteBindingRegistry implements BindingRegistry {
  private readonly timer: Timer;
  private readonly isExecOwnerLive: BindingExecOwnerLiveness;

  constructor(
    private readonly db: Kysely<BindingRegistryDatabase>,
    options: SqliteBindingRegistryOptions = {},
  ) {
    this.timer = options.timer ?? defaultTimer;
    this.isExecOwnerLive = options.isExecOwnerLive ?? defaultBindingExecOwnerLiveness;
  }

  /** Shares this connection, transaction lock and physical authority; never opens another DB. */
  sessionBrokerStore(scopeKey: string, ids?: IdGenerator): SqliteSessionBrokerStore {
    return new SqliteSessionBrokerStore(this.db, scopeKey, this.isExecOwnerLive, ids);
  }

  async ensureScope(identity: BindingScopeIdentity): Promise<EnsureScopeResult> {
    const scopeKey = computeBindingScopeKey(identity);
    return this.db.transaction().execute(async (trx): Promise<EnsureScopeResult> => {
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
      if (existing) {
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
    return this.db.transaction().execute(async (trx) => {
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
    return this.db.transaction().execute(async (trx) => {
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
    return this.db.transaction().execute((trx) => this.commitBindingIn(trx, key, expected, next));
  }

  private async commitBindingIn(
    trx: Executor,
    key: BindingKey,
    expected: BindingBindingExpectation,
    next: BindingBindingCommit,
    journaled = false,
  ): Promise<CommitBindingResult> {
    const resolvedSpecJson =
      next.resolvedSpec === null || next.resolvedSpec === undefined
        ? null
        : serializeSpec(next.resolvedSpec);
    const requestedSpecJson =
      next.requestedSpec === undefined ? undefined : serializeSpec(next.requestedSpec);
    const checked = await this.checkBinding(trx, key, expected, journaled);
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
    return this.db
      .transaction()
      .execute((trx) => this.updateBindingStateIn(trx, key, expected, state, settler));
  }

  private async updateBindingStateIn(
    trx: Executor,
    key: BindingKey,
    expected: BindingBindingExpectation,
    state: BindingAssignmentState,
    settler: BindingProcessIdentity | null,
    journaled = false,
  ): Promise<UpdateBindingStateResult> {
    const checked = await this.checkBinding(trx, key, expected, journaled);
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
    return this.db.transaction().execute(async (trx): Promise<ClaimExecutionResult> => {
      const checked = await this.checkBinding(trx, key, expected, false, owner.sessionUuid);
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
    return this.db.transaction().execute(async (trx) => {
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
    return this.db.transaction().execute(async (trx) => {
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
    return this.db.transaction().execute(async (trx): Promise<OpenBindingJournalResult> => {
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
    return this.db.transaction().execute(async (trx): Promise<AdvanceBindingJournalResult> => {
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
    return this.db.transaction().execute(async (trx): Promise<ClaimBindingJournalResult> => {
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
        ? await this.commitBindingIn(trx, key, change.expected, change.next, true)
        : await this.updateBindingStateIn(
            trx,
            key,
            change.expected,
            change.state,
            assertSettlerForState(change.state, change.options),
            true,
          );
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
    journaled = false,
    claimingSessionUuid?: string,
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
