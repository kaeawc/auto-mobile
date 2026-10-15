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
import { migrateBindingRegistry } from "./bindingRegistryMigrations";
import {
  isAbandonedScope,
  sameFreeDevice,
  journalNamesFreeDevice,
  type FreeDeviceIdentity,
  type BeginFreeDeviceDeletionResult,
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
  isPermanentInvalidationReason,
  isRevivableScope,
  lastScopeActivityMs,
  resolveAbandonmentThresholdMs,
  FREE_DEVICE_STOP_CLAIM_STALE_MS,
  type AbandonmentQuery,
  type BeginFreeDeviceStopResult,
  type BeginScopeInvalidationResult,
  type ClaimExecutionOptions,
  type ClaimExecutionResult,
  type CommitBindingResult,
  type CompleteScopeInvalidationResult,
  type DeviceHolder,
  type EnsureScopeResult,
  type FreeDeviceState,
  type FreeDeviceStopClaim,
  type FreeBindingDeviceRecord,
  type InitBindingResult,
  type ManagedDeviceEntry,
  type MarkScopeAbandonedResult,
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
  type BindingScopeQuery,
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

interface BindingFreeDevicesTable {
  platform: BindingPlatform;
  stable_device_id: string;
  spec_fingerprint: string | null;
  from_scope_key: string;
  freed_at_ms: number;
  state: Generated<FreeDeviceState>;
  stop_claimed_by: string | null;
  stop_claimed_at_ms: number | null;
  deletion_owner_daemon_id: string | null;
  deletion_owner_pid: number | null;
  deletion_owner_process_token: string | null;
  deletion_started_at_ms: number | null;
  deletion_attempts: number | null;
  deletion_failed_deletes: number | null;
  deletion_last_error: string | null;
  deletion_next_attempt_at_ms: number | null;
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
  slot_free_devices: BindingFreeDevicesTable;
  slot_journal: BindingJournalTable;
  session_broker_requests: BrokerRequestsTable;
  session_broker_resources: BrokerResourcesTable;
}

type Executor = Kysely<BindingRegistryDatabase> | Transaction<BindingRegistryDatabase>;
type ScopeRow = Selectable<BindingScopesTable>;
type AssignmentRow = Selectable<BindingAssignmentsTable>;
type FreeDeviceRow = Selectable<BindingFreeDevicesTable>;
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

function toFreeDevice(row: FreeDeviceRow): FreeBindingDeviceRecord {
  return {
    platform: row.platform,
    stableDeviceId: row.stable_device_id,
    specFingerprint: row.spec_fingerprint,
    fromScopeKey: row.from_scope_key,
    freedAtMs: row.freed_at_ms,
    state: row.state,
    stopClaimedBy: row.stop_claimed_by,
    stopClaimedAtMs: row.stop_claimed_at_ms,
    deletion:
      row.deletion_owner_daemon_id === null
        ? null
        : {
            owner: {
              daemonId: row.deletion_owner_daemon_id,
              pid: row.deletion_owner_pid!,
              processGenerationToken: row.deletion_owner_process_token,
            },
            startedAtMs: row.deletion_started_at_ms!,
            attempts: row.deletion_attempts!,
            failedDeletes: row.deletion_failed_deletes ?? 0,
            lastError: row.deletion_last_error,
            nextAttemptAtMs: row.deletion_next_attempt_at_ms!,
          },
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

function parseJournalTarget(json: string): BindingJournalTarget {
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
    await migrateBindingRegistry(db, dbPath);
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
      if (existing && !isRevivableScope(existing)) {
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
      // A newer incarnation supersedes every abandoned one of this namespace for good: their kept
      // bindings (all already invalidated, or the conflict above would have refused) are freed.
      const superseded = await trx
        .updateTable("slot_scopes")
        .set({ invalidation_reason: "incarnation_reset" })
        .where("managed_host_scope", "=", identity.managedHostScope)
        .where("runner_namespace", "=", identity.runnerNamespace)
        .where("invalidation_reason", "=", "abandoned")
        .returning("scope_key")
        .execute();
      for (const { scope_key } of superseded) {
        await this.releaseBindingsToFreePool(trx, scope_key);
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
    let adoptedFreeDevice: FreeBindingDeviceRecord | null = null;
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
      const taken = await this.takeFreeDevice(trx, platform, next.stableDeviceId);
      if (taken === "stopping") {
        // A reclaim sweep is shutting this device down; adopting now would race that shutdown.
        return { kind: "free_device_stopping" };
      }
      adoptedFreeDevice = taken;
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
    return { kind: "committed", assignment: toAssignment(updated), adoptedFreeDevice };
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
    const free = await this.db
      .selectFrom("slot_free_devices")
      .selectAll()
      .where("platform", "=", platform)
      .where("stable_device_id", "=", stableDeviceId)
      .executeTakeFirst();
    return free ? { kind: "free", device: toFreeDevice(free) } : null;
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
    return (await this.snapshotResources(false)).managed;
  }

  async snapshotBindingResources(): Promise<BindingResourceSnapshot> {
    return this.snapshotResources(true);
  }

  private async snapshotResources(
    includeAbandonedScopes: boolean,
  ): Promise<BindingResourceSnapshot> {
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
            .selectFrom("slot_free_devices")
            .select([
              "platform",
              "stable_device_id",
              "spec_fingerprint",
              "from_scope_key",
              "freed_at_ms",
              "state",
              "stop_claimed_by",
              "stop_claimed_at_ms",
              "deletion_owner_daemon_id",
              "deletion_owner_pid",
              "deletion_owner_process_token",
              "deletion_started_at_ms",
              "deletion_attempts",
              "deletion_failed_deletes",
              "deletion_last_error",
              "deletion_next_attempt_at_ms",
            ]),
        )
          .$castTo<string>()
          .as("free"),
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
      .$if(includeAbandonedScopes, (query) =>
        query.select(
          jsonArrayFrom(
            this.db
              .selectFrom("slot_scopes")
              .select("scope_key")
              .where("state", "=", "invalidating")
              .where("invalidation_reason", "=", "abandoned"),
          )
            .$castTo<string>()
            .as("abandonedScopeKeys"),
        ),
      )
      .executeTakeFirstOrThrow();
    // Decode only the aggregate arrays; target_json must remain a string for the journal codec.
    const assigned: Awaited<ReturnType<typeof assignedQuery.execute>> = JSON.parse(
      snapshot.assigned,
    );
    const free: FreeDeviceRow[] = JSON.parse(snapshot.free);
    const pendingRows: JournalRow[] = JSON.parse(snapshot.pending);
    const abandoned: Array<{ scope_key: string }> = JSON.parse(snapshot.abandonedScopeKeys ?? "[]");
    const pending = pendingRows.map(toJournalEntry);
    const entries: ManagedDeviceEntry[] = [
      ...assigned.flatMap((row): ManagedDeviceEntry[] =>
        row.stable_device_id === null
          ? []
          : [
              {
                platform: row.platform,
                stableDeviceId: row.stable_device_id,
                holder: "binding",
                scopeKey: row.scope_key,
                bindingIndex: row.slot_index,
                scopeState: row.scope_state,
                execSessionUuid: row.exec_session_uuid,
              },
            ],
      ),
      ...free.map((row): ManagedDeviceEntry => ({
        platform: row.platform,
        stableDeviceId: row.stable_device_id,
        holder: "free",
        scopeKey: row.from_scope_key,
        bindingIndex: null,
        scopeState: null,
        execSessionUuid: null,
      })),
    ];
    return {
      managed: [...entries, ...journalTargetEntries(pending, entries)],
      free: free.map(toFreeDevice),
      openJournal: pending,
      abandonedScopeKeys: abandoned.map((row) => row.scope_key),
    };
  }

  async listFreeDevices(): Promise<FreeBindingDeviceRecord[]> {
    const rows = await this.db
      .selectFrom("slot_free_devices")
      .selectAll()
      .orderBy("freed_at_ms")
      .execute();
    return rows.map(toFreeDevice);
  }

  async beginScopeInvalidation(
    scopeKey: string,
    reason: BindingScopeInvalidationReason,
  ): Promise<BeginScopeInvalidationResult> {
    return this.db.transaction().execute(async (trx): Promise<BeginScopeInvalidationResult> => {
      const scope = await this.readScope(trx, scopeKey);
      if (!scope) {
        return { kind: "not_found" };
      }
      if (scope.state === "valid") {
        return { kind: "invalidating", scope: await this.markInvalidating(trx, scope, reason) };
      }
      const current = await this.makeResetPermanent(trx, scope, reason);
      return current.state === "invalidating"
        ? { kind: "already_invalidating", scope: current }
        : { kind: "already_invalidated", scope: current };
    });
  }

  async completeScopeInvalidation(scopeKey: string): Promise<CompleteScopeInvalidationResult> {
    return this.db.transaction().execute(async (trx): Promise<CompleteScopeInvalidationResult> => {
      const scope = await this.readScope(trx, scopeKey);
      if (!scope) {
        return { kind: "not_found" };
      }
      if (scope.state === "invalidated") {
        return { kind: "already_invalidated", scope };
      }
      if (scope.state !== "invalidating") {
        return { kind: "not_invalidating", scope };
      }
      const assignments = (
        await trx
          .selectFrom("slot_assignments")
          .selectAll()
          .where("scope_key", "=", scopeKey)
          .execute()
      ).map(toAssignment);
      const liveOwners = assignments.filter(
        (assignment) => assignment.execOwner !== null && this.isExecOwnerLive(assignment.execOwner),
      );
      const settling = assignments.filter(
        (assignment) => assignment.state === "settling" && !this.isSettled(assignment),
      );
      const cleanupPending = assignments.filter(
        (assignment) => assignment.state === "cleanup_pending",
      );
      const openJournal = (
        await trx
          .selectFrom("slot_journal")
          .selectAll()
          .where("scope_key", "=", scopeKey)
          .where("phase", "not in", [...BINDING_JOURNAL_TERMINAL_PHASES])
          .orderBy("id")
          .execute()
      ).map(toJournalEntry);
      if (
        liveOwners.length > 0 ||
        settling.length > 0 ||
        cleanupPending.length > 0 ||
        openJournal.length > 0
      ) {
        return { kind: "pending", scope, liveOwners, settling, cleanupPending, openJournal };
      }
      const nowMs = this.timer.now();
      // An abandoned scope stays revivable: keep its bindings until the invalidation is permanent.
      const freedDevices =
        scope.invalidationReason === "abandoned"
          ? []
          : await this.releaseBindingsToFreePool(trx, scopeKey);
      const invalidated = await trx
        .updateTable("slot_scopes")
        .set({ state: "invalidated", invalidated_at_ms: nowMs })
        .where("scope_key", "=", scopeKey)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "invalidated", scope: toScope(invalidated), freedDevices };
    });
  }

  async findAbandonedScopes(query?: AbandonmentQuery): Promise<BindingScopeRecord[]> {
    const cutoffMs = this.timer.now() - resolveAbandonmentThresholdMs(query);
    const candidates = (
      await this.db
        .selectFrom("slot_scopes")
        .selectAll()
        .where("state", "=", "valid")
        .where("last_acquired_at_ms", "<=", cutoffMs)
        .execute()
    )
      .map(toScope)
      .filter((scope) => lastScopeActivityMs(scope) <= cutoffMs)
      .sort((a, b) => lastScopeActivityMs(a) - lastScopeActivityMs(b));
    const abandoned: BindingScopeRecord[] = [];
    for (const scope of candidates) {
      if (!(await this.hasLiveExecOwner(this.db, scope.scopeKey))) {
        abandoned.push(scope);
      }
    }
    return abandoned;
  }

  async markScopeAbandoned(
    scopeKey: string,
    query?: AbandonmentQuery,
  ): Promise<MarkScopeAbandonedResult> {
    const thresholdMs = resolveAbandonmentThresholdMs(query);
    return this.db.transaction().execute(async (trx): Promise<MarkScopeAbandonedResult> => {
      const scope = await this.readScope(trx, scopeKey);
      if (!scope) {
        return { kind: "not_found" };
      }
      if (scope.state !== "valid") {
        return { kind: "not_abandoned", scope, reason: "not_valid" };
      }
      if (lastScopeActivityMs(scope) > this.timer.now() - thresholdMs) {
        return { kind: "not_abandoned", scope, reason: "recent_acquisition" };
      }
      if (await this.hasLiveExecOwner(trx, scopeKey)) {
        return { kind: "not_abandoned", scope, reason: "live_owner" };
      }
      return { kind: "marked", scope: await this.markInvalidating(trx, scope, "abandoned") };
    });
  }

  async findReclaimableFreeDevices(query?: AbandonmentQuery): Promise<FreeBindingDeviceRecord[]> {
    const cutoffMs = this.timer.now() - resolveAbandonmentThresholdMs(query);
    const rows = await this.db
      .selectFrom("slot_free_devices")
      .selectAll()
      .where("freed_at_ms", "<=", cutoffMs)
      .where("state", "<>", "stopped")
      .where("deletion_owner_daemon_id", "is", null)
      .orderBy("freed_at_ms")
      .execute();
    return rows.map(toFreeDevice);
  }

  private freeRow(trx: Executor, row: FreeDeviceIdentity) {
    return trx
      .selectFrom("slot_free_devices")
      .selectAll()
      .where("platform", "=", row.platform)
      .where("stable_device_id", "=", row.stableDeviceId)
      .where("from_scope_key", "=", row.fromScopeKey)
      .where("freed_at_ms", "=", row.freedAtMs)
      .executeTakeFirst();
  }

  async beginFreeDeviceDeletion(
    row: FreeDeviceIdentity,
    owner: BindingJournalOwner,
  ): Promise<BeginFreeDeviceDeletionResult> {
    return this.db.transaction().execute(async (trx): Promise<BeginFreeDeviceDeletionResult> => {
      const current = await this.freeRow(trx, row);
      if (!current || !sameFreeDevice(toFreeDevice(current), row)) {
        return { kind: "not_evictable", reason: "row_moved" };
      }
      if (current.deletion_owner_daemon_id !== null || current.state === "stopping") {
        return { kind: "not_evictable", reason: "deletion_pending_or_stopping" };
      }
      const bound = await trx
        .selectFrom("slot_assignments")
        .select("scope_key")
        .where("platform", "=", row.platform)
        .where("stable_device_id", "=", row.stableDeviceId)
        .executeTakeFirst();
      if (bound) {
        return { kind: "not_evictable", reason: "assigned" };
      }
      const journal = await trx
        .selectFrom("slot_journal")
        .selectAll()
        .where("phase", "not in", BINDING_JOURNAL_TERMINAL_PHASES)
        .execute();
      if (journal.some((entry) => journalNamesFreeDevice(toJournalEntry(entry), row))) {
        return { kind: "not_evictable", reason: "journal_open" };
      }
      const marked = await trx
        .updateTable("slot_free_devices")
        .set({
          deletion_owner_daemon_id: owner.daemonId,
          deletion_owner_pid: owner.pid,
          deletion_owner_process_token: owner.processGenerationToken ?? null,
          deletion_started_at_ms: this.timer.now(),
          deletion_attempts: 0,
          deletion_failed_deletes: 0,
          deletion_last_error: null,
          deletion_next_attempt_at_ms: this.timer.now(),
        })
        .where("platform", "=", row.platform)
        .where("stable_device_id", "=", row.stableDeviceId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "begun", row: toFreeDevice(marked) };
    });
  }

  private async ownsFreeDeletion(
    trx: Executor,
    row: FreeDeviceIdentity,
    owner: BindingJournalOwner,
  ) {
    const found = await this.freeRow(trx, row);
    const record = found && toFreeDevice(found);
    return record?.deletion && journalOwnersEqual(record.deletion.owner, owner) ? record : null;
  }

  async recordFreeDeviceDeletionAttempt(
    row: FreeDeviceIdentity,
    owner: BindingJournalOwner,
    attempt: { error: string; nextAttemptAtMs: number; nativeDeleteFailed?: boolean },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.ownsFreeDeletion(trx, row, owner);
      if (!current?.deletion) {
        return false;
      }
      await trx
        .updateTable("slot_free_devices")
        .set({
          deletion_attempts: current.deletion.attempts + 1,
          deletion_failed_deletes:
            current.deletion.failedDeletes + Number(attempt.nativeDeleteFailed === true),
          deletion_last_error: attempt.error,
          deletion_next_attempt_at_ms: attempt.nextAttemptAtMs,
        })
        .where("platform", "=", row.platform)
        .where("stable_device_id", "=", row.stableDeviceId)
        .execute();
      return true;
    });
  }

  async completeFreeDeviceDeletion(
    row: FreeDeviceIdentity,
    owner: BindingJournalOwner,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.ownsFreeDeletion(trx, row, owner))) {
        return false;
      }
      await trx
        .deleteFrom("slot_free_devices")
        .where("platform", "=", row.platform)
        .where("stable_device_id", "=", row.stableDeviceId)
        .execute();
      return true;
    });
  }

  async claimFreeDeviceDeletion(
    row: FreeDeviceIdentity,
    expectedOwner: BindingJournalOwner,
    nextOwner: BindingJournalOwner,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.ownsFreeDeletion(trx, row, expectedOwner))) {
        return false;
      }
      await trx
        .updateTable("slot_free_devices")
        .set({
          deletion_owner_daemon_id: nextOwner.daemonId,
          deletion_owner_pid: nextOwner.pid,
          deletion_owner_process_token: nextOwner.processGenerationToken ?? null,
        })
        .where("platform", "=", row.platform)
        .where("stable_device_id", "=", row.stableDeviceId)
        .execute();
      return true;
    });
  }

  async listFreeDeviceDeletions(): Promise<FreeBindingDeviceRecord[]> {
    const rows = await this.db
      .selectFrom("slot_free_devices")
      .selectAll()
      .where("deletion_owner_daemon_id", "is not", null)
      .orderBy("deletion_next_attempt_at_ms")
      .execute();
    return rows.map(toFreeDevice);
  }

  async beginFreeDeviceStop(
    claim: FreeDeviceStopClaim,
    query?: AbandonmentQuery,
  ): Promise<BeginFreeDeviceStopResult> {
    const nowMs = this.timer.now();
    const cutoffMs = nowMs - resolveAbandonmentThresholdMs(query);
    const staleBeforeMs = nowMs - FREE_DEVICE_STOP_CLAIM_STALE_MS;
    const claimed = await this.db
      .updateTable("slot_free_devices")
      .set({ state: "stopping", stop_claimed_by: claim.claimedBy, stop_claimed_at_ms: nowMs })
      .where("deletion_owner_daemon_id", "is", null)
      .where("platform", "=", claim.platform)
      .where("stable_device_id", "=", claim.stableDeviceId)
      .where("freed_at_ms", "=", claim.freedAtMs)
      .where("freed_at_ms", "<=", cutoffMs)
      .where((eb) =>
        eb.or([
          eb("state", "=", "free"),
          eb.and([
            eb("state", "=", "stopping"),
            eb.or([
              eb("stop_claimed_by", "=", claim.claimedBy),
              eb("stop_claimed_at_ms", "is", null),
              eb("stop_claimed_at_ms", "<=", staleBeforeMs),
            ]),
          ]),
        ]),
      )
      .returning("stable_device_id")
      .executeTakeFirst();
    return claimed ? { kind: "begun" } : { kind: "not_reclaimable" };
  }

  async holdsFreeDeviceStop(claim: FreeDeviceStopClaim): Promise<boolean> {
    const row = await this.db
      .selectFrom("slot_free_devices")
      .select("stable_device_id")
      .where("platform", "=", claim.platform)
      .where("stable_device_id", "=", claim.stableDeviceId)
      .where("freed_at_ms", "=", claim.freedAtMs)
      .where("state", "=", "stopping")
      .where("stop_claimed_by", "=", claim.claimedBy)
      .executeTakeFirst();
    return row !== undefined;
  }

  async completeFreeDeviceStop(claim: FreeDeviceStopClaim): Promise<boolean> {
    return this.releaseFreeDeviceStop(claim, "stopped");
  }

  async revertFreeDeviceStop(claim: FreeDeviceStopClaim): Promise<boolean> {
    return this.releaseFreeDeviceStop(claim, "free");
  }

  private async releaseFreeDeviceStop(
    claim: FreeDeviceStopClaim,
    next: "free" | "stopped",
  ): Promise<boolean> {
    const updated = await this.db
      .updateTable("slot_free_devices")
      .set({ state: next, stop_claimed_by: null, stop_claimed_at_ms: null })
      .where("platform", "=", claim.platform)
      .where("stable_device_id", "=", claim.stableDeviceId)
      .where("freed_at_ms", "=", claim.freedAtMs)
      .where("state", "=", "stopping")
      .where("stop_claimed_by", "=", claim.claimedBy)
      .returning("stable_device_id")
      .executeTakeFirst();
    return updated !== undefined;
  }

  openBindingJournal(
    key: BindingKey,
    input: OpenBindingJournalInput & { requireAbandonedScope?: false },
  ): Promise<Exclude<OpenBindingJournalResult, { kind: "scope_not_abandoned" }>>;
  openBindingJournal(
    key: BindingKey,
    input: OpenBindingJournalInput,
  ): Promise<OpenBindingJournalResult>;
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
      if (input.requireAbandonedScope) {
        const scope = await this.readScope(trx, key.scopeKey);
        if (!isAbandonedScope(scope)) {
          return { kind: "scope_not_abandoned", scope };
        }
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

  async findScopes(query: BindingScopeQuery): Promise<BindingScopeRecord[]> {
    let select = this.db
      .selectFrom("slot_scopes")
      .selectAll()
      .where("runner_namespace", "=", query.runnerNamespace)
      .where("runner_incarnation", "=", query.runnerIncarnation);
    if (query.managedHostScope !== undefined) {
      select = select.where("managed_host_scope", "=", query.managedHostScope);
    }
    const rows = await select.orderBy("created_at_ms").orderBy("scope_key").execute();
    return rows.map(toScope);
  }

  async listAbandonedScopes(): Promise<BindingScopeRecord[]> {
    const rows = await this.db
      .selectFrom("slot_scopes")
      .selectAll()
      .where("state", "=", "invalidating")
      .where("invalidation_reason", "=", "abandoned")
      .orderBy("invalidating_at_ms")
      .execute();
    return rows.map(toScope);
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

  /** Take a device out of the free pool for adoption, unless a reclaim sweep is stopping it. */
  private async takeFreeDevice(
    trx: Executor,
    platform: BindingPlatform,
    stableDeviceId: string,
  ): Promise<FreeBindingDeviceRecord | "stopping" | null> {
    const taken = await trx
      .deleteFrom("slot_free_devices")
      .where("deletion_owner_daemon_id", "is", null)
      .where("platform", "=", platform)
      .where("stable_device_id", "=", stableDeviceId)
      .where((eb) =>
        eb.or([
          eb("state", "<>", "stopping"),
          eb("stop_claimed_at_ms", "is", null),
          eb("stop_claimed_at_ms", "<=", this.timer.now() - FREE_DEVICE_STOP_CLAIM_STALE_MS),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
    if (taken) {
      return toFreeDevice(taken);
    }
    const stopping = await trx
      .selectFrom("slot_free_devices")
      .select("state")
      .where("platform", "=", platform)
      .where("stable_device_id", "=", stableDeviceId)
      .executeTakeFirst();
    return stopping ? "stopping" : null;
  }

  /**
   * Move a scope's bound devices to the free pool and remove its bindings. Used when an invalidation
   * is (or becomes) permanent.
   */
  private async releaseBindingsToFreePool(
    trx: Executor,
    scopeKey: string,
  ): Promise<FreeBindingDeviceRecord[]> {
    const assignments = (
      await trx
        .selectFrom("slot_assignments")
        .selectAll()
        .where("scope_key", "=", scopeKey)
        .orderBy("slot_index")
        .execute()
    ).map(toAssignment);
    const nowMs = this.timer.now();
    const freedDevices = assignments.flatMap((assignment): FreeBindingDeviceRecord[] =>
      assignment.stableDeviceId === null
        ? []
        : [
            {
              platform: assignment.platform,
              stableDeviceId: assignment.stableDeviceId,
              specFingerprint: assignment.specFingerprint,
              fromScopeKey: scopeKey,
              freedAtMs: nowMs,
              state: "free",
              stopClaimedBy: null,
              stopClaimedAtMs: null,
              deletion: null,
            },
          ],
    );
    await trx.deleteFrom("slot_assignments").where("scope_key", "=", scopeKey).execute();
    if (freedDevices.length > 0) {
      await trx
        .insertInto("slot_free_devices")
        .values(
          freedDevices.map((device) => ({
            platform: device.platform,
            stable_device_id: device.stableDeviceId,
            spec_fingerprint: device.specFingerprint,
            from_scope_key: device.fromScopeKey,
            freed_at_ms: device.freedAtMs,
          })),
        )
        .execute();
    }
    return freedDevices;
  }

  /**
   * An explicit reset of an abandoned scope replaces the revivable reason with the reset's; when
   * the scope was already invalidated, its kept bindings are freed now.
   */
  private async makeResetPermanent(
    trx: Executor,
    scope: BindingScopeRecord,
    reason: BindingScopeInvalidationReason,
  ): Promise<BindingScopeRecord> {
    if (!isRevivableScope(scope) || !isPermanentInvalidationReason(reason)) {
      return scope;
    }
    if (scope.state === "invalidated") {
      await this.releaseBindingsToFreePool(trx, scope.scopeKey);
    }
    const row = await trx
      .updateTable("slot_scopes")
      .set({ invalidation_reason: reason })
      .where("scope_key", "=", scope.scopeKey)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toScope(row);
  }

  private async markInvalidating(
    trx: Executor,
    scope: BindingScopeRecord,
    reason: BindingScopeInvalidationReason,
  ): Promise<BindingScopeRecord> {
    const row = await trx
      .updateTable("slot_scopes")
      .set({
        state: "invalidating",
        invalidation_reason: reason,
        invalidating_at_ms: this.timer.now(),
      })
      .where("scope_key", "=", scope.scopeKey)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toScope(row);
  }
}
