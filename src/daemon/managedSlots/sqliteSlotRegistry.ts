import { dirname, join } from "node:path";
import { Kysely, type Selectable, type Transaction } from "kysely";
import { BunSqliteDialect } from "../../db/bunSqliteDialect";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../db/database";
import { isInMemoryDatabasePath } from "../../db/migrationLock";
import { ActionableError } from "../../models/ActionableError";
import { ensureSecureDirectorySync, getAdbServerScopedAutoMobileDir } from "../../utils/tempDir";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { defaultSlotExecOwnerLiveness } from "./slotOwnerLiveness";
import { migrateSlotRegistry } from "./slotRegistryMigrations";
import {
  assertValidSlotKey,
  bindingMatches,
  computeSlotScopeKey,
  entersFencingState,
  isPermanentInvalidationReason,
  isRevivableScope,
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
  type SlotRegistry,
  type SlotScopeIdentity,
  type SlotScopeInvalidationReason,
  type SlotScopeRecord,
  type SlotScopeState,
  type UpdateSlotStateResult,
} from "./slotRegistry";

/** Scope under the ADB-server coordination root: host-wide, independent of any one adb server. */
export const MANAGED_SLOTS_COORDINATION_SCOPE = "managed-slots";
export const MANAGED_SLOTS_REGISTRY_SUBDIR = "registry";
export const MANAGED_SLOTS_REGISTRY_FILE = "slots.sqlite";

/**
 * The host-wide registry path (#11174). It is NOT under `AUTOMOBILE_DB_DIR` or the coordination
 * dir, which can differ per daemon; every daemon on the host resolves this same file.
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
  updated_at_ms: number;
}

interface SlotFreeDevicesTable {
  platform: SlotPlatform;
  stable_device_id: string;
  spec_fingerprint: string | null;
  from_scope_key: string;
  freed_at_ms: number;
}

export interface SlotRegistryDatabase {
  slot_scopes: SlotScopesTable;
  slot_assignments: SlotAssignmentsTable;
  slot_free_devices: SlotFreeDevicesTable;
}

type Executor = Kysely<SlotRegistryDatabase> | Transaction<SlotRegistryDatabase>;
type ScopeRow = Selectable<SlotScopesTable>;
type AssignmentRow = Selectable<SlotAssignmentsTable>;
type FreeDeviceRow = Selectable<SlotFreeDevicesTable>;

function toScope(row: ScopeRow): SlotScopeRecord {
  return {
    scopeKey: row.scope_key,
    managedHostScope: row.managed_host_scope,
    runnerNamespace: row.runner_namespace,
    runnerIncarnation: row.runner_incarnation,
    state: row.state,
    createdAtMs: row.created_at_ms,
    lastAcquiredAtMs: row.last_acquired_at_ms,
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

function serializeSpec(spec: unknown): string {
  const json = JSON.stringify(spec ?? null);
  if (json === undefined) {
    throw new ActionableError("Managed slot spec must be JSON-serializable");
  }
  return json;
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
  sqliteDb.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
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
      // A newer incarnation supersedes every abandoned one of this namespace for good.
      await trx
        .updateTable("slot_scopes")
        .set({ invalidation_reason: "incarnation_reset" })
        .where("managed_host_scope", "=", identity.managedHostScope)
        .where("runner_namespace", "=", identity.runnerNamespace)
        .where("invalidation_reason", "=", "abandoned")
        .execute();
      const row: ScopeRow = {
        scope_key: scopeKey,
        managed_host_scope: identity.managedHostScope,
        runner_namespace: identity.runnerNamespace,
        runner_incarnation: identity.runnerIncarnation,
        state: "valid",
        invalidation_reason: null,
        created_at_ms: nowMs,
        last_acquired_at_ms: nowMs,
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
    const resolvedSpecJson =
      next.resolvedSpec === null || next.resolvedSpec === undefined
        ? null
        : serializeSpec(next.resolvedSpec);
    const requestedSpecJson =
      next.requestedSpec === undefined ? undefined : serializeSpec(next.requestedSpec);
    return this.db.transaction().execute(async (trx): Promise<CommitBindingResult> => {
      const checked = await this.checkBinding(trx, key, expected);
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
    });
  }

  async updateSlotState(
    key: SlotKey,
    expected: SlotBindingExpectation,
    state: SlotAssignmentState,
  ): Promise<UpdateSlotStateResult> {
    assertValidSlotKey(key);
    return this.db.transaction().execute(async (trx): Promise<UpdateSlotStateResult> => {
      const checked = await this.checkBinding(trx, key, expected);
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
        .set({ state, generation, updated_at_ms: this.timer.now() })
        .where("scope_key", "=", key.scopeKey)
        .where("slot_index", "=", key.slotIndex)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "updated" as const, assignment: toAssignment(updated) };
    });
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
        return { released: true, assignment: toAssignment(updated) };
      }
      return { released: false, assignment: await this.readAssignment(trx, key) };
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
      .where("slot_scopes.state", "<>", "invalidated")
      .execute();
    const free = await this.db.selectFrom("slot_free_devices").selectAll().execute();
    return [
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
      const cleanupPending = assignments.filter(
        (assignment) => assignment.state === "cleanup_pending",
      );
      if (liveOwners.length > 0 || cleanupPending.length > 0) {
        return { kind: "pending", scope, liveOwners, cleanupPending };
      }
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
        .orderBy("last_acquired_at_ms")
        .execute()
    ).map(toScope);
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
      if (scope.lastAcquiredAtMs > this.timer.now() - thresholdMs) {
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

  async close(): Promise<void> {
    await this.db.destroy();
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

  /** The shared CAS precondition: valid scope, existing slot, unchanged binding. */
  private async checkBinding(
    trx: Executor,
    key: SlotKey,
    expected: SlotBindingExpectation,
  ): Promise<SlotAssignmentRecord | SlotCasFailure> {
    const scope = await this.readScope(trx, key.scopeKey);
    if (scope?.state !== "valid") {
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
      .where("exec_session_uuid", "is not", null)
      .execute();
    return rows.some((row) => {
      const owner = toExecOwner(row);
      return owner !== null && this.isExecOwnerLive(owner);
    });
  }

  /** An explicit reset of an abandoned scope replaces the revivable reason with the reset's. */
  private async makeResetPermanent(
    trx: Executor,
    scope: SlotScopeRecord,
    reason: SlotScopeInvalidationReason,
  ): Promise<SlotScopeRecord> {
    if (!isRevivableScope(scope) || !isPermanentInvalidationReason(reason)) {
      return scope;
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
