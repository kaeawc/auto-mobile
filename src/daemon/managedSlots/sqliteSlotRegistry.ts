import { dirname, join } from "node:path";
import { Kysely, type Generated, type Selectable, type Transaction } from "kysely";
import { BunSqliteDialect } from "../../db/bunSqliteDialect";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../db/database";
import { isInMemoryDatabasePath } from "../../db/migrationLock";
import { ActionableError } from "../../models/ActionableError";
import { ensureSecureDirectorySync, getAdbServerScopedAutoMobileDir } from "../../utils/tempDir";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { defaultSlotExecOwnerLiveness } from "./slotOwnerLiveness";
import { migrateSlotRegistry } from "./slotRegistryMigrations";
import {
  isSlotJournalPhaseOpen,
  journalOwnersEqual,
  journalTargetEntries,
  sameBinding,
  scopeAcceptsSlotChange,
  SLOT_JOURNAL_TERMINAL_PHASES,
  SLOT_JOURNAL_TERMINAL_RETENTION_MS,
  type AdvanceSlotJournalInput,
  type AdvanceSlotJournalResult,
  type ClaimSlotJournalResult,
  type OpenSlotJournalInput,
  type OpenSlotJournalResult,
  type SlotJournalAssignmentChange,
  type SlotJournalChangeFailure,
  type SlotJournalEntry,
  type SlotJournalKind,
  type SlotJournalOwner,
  type SlotJournalPhase,
  type SlotJournalTarget,
  assertSettlerForState,
  assertValidSlotKey,
  bindingMatches,
  computeSlotScopeKey,
  entersFencingState,
  isPermanentInvalidationReason,
  isRevivableScope,
  lastScopeActivityMs,
  resolveAbandonmentThresholdMs,
  type AbandonmentQuery,
  type BeginScopeInvalidationResult,
  type ClaimExecutionOptions,
  type ClaimExecutionResult,
  type CommitBindingResult,
  type CompleteScopeInvalidationResult,
  type DeviceHolder,
  type EnsureScopeResult,
  type FreeSlotDeviceRecord,
  type InitSlotResult,
  type ManagedDeviceEntry,
  type MarkScopeAbandonedResult,
  type ReleaseExecutionResult,
  type SlotAssignmentRecord,
  type SlotAssignmentState,
  type SlotBindingCommit,
  type SlotBindingExpectation,
  type SlotCasFailure,
  type SlotExecOwner,
  type SlotExecOwnerLiveness,
  type SlotInit,
  type SlotKey,
  type SlotPlatform,
  type SlotProcessIdentity,
  type SlotRegistry,
  type SlotScopeIdentity,
  type SlotScopeInvalidationReason,
  type SlotScopeRecord,
  type SlotScopeState,
  type UpdateSlotStateOptions,
  type UpdateSlotStateResult,
} from "./slotRegistry";

/** Scope under the ADB-server coordination root: host-wide, independent of any one adb server. */
export const MANAGED_SLOTS_COORDINATION_SCOPE = "managed-slots";
export const MANAGED_SLOTS_REGISTRY_SUBDIR = "registry";
export const MANAGED_SLOTS_REGISTRY_FILE = "slots.sqlite";

/**
 * The host-wide registry path (#11174). It is NOT under `AUTOMOBILE_DATA_DIR`, `AUTOMOBILE_DB_DIR`
 * or the coordination dir, which can differ per daemon (worktree daemons included); every daemon
 * on the host resolves this same file under the user's home.
 *
 * `AUTOMOBILE_ADB_SERVER_COORDINATION_DIR` is the one override, and it creates a SEPARATE slot
 * authority (#11242 item 8). That is sound for Android only when the daemons sharing it also share
 * the AVD home; iOS simulators are host-global regardless, so two daemons with different overrides
 * must never manage slots on the same simulator set. Daemons that should share slots must resolve
 * the same override (or none).
 */
export function defaultSlotRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  return join(
    getAdbServerScopedAutoMobileDir(
      MANAGED_SLOTS_COORDINATION_SCOPE,
      MANAGED_SLOTS_REGISTRY_SUBDIR,
      env,
      homeDir,
    ),
    MANAGED_SLOTS_REGISTRY_FILE,
  );
}

interface SlotScopesTable {
  scope_key: string;
  managed_host_scope: string;
  runner_namespace: string;
  runner_incarnation: string;
  state: SlotScopeState;
  invalidation_reason: SlotScopeInvalidationReason | null;
  created_at_ms: number;
  last_acquired_at_ms: number;
  last_released_at_ms: number | null;
  invalidating_at_ms: number | null;
  invalidated_at_ms: number | null;
}

interface SlotAssignmentsTable {
  scope_key: string;
  slot_index: number;
  role: string;
  platform: SlotPlatform;
  generation: number;
  stable_device_id: string | null;
  device_name: string | null;
  requested_spec_json: string;
  resolved_spec_json: string | null;
  spec_fingerprint: string | null;
  state: SlotAssignmentState;
  exec_owner_daemon_id: string | null;
  exec_owner_pid: number | null;
  exec_owner_process_token: string | null;
  exec_session_uuid: string | null;
  settler_daemon_id: string | null;
  settler_pid: number | null;
  settler_process_token: string | null;
  updated_at_ms: number;
}

interface SlotFreeDevicesTable {
  platform: SlotPlatform;
  stable_device_id: string;
  spec_fingerprint: string | null;
  from_scope_key: string;
  freed_at_ms: number;
}

interface SlotJournalTable {
  id: Generated<number>;
  scope_key: string;
  slot_index: number;
  kind: SlotJournalKind;
  phase: SlotJournalPhase;
  platform: SlotPlatform;
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

export interface SlotRegistryDatabase {
  slot_scopes: SlotScopesTable;
  slot_assignments: SlotAssignmentsTable;
  slot_free_devices: SlotFreeDevicesTable;
  slot_journal: SlotJournalTable;
}

type Executor = Kysely<SlotRegistryDatabase> | Transaction<SlotRegistryDatabase>;
type ScopeRow = Selectable<SlotScopesTable>;
type AssignmentRow = Selectable<SlotAssignmentsTable>;
type FreeDeviceRow = Selectable<SlotFreeDevicesTable>;
type JournalRow = Selectable<SlotJournalTable>;

function toScope(row: ScopeRow): SlotScopeRecord {
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

function toExecOwner(row: AssignmentRow): SlotExecOwner | null {
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

function toSettler(row: AssignmentRow): SlotProcessIdentity | null {
  if (row.settler_daemon_id === null || row.settler_pid === null) {
    return null;
  }
  return {
    daemonId: row.settler_daemon_id,
    pid: row.settler_pid,
    processGenerationToken: row.settler_process_token,
  };
}

function settlerColumns(settler: SlotProcessIdentity | null) {
  return {
    settler_daemon_id: settler?.daemonId ?? null,
    settler_pid: settler?.pid ?? null,
    settler_process_token: settler?.processGenerationToken ?? null,
  };
}

function toAssignment(row: AssignmentRow): SlotAssignmentRecord {
  return {
    scopeKey: row.scope_key,
    slotIndex: row.slot_index,
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

function toFreeDevice(row: FreeDeviceRow): FreeSlotDeviceRecord {
  return {
    platform: row.platform,
    stableDeviceId: row.stable_device_id,
    specFingerprint: row.spec_fingerprint,
    fromScopeKey: row.from_scope_key,
    freedAtMs: row.freed_at_ms,
  };
}

function nullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ActionableError(`Managed slot journal target field '${field}' is not a string`);
  }
  return value;
}

function parseJournalTarget(json: string): SlotJournalTarget {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new ActionableError("Managed slot journal target is not an object");
  }
  const record = parsed as Record<string, unknown>;
  return {
    oldStableId: nullableString(record, "oldStableId"),
    oldName: nullableString(record, "oldName"),
    newName: nullableString(record, "newName"),
    newStableId: nullableString(record, "newStableId"),
    requestedSpec: record.requestedSpec ?? null,
    resolvedSpec: record.resolvedSpec ?? null,
    specFingerprint: nullableString(record, "specFingerprint"),
  };
}

function toJournalEntry(row: JournalRow): SlotJournalEntry {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    slotIndex: row.slot_index,
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
    throw new ActionableError("Managed slot spec must be JSON-serializable");
  }
  return json;
}

/** The journal columns one advance writes: phase, merged target, binding and attempt bookkeeping. */
function journalAdvanceColumns(
  entry: SlotJournalEntry,
  input: AdvanceSlotJournalInput,
  assignment: SlotAssignmentRecord | null,
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

function assertOpenPhase(phase: SlotJournalPhase): void {
  if (!isSlotJournalPhaseOpen(phase)) {
    throw new ActionableError(`A managed slot journal entry cannot open at phase '${phase}'`);
  }
}

export interface SqliteSlotRegistryOptions {
  timer?: Timer;
  /** Decides whether a recorded execution owner is alive. Defaults to PID + process generation. */
  isExecOwnerLive?: SlotExecOwnerLiveness;
}

export interface OpenSqliteSlotRegistryOptions extends SqliteSlotRegistryOptions {
  /** Defaults to {@link defaultSlotRegistryPath}. `:memory:` gives a private in-memory registry. */
  dbPath?: string;
}

/**
 * bun:sqlite waits for a busy lock synchronously, blocking this daemon's event loop (heartbeat
 * lease handling included) for up to the busy timeout per attempt of the dialect's bounded retry.
 * Registry transactions are a few short statements, so the registry waits far less than the
 * per-daemon DB's {@link SQLITE_BUSY_TIMEOUT_MS} and surfaces contention as a retryable busy error
 * instead of stalling (#11242 item 9). Keep registry transactions short and off the heartbeat path.
 */
export const MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS = Math.min(1_000, SQLITE_BUSY_TIMEOUT_MS);

/** The slice of a bun:sqlite handle this module touches before handing it to the dialect. */
interface RegistrySqliteHandle {
  exec(sql: string): void;
}

function openRegistrySqlite(dbPath: string): RegistrySqliteHandle {
  // Resolved lazily, like database.ts, so importing this module never requires the Bun runtime.
  const { Database } = require("bun:sqlite") as {
    Database: new (path: string) => RegistrySqliteHandle;
  };
  const sqliteDb = new Database(dbPath);
  sqliteDb.exec(`PRAGMA busy_timeout = ${MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS};`);
  sqliteDb.exec("PRAGMA journal_mode = WAL;");
  // Assignment authority must survive power loss; writes are rare, so pay for the fsync.
  sqliteDb.exec("PRAGMA synchronous = FULL;");
  sqliteDb.exec("PRAGMA foreign_keys = ON;");
  return sqliteDb;
}

/**
 * Open (creating and migrating as needed) the SQLite-backed slot registry. Each call opens its own
 * connection; every mutation runs in one `BEGIN IMMEDIATE` transaction, so registries in different
 * processes on the same file serialize through SQLite's write lock.
 */
export async function openSqliteSlotRegistry(
  options: OpenSqliteSlotRegistryOptions = {},
): Promise<SqliteSlotRegistry> {
  const dbPath = options.dbPath ?? defaultSlotRegistryPath();
  if (!isInMemoryDatabasePath(dbPath)) {
    ensureSecureDirectorySync(dirname(dbPath));
  }
  const db = new Kysely<SlotRegistryDatabase>({
    dialect: new BunSqliteDialect({ database: () => openRegistrySqlite(dbPath) }),
  });
  try {
    await migrateSlotRegistry(db, dbPath);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return new SqliteSlotRegistry(db, options);
}

export class SqliteSlotRegistry implements SlotRegistry {
  private readonly timer: Timer;
  private readonly isExecOwnerLive: SlotExecOwnerLiveness;

  constructor(
    private readonly db: Kysely<SlotRegistryDatabase>,
    options: SqliteSlotRegistryOptions = {},
  ) {
    this.timer = options.timer ?? defaultTimer;
    this.isExecOwnerLive = options.isExecOwnerLive ?? defaultSlotExecOwnerLiveness;
  }

  async ensureScope(identity: SlotScopeIdentity): Promise<EnsureScopeResult> {
    const scopeKey = computeSlotScopeKey(identity);
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
      // slots (all already invalidated, or the conflict above would have refused) are freed.
      const superseded = await trx
        .updateTable("slot_scopes")
        .set({ invalidation_reason: "incarnation_reset" })
        .where("managed_host_scope", "=", identity.managedHostScope)
        .where("runner_namespace", "=", identity.runnerNamespace)
        .where("invalidation_reason", "=", "abandoned")
        .returning("scope_key")
        .execute();
      for (const { scope_key } of superseded) {
        await this.releaseSlotsToFreePool(trx, scope_key);
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

  async getScope(scopeKey: string): Promise<SlotScopeRecord | null> {
    return this.readScope(this.db, scopeKey);
  }

  async initSlot(key: SlotKey, init: SlotInit): Promise<InitSlotResult> {
    assertValidSlotKey(key);
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
        slot_index: key.slotIndex,
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

  async commitBinding(
    key: SlotKey,
    expected: SlotBindingExpectation,
    next: SlotBindingCommit,
  ): Promise<CommitBindingResult> {
    assertValidSlotKey(key);
    return this.db.transaction().execute((trx) => this.commitBindingIn(trx, key, expected, next));
  }

  private async commitBindingIn(
    trx: Executor,
    key: SlotKey,
    expected: SlotBindingExpectation,
    next: SlotBindingCommit,
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
    let adoptedFreeDevice: FreeSlotDeviceRecord | null = null;
    if (next.stableDeviceId !== null) {
      const holder = await trx
        .selectFrom("slot_assignments")
        .selectAll()
        .where("platform", "=", checked.platform)
        .where("stable_device_id", "=", next.stableDeviceId)
        .where((eb) =>
          eb.or([eb("scope_key", "<>", key.scopeKey), eb("slot_index", "<>", key.slotIndex)]),
        )
        .executeTakeFirst();
      if (holder) {
        return { kind: "device_assigned_elsewhere", holder: toAssignment(holder) };
      }
      const free = await trx
        .deleteFrom("slot_free_devices")
        .where("platform", "=", checked.platform)
        .where("stable_device_id", "=", next.stableDeviceId)
        .returningAll()
        .executeTakeFirst();
      adoptedFreeDevice = free ? toFreeDevice(free) : null;
    }
    const deviceChanged = next.stableDeviceId !== checked.stableDeviceId;
    const updated = await trx
      .updateTable("slot_assignments")
      .set({
        generation: checked.generation + 1,
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
      .where("slot_index", "=", key.slotIndex)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { kind: "committed", assignment: toAssignment(updated), adoptedFreeDevice };
  }

  async updateSlotState(
    key: SlotKey,
    expected: SlotBindingExpectation,
    state: SlotAssignmentState,
    options?: UpdateSlotStateOptions,
  ): Promise<UpdateSlotStateResult> {
    assertValidSlotKey(key);
    const settler = assertSettlerForState(state, options);
    return this.db
      .transaction()
      .execute((trx) => this.updateSlotStateIn(trx, key, expected, state, settler));
  }

  private async updateSlotStateIn(
    trx: Executor,
    key: SlotKey,
    expected: SlotBindingExpectation,
    state: SlotAssignmentState,
    settler: SlotProcessIdentity | null,
    journaled = false,
  ): Promise<UpdateSlotStateResult> {
    const checked = await this.checkBinding(trx, key, expected, journaled);
    if ("kind" in checked) {
      return checked;
    }
    const owner = checked.execOwner;
    if (state === "replacing" && owner && this.isExecOwnerLive(owner)) {
      return { kind: "slot_in_use", owner, assignment: checked };
    }
    const generation = entersFencingState(checked.state, state)
      ? checked.generation + 1
      : checked.generation;
    const updated = await trx
      .updateTable("slot_assignments")
      .set({ state, generation, ...settlerColumns(settler), updated_at_ms: this.timer.now() })
      .where("scope_key", "=", key.scopeKey)
      .where("slot_index", "=", key.slotIndex)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { kind: "updated", assignment: toAssignment(updated) };
  }

  async claimExecution(
    key: SlotKey,
    expected: SlotBindingExpectation,
    owner: SlotExecOwner,
    options: ClaimExecutionOptions = {},
  ): Promise<ClaimExecutionResult> {
    assertValidSlotKey(key);
    return this.db.transaction().execute(async (trx): Promise<ClaimExecutionResult> => {
      const checked = await this.checkBinding(trx, key, expected);
      if ("kind" in checked) {
        return checked;
      }
      if (checked.state !== "ready" || checked.stableDeviceId === null) {
        return { kind: "slot_not_ready", assignment: checked };
      }
      const current = checked.execOwner;
      if (
        current &&
        current.sessionUuid !== owner.sessionUuid &&
        current.sessionUuid !== options.supersedesSessionUuid &&
        this.isExecOwnerLive(current)
      ) {
        return { kind: "slot_in_use", owner: current, assignment: checked };
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
        .where("slot_index", "=", key.slotIndex)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "claimed", assignment: toAssignment(updated) };
    });
  }

  async releaseExecution(key: SlotKey, sessionUuid: string): Promise<ReleaseExecutionResult> {
    assertValidSlotKey(key);
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
        .where("slot_index", "=", key.slotIndex)
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

  async recoverSettledSlots(scopeKey?: string): Promise<SlotAssignmentRecord[]> {
    return this.db.transaction().execute(async (trx) => {
      let query = trx.selectFrom("slot_assignments").selectAll().where("state", "=", "settling");
      if (scopeKey !== undefined) {
        query = query.where("scope_key", "=", scopeKey);
      }
      const settled = (await query.orderBy("scope_key").orderBy("slot_index").execute())
        .map(toAssignment)
        .filter((assignment) => this.isSettled(assignment));
      const recovered: SlotAssignmentRecord[] = [];
      for (const assignment of settled) {
        const row = await trx
          .updateTable("slot_assignments")
          .set({ state: "ready", ...settlerColumns(null), updated_at_ms: this.timer.now() })
          .where("scope_key", "=", assignment.scopeKey)
          .where("slot_index", "=", assignment.slotIndex)
          .where("generation", "=", assignment.generation)
          .where("state", "=", "settling")
          .returningAll()
          .executeTakeFirstOrThrow();
        recovered.push(toAssignment(row));
      }
      return recovered;
    });
  }

  async getAssignment(key: SlotKey): Promise<SlotAssignmentRecord | null> {
    assertValidSlotKey(key);
    return this.readAssignment(this.db, key);
  }

  async listAssignments(scopeKey: string): Promise<SlotAssignmentRecord[]> {
    const rows = await this.db
      .selectFrom("slot_assignments")
      .selectAll()
      .where("scope_key", "=", scopeKey)
      .orderBy("slot_index")
      .execute();
    return rows.map(toAssignment);
  }

  async findExecutionAssignments(sessionUuid: string): Promise<SlotAssignmentRecord[]> {
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
    platform: SlotPlatform,
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
        return { kind: "slot", scope, assignment: toAssignment(assignment) };
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

  async isDeviceAssignedToValidSlot(
    platform: SlotPlatform,
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
    const assigned = await this.db
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
      // A revivable (abandoned) scope's kept slots stay reserved for its returning incarnation.
      .where((eb) =>
        eb.or([
          eb("slot_scopes.state", "<>", "invalidated"),
          eb("slot_scopes.invalidation_reason", "=", "abandoned"),
        ]),
      )
      .execute();
    const free = await this.db.selectFrom("slot_free_devices").selectAll().execute();
    const pending = await this.listOpenSlotJournal();
    const entries: ManagedDeviceEntry[] = [
      ...assigned.flatMap((row): ManagedDeviceEntry[] =>
        row.stable_device_id === null
          ? []
          : [
              {
                platform: row.platform,
                stableDeviceId: row.stable_device_id,
                holder: "slot",
                scopeKey: row.scope_key,
                slotIndex: row.slot_index,
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
        slotIndex: null,
        scopeState: null,
        execSessionUuid: null,
      })),
    ];
    return [...entries, ...journalTargetEntries(pending, entries)];
  }

  async listFreeDevices(): Promise<FreeSlotDeviceRecord[]> {
    const rows = await this.db
      .selectFrom("slot_free_devices")
      .selectAll()
      .orderBy("freed_at_ms")
      .execute();
    return rows.map(toFreeDevice);
  }

  async beginScopeInvalidation(
    scopeKey: string,
    reason: SlotScopeInvalidationReason,
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
          .where("phase", "not in", [...SLOT_JOURNAL_TERMINAL_PHASES])
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
      // An abandoned scope stays revivable: keep its slots until the invalidation is permanent.
      const freedDevices =
        scope.invalidationReason === "abandoned"
          ? []
          : await this.releaseSlotsToFreePool(trx, scopeKey);
      const invalidated = await trx
        .updateTable("slot_scopes")
        .set({ state: "invalidated", invalidated_at_ms: nowMs })
        .where("scope_key", "=", scopeKey)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "invalidated", scope: toScope(invalidated), freedDevices };
    });
  }

  async findAbandonedScopes(query?: AbandonmentQuery): Promise<SlotScopeRecord[]> {
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
    const abandoned: SlotScopeRecord[] = [];
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

  async findReclaimableFreeDevices(query?: AbandonmentQuery): Promise<FreeSlotDeviceRecord[]> {
    const cutoffMs = this.timer.now() - resolveAbandonmentThresholdMs(query);
    const rows = await this.db
      .selectFrom("slot_free_devices")
      .selectAll()
      .where("freed_at_ms", "<=", cutoffMs)
      .orderBy("freed_at_ms")
      .execute();
    return rows.map(toFreeDevice);
  }

  async openSlotJournal(key: SlotKey, input: OpenSlotJournalInput): Promise<OpenSlotJournalResult> {
    assertValidSlotKey(key);
    assertOpenPhase(input.phase);
    const targetJson = serializeSpec(input.target);
    return this.db.transaction().execute(async (trx): Promise<OpenSlotJournalResult> => {
      const nowMs = this.timer.now();
      await trx
        .deleteFrom("slot_journal")
        .where("phase", "in", [...SLOT_JOURNAL_TERMINAL_PHASES])
        .where("updated_at_ms", "<", nowMs - SLOT_JOURNAL_TERMINAL_RETENTION_MS)
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
          slot_index: key.slotIndex,
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

  async advanceSlotJournal(
    id: number,
    input: AdvanceSlotJournalInput,
  ): Promise<AdvanceSlotJournalResult> {
    return this.db.transaction().execute(async (trx): Promise<AdvanceSlotJournalResult> => {
      const row = await trx
        .selectFrom("slot_journal")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      const entry = row ? toJournalEntry(row) : null;
      if (
        !entry ||
        !isSlotJournalPhaseOpen(entry.phase) ||
        entry.phase !== input.expectedPhase ||
        !journalOwnersEqual(entry.owner, input.owner)
      ) {
        return { kind: "journal_conflict", entry };
      }
      let assignment: SlotAssignmentRecord | null = null;
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

  async claimSlotJournal(
    id: number,
    expected: SlotJournalOwner,
    next: SlotJournalOwner,
  ): Promise<ClaimSlotJournalResult> {
    return this.db.transaction().execute(async (trx): Promise<ClaimSlotJournalResult> => {
      const row = await trx
        .selectFrom("slot_journal")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      const entry = row ? toJournalEntry(row) : null;
      if (
        !entry ||
        !isSlotJournalPhaseOpen(entry.phase) ||
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

  async getSlotJournal(id: number): Promise<SlotJournalEntry | null> {
    const row = await this.db
      .selectFrom("slot_journal")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toJournalEntry(row) : null;
  }

  async listOpenSlotJournal(key?: SlotKey): Promise<SlotJournalEntry[]> {
    let query = this.db
      .selectFrom("slot_journal")
      .selectAll()
      .where("phase", "not in", [...SLOT_JOURNAL_TERMINAL_PHASES]);
    if (key) {
      query = query.where("scope_key", "=", key.scopeKey).where("slot_index", "=", key.slotIndex);
    }
    const rows = await query.orderBy("next_attempt_at_ms").orderBy("id").execute();
    return rows.map(toJournalEntry);
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  private async readOpenJournal(
    executor: Executor,
    key: SlotKey,
  ): Promise<SlotJournalEntry | null> {
    const row = await executor
      .selectFrom("slot_journal")
      .selectAll()
      .where("scope_key", "=", key.scopeKey)
      .where("slot_index", "=", key.slotIndex)
      .where("phase", "not in", [...SLOT_JOURNAL_TERMINAL_PHASES])
      .executeTakeFirst();
    return row ? toJournalEntry(row) : null;
  }

  private async applyJournalAssignmentChange(
    trx: Executor,
    key: SlotKey,
    change: SlotJournalAssignmentChange,
  ): Promise<SlotAssignmentRecord | SlotJournalChangeFailure> {
    const result =
      change.kind === "commit"
        ? await this.commitBindingIn(trx, key, change.expected, change.next, true)
        : await this.updateSlotStateIn(
            trx,
            key,
            change.expected,
            change.state,
            assertSettlerForState(change.state, change.options),
            true,
          );
    return result.kind === "committed" || result.kind === "updated" ? result.assignment : result;
  }

  private async readScope(executor: Executor, scopeKey: string): Promise<SlotScopeRecord | null> {
    const row = await executor
      .selectFrom("slot_scopes")
      .selectAll()
      .where("scope_key", "=", scopeKey)
      .executeTakeFirst();
    return row ? toScope(row) : null;
  }

  private async readAssignment(
    executor: Executor,
    key: SlotKey,
  ): Promise<SlotAssignmentRecord | null> {
    const row = await executor
      .selectFrom("slot_assignments")
      .selectAll()
      .where("scope_key", "=", key.scopeKey)
      .where("slot_index", "=", key.slotIndex)
      .executeTakeFirst();
    return row ? toAssignment(row) : null;
  }

  /**
   * The shared CAS precondition: valid scope, existing slot, unchanged binding. Journaled work may
   * also settle in an `invalidating` scope, whose invalidation waits for exactly that work.
   */
  private async checkBinding(
    trx: Executor,
    key: SlotKey,
    expected: SlotBindingExpectation,
    journaled = false,
  ): Promise<SlotAssignmentRecord | SlotCasFailure> {
    const scope = await this.readScope(trx, key.scopeKey);
    if (!scopeAcceptsSlotChange(scope, journaled)) {
      return { kind: "scope_not_valid", scope };
    }
    const current = await this.readAssignment(trx, key);
    if (!current) {
      return { kind: "slot_missing" };
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

  /** A settling slot is settled once its settler is dead and no live execution owns it. */
  private isSettled(assignment: SlotAssignmentRecord): boolean {
    const { settler, execOwner } = assignment;
    return (
      (settler === null || !this.isExecOwnerLive(settler)) &&
      (execOwner === null || !this.isExecOwnerLive(execOwner))
    );
  }

  /**
   * Move a scope's bound devices to the free pool and remove its slots. Used when an invalidation
   * is (or becomes) permanent.
   */
  private async releaseSlotsToFreePool(
    trx: Executor,
    scopeKey: string,
  ): Promise<FreeSlotDeviceRecord[]> {
    const assignments = (
      await trx
        .selectFrom("slot_assignments")
        .selectAll()
        .where("scope_key", "=", scopeKey)
        .orderBy("slot_index")
        .execute()
    ).map(toAssignment);
    const nowMs = this.timer.now();
    const freedDevices = assignments.flatMap((assignment): FreeSlotDeviceRecord[] =>
      assignment.stableDeviceId === null
        ? []
        : [
            {
              platform: assignment.platform,
              stableDeviceId: assignment.stableDeviceId,
              specFingerprint: assignment.specFingerprint,
              fromScopeKey: scopeKey,
              freedAtMs: nowMs,
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
   * the scope was already invalidated, its kept slots are freed now.
   */
  private async makeResetPermanent(
    trx: Executor,
    scope: SlotScopeRecord,
    reason: SlotScopeInvalidationReason,
  ): Promise<SlotScopeRecord> {
    if (!isRevivableScope(scope) || !isPermanentInvalidationReason(reason)) {
      return scope;
    }
    if (scope.state === "invalidated") {
      await this.releaseSlotsToFreePool(trx, scope.scopeKey);
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
    scope: SlotScopeRecord,
    reason: SlotScopeInvalidationReason,
  ): Promise<SlotScopeRecord> {
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
