import { createHash } from "node:crypto";
import { ActionableError } from "../../models/ActionableError";

/**
 * Host-wide registry of managed device slots (#11172, #11174).
 *
 * A slot is identified by `(managed host scope, runner namespace, runner incarnation, slot index)`
 * and maps to at most one stable device identifier (AVD name or simulator UDID) plus the spec it
 * was resolved against. Assignment state is deliberately independent of sessions: a session ending
 * clears only the execution owner, never the binding, so an idle assigned device stays assigned.
 *
 * Every binding change bumps the slot's `generation`, and every mutating step compare-and-sets
 * `(scope, slot, generation, stableDeviceId)`, so a stale actor can never overwrite a newer binding.
 * Idempotency comes from that scoped identity plus the generation; there is no caller operation id.
 */

export type SlotPlatform = "android" | "ios";

/** The three caller-declared parts of a scope; the scope key is derived from them. */
export interface SlotScopeIdentity {
  managedHostScope: string;
  runnerNamespace: string;
  runnerIncarnation: string;
}

/**
 * `valid` scopes accept acquisitions. `invalidating` blocks new acquisitions while old owners and
 * cleanup settle. `invalidated` is a tombstone so an old-incarnation request can never recreate the
 * scope's assignments. The one exception is a scope invalidated only because it was abandoned: the
 * same incarnation returning revives it (owner decision 2026-10-09), until an explicit reset or a
 * newer incarnation of its namespace makes the invalidation permanent.
 */
export type SlotScopeState = "valid" | "invalidating" | "invalidated";

export type SlotScopeInvalidationReason = "incarnation_reset" | "operator_reset" | "abandoned";

export interface SlotScopeRecord extends SlotScopeIdentity {
  scopeKey: string;
  state: SlotScopeState;
  createdAtMs: number;
  /** Last time {@link SlotRegistry.ensureScope} admitted an acquisition into this scope. */
  lastAcquiredAtMs: number;
  /** Last time an execution released one of this scope's slots, if any did. */
  lastReleasedAtMs: number | null;
  invalidationReason: SlotScopeInvalidationReason | null;
  invalidatingAtMs: number | null;
  invalidatedAtMs: number | null;
}

export interface SlotKey {
  scopeKey: string;
  slotIndex: number;
}

/**
 * - `provisioning`: no device yet, or a bound device not yet confirmed ready.
 * - `ready`: the bound device satisfies the spec and may be claimed.
 * - `replacing`: the bound device is being deleted for a replacement (fenced).
 * - `settling`: a released execution's work (an action, or the release's restoration) has not
 *   ended yet; the device itself is fine. Its {@link SlotAssignmentRecord.settler} returns it to
 *   `ready` once the work settles, and a dead settler means the work died with it, so the slot is
 *   recoverable (`recoverSettledSlots`).
 * - `cleanup_pending`: deleting the bound device failed, so it may half-exist. Only the journal
 *   redrive (#11179) or an operator resolves it.
 */
export type SlotAssignmentState =
  | "provisioning"
  | "ready"
  | "replacing"
  | "settling"
  | "cleanup_pending";

/** A daemon process, as recorded for liveness checks. */
export interface SlotProcessIdentity {
  daemonId: string;
  pid: number;
  /**
   * The process's generation token (its start identity), so a reused PID is not mistaken for it.
   * Absent or null when the platform cannot report one: liveness then falls back to the PID alone.
   */
  processGenerationToken?: string | null;
}

/** The live execution currently holding a slot's device; cleared on session release. */
export interface SlotExecOwner extends SlotProcessIdentity {
  sessionUuid: string;
}

export interface SlotAssignmentRecord extends SlotKey {
  role: string;
  platform: SlotPlatform;
  generation: number;
  stableDeviceId: string | null;
  deviceName: string | null;
  requestedSpec: unknown;
  resolvedSpec: unknown;
  specFingerprint: string | null;
  state: SlotAssignmentState;
  execOwner: SlotExecOwner | null;
  /** The daemon watching a `settling` slot's work; null in every other state. */
  settler: SlotProcessIdentity | null;
  updatedAtMs: number;
}

/**
 * A device released from an invalidated scope. It stays excluded from generic allocation and is
 * adoptable only by a managed slot (or reclaimable once abandoned).
 */
export interface FreeSlotDeviceRecord {
  platform: SlotPlatform;
  stableDeviceId: string;
  specFingerprint: string | null;
  fromScopeKey: string;
  freedAtMs: number;
}

/** The optimistic-concurrency token every mutating slot step must present. */
export interface SlotBindingExpectation {
  generation: number;
  stableDeviceId: string | null;
}

export interface SlotInit {
  role: string;
  platform: SlotPlatform;
  requestedSpec: unknown;
}

export interface SlotBindingCommit {
  stableDeviceId: string | null;
  deviceName: string | null;
  /** Replaces the stored requested spec when present. */
  requestedSpec?: unknown;
  resolvedSpec: unknown;
  specFingerprint: string | null;
  state: SlotAssignmentState;
}

export type EnsureScopeResult =
  | {
      kind: "ready";
      scope: SlotScopeRecord;
      created: boolean;
      /**
       * The scope had been abandoned and this acquisition reactivated it. Its slot rows (kept
       * through the abandonment, even once the scope was invalidated) keep their bindings and
       * generations: surviving devices are reused, and a device the abandonment cleanup already
       * deleted is recreated by the reconciler.
       */
      revived: boolean;
    }
  /** This exact incarnation was reset (explicitly or by a newer incarnation); permanent. */
  | { kind: "scope_invalidated"; scope: SlotScopeRecord }
  /** Another incarnation of the same `(host, namespace)` is not yet invalidated. */
  | { kind: "incarnation_conflict"; current: SlotScopeRecord };

export type InitSlotResult =
  | { kind: "ready"; assignment: SlotAssignmentRecord; created: boolean }
  | { kind: "scope_not_valid"; scope: SlotScopeRecord | null };

/** Reasons a compare-and-set slot mutation is refused. The caller re-reads and decides. */
export type SlotCasFailure =
  | { kind: "scope_not_valid"; scope: SlotScopeRecord | null }
  | { kind: "slot_missing" }
  | { kind: "stale_binding"; current: SlotAssignmentRecord }
  | { kind: "device_assigned_elsewhere"; holder: SlotAssignmentRecord };

export type CommitBindingResult =
  | {
      kind: "committed";
      assignment: SlotAssignmentRecord;
      /** Set when the committed device was taken out of the free pool by this commit. */
      adoptedFreeDevice: FreeSlotDeviceRecord | null;
    }
  | SlotCasFailure;

export type UpdateSlotStateResult =
  | { kind: "updated"; assignment: SlotAssignmentRecord }
  /** Entering `replacing` while a live execution holds the slot (retryable). */
  | { kind: "slot_in_use"; owner: SlotExecOwner; assignment: SlotAssignmentRecord }
  | SlotCasFailure;

/**
 * States that fence the slot's device against concurrent use: entering one bumps the generation,
 * so every actor still holding the previous binding (a reuse about to mark the slot `ready`, an
 * execution about to claim it) loses its compare-and-set instead of overwriting the fence.
 */
export const FENCING_SLOT_STATES: ReadonlySet<SlotAssignmentState> = new Set([
  "replacing",
  "settling",
  "cleanup_pending",
]);

export interface UpdateSlotStateOptions {
  /** Required when entering `settling`: the daemon whose watcher will settle the slot. */
  settler?: SlotProcessIdentity;
}

/** Whether moving from `current` to `next` enters a fencing state (and so bumps the generation). */
export function entersFencingState(
  current: SlotAssignmentState,
  next: SlotAssignmentState,
): boolean {
  return current !== next && FENCING_SLOT_STATES.has(next);
}

export interface ClaimExecutionOptions {
  /**
   * Take the slot over from this session even though it is live: the caller's own reservation,
   * claimed before provisioning, handing over to the session provisioning produced.
   */
  supersedesSessionUuid?: string;
}

export type ClaimExecutionResult =
  | { kind: "claimed"; assignment: SlotAssignmentRecord }
  /** A live execution already holds the slot (retryable `slot_in_use`). */
  | { kind: "slot_in_use"; owner: SlotExecOwner; assignment: SlotAssignmentRecord }
  | { kind: "slot_not_ready"; assignment: SlotAssignmentRecord }
  | SlotCasFailure;

export interface ReleaseExecutionResult {
  /** False when the session did not hold the slot (already released or superseded). */
  released: boolean;
  assignment: SlotAssignmentRecord | null;
}

export type DeviceHolder =
  | { kind: "slot"; scope: SlotScopeRecord; assignment: SlotAssignmentRecord }
  | { kind: "free"; device: FreeSlotDeviceRecord };

/** One device the managed-slot system holds, for generic-pool exclusion snapshots. */
export interface ManagedDeviceEntry {
  platform: SlotPlatform;
  stableDeviceId: string;
  holder: "slot" | "free";
  scopeKey: string;
  slotIndex: number | null;
  scopeState: SlotScopeState | null;
  /** The live execution's session for a slot entry, if one is recorded; null for free devices. */
  execSessionUuid: string | null;
}

export type BeginScopeInvalidationResult =
  | { kind: "invalidating"; scope: SlotScopeRecord }
  | { kind: "already_invalidating"; scope: SlotScopeRecord }
  | { kind: "already_invalidated"; scope: SlotScopeRecord }
  | { kind: "not_found" };

export type CompleteScopeInvalidationResult =
  | { kind: "invalidated"; scope: SlotScopeRecord; freedDevices: FreeSlotDeviceRecord[] }
  | { kind: "already_invalidated"; scope: SlotScopeRecord }
  /** Live owners or pending cleanup still block the transition (retryable). */
  | {
      kind: "pending";
      scope: SlotScopeRecord;
      liveOwners: SlotAssignmentRecord[];
      /** Slots whose released work is still settling under a live settler. */
      settling: SlotAssignmentRecord[];
      cleanupPending: SlotAssignmentRecord[];
      /** Unfinished journaled work (#11179); accepted cleanup is never abandoned. */
      openJournal: SlotJournalEntry[];
    }
  | { kind: "not_invalidating"; scope: SlotScopeRecord }
  | { kind: "not_found" };

export type MarkScopeAbandonedResult =
  | { kind: "marked"; scope: SlotScopeRecord }
  | {
      kind: "not_abandoned";
      scope: SlotScopeRecord;
      reason: "not_valid" | "recent_acquisition" | "live_owner";
    }
  | { kind: "not_found" };

/** Selects scopes by namespace and incarnation; omitting the host scope matches every host. */
export interface SlotScopeQuery {
  runnerNamespace: string;
  runnerIncarnation: string;
  managedHostScope?: string;
}

export interface AbandonmentQuery {
  /** Defaults to {@link MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS}. */
  thresholdMs?: number;
}

/**
 * Owner decision 2026-10-09 (#11172 Q3): a scope with no activity (acquisition or execution
 * release) and no live owner for one hour is abandoned, and its devices may be deleted.
 */
export const MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Slot journal (#11179)
// ---------------------------------------------------------------------------------------------

/**
 * What a journal entry records: a device creation, a replacement (delete + verify absence, then
 * create), or the end of an execution whose work had not settled (`release`).
 */
export type SlotJournalKind = "create" | "replace" | "release";

/**
 * Phase of a journal entry. `intent`, `deleting`, `deleted`, `creating` and `created` are open: the
 * accepted work is unfinished and a redrive must converge it. `committed` and `rolled_back` are
 * terminal. An entry's phase changes in the same transaction as any assignment change it implies.
 */
export type SlotJournalPhase =
  | "intent"
  | "deleting"
  | "deleted"
  | "creating"
  | "created"
  | "committed"
  | "rolled_back";

export const SLOT_JOURNAL_TERMINAL_PHASES: readonly SlotJournalPhase[] = [
  "committed",
  "rolled_back",
];

export function isSlotJournalPhaseOpen(phase: SlotJournalPhase): boolean {
  return !SLOT_JOURNAL_TERMINAL_PHASES.includes(phase);
}

/** The exact devices an entry acts on, so recovery never confuses an old device with its successor. */
export interface SlotJournalTarget {
  /** The device the entry deletes (replace) or settles (release). */
  oldStableId: string | null;
  oldName: string | null;
  /** The generated name of the device the entry creates. */
  newName: string | null;
  /** The created device's stable id, once creation returned it (iOS UDID / AVD name). */
  newStableId: string | null;
  requestedSpec: unknown;
  resolvedSpec: unknown;
  specFingerprint: string | null;
}

/**
 * The process driving an entry (PID plus process-generation token). A redrive adopts entries whose
 * owner is no longer live by the same liveness rule as execution owners.
 */
export type SlotJournalOwner = SlotProcessIdentity;

export interface SlotJournalEntry extends SlotKey {
  id: number;
  kind: SlotJournalKind;
  phase: SlotJournalPhase;
  platform: SlotPlatform;
  /** Slot generation when the entry was opened. */
  fromGeneration: number;
  /** Slot generation after the entry's latest binding commit (null before any). */
  toGeneration: number | null;
  /** The binding the entry expects the slot to hold now; every redrive step CASes on it. */
  binding: SlotBindingExpectation;
  target: SlotJournalTarget;
  owner: SlotJournalOwner;
  /** Failed attempts so far; never a reason to abandon the entry. */
  attempts: number;
  lastError: string | null;
  /** Earliest time a redrive retries the entry (fair backoff between attempts). */
  nextAttemptAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The assignment change an entry transition applies atomically with the phase change. */
export type SlotJournalAssignmentChange =
  | { kind: "commit"; expected: SlotBindingExpectation; next: SlotBindingCommit }
  | {
      kind: "state";
      expected: SlotBindingExpectation;
      state: SlotAssignmentState;
      /** Required when entering `settling` (the settling daemon). */
      options?: UpdateSlotStateOptions;
    };

/** Why a journaled assignment change was refused; nothing was written. */
export type SlotJournalChangeFailure =
  | SlotCasFailure
  | Extract<UpdateSlotStateResult, { kind: "slot_in_use" }>;

export interface OpenSlotJournalInput {
  kind: SlotJournalKind;
  /** The entry's first (open) phase. */
  phase: SlotJournalPhase;
  target: SlotJournalTarget;
  owner: SlotJournalOwner;
  /** Anchors the entry to the slot's current binding; applied in the same transaction. */
  assignment: SlotJournalAssignmentChange;
}

export type OpenSlotJournalResult =
  | { kind: "opened"; entry: SlotJournalEntry; assignment: SlotAssignmentRecord }
  /** The slot already has unfinished journaled work; only one open entry per slot. */
  | { kind: "journal_open"; entry: SlotJournalEntry }
  | SlotJournalChangeFailure;

export interface AdvanceSlotJournalInput {
  /** Must equal the entry's recorded owner: a superseded driver can never advance it. */
  owner: SlotJournalOwner;
  expectedPhase: SlotJournalPhase;
  phase: SlotJournalPhase;
  target?: Partial<SlotJournalTarget>;
  assignment?: SlotJournalAssignmentChange;
  /** Record a failed attempt: `attempts + 1`, the error and the next retry time. */
  attempt?: { error: string; nextAttemptAtMs: number };
}

export type AdvanceSlotJournalResult =
  | { kind: "advanced"; entry: SlotJournalEntry; assignment: SlotAssignmentRecord | null }
  /** The entry is missing, terminal, at another phase, or owned by another driver. */
  | { kind: "journal_conflict"; entry: SlotJournalEntry | null }
  | SlotJournalChangeFailure;

export type ClaimSlotJournalResult =
  | { kind: "claimed"; entry: SlotJournalEntry }
  | { kind: "journal_conflict"; entry: SlotJournalEntry | null };

/** Terminal journal entries are kept this long as recovery evidence, then pruned. */
export const SLOT_JOURNAL_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Decides whether a recorded execution owner (or settler) is still alive. The default
 * (`defaultSlotExecOwnerLiveness`) requires its PID to run as the same process generation.
 */
export type SlotExecOwnerLiveness = (owner: SlotProcessIdentity) => boolean;

export interface SlotRegistry {
  /**
   * Admit an acquisition into a scope, creating it on first use and recording the acquisition time.
   * Revives a scope invalidated only by abandonment; never revives one that was reset, and never
   * silently replaces another incarnation. Creating a new incarnation makes every abandoned
   * incarnation of the same namespace permanently invalid.
   */
  ensureScope(identity: SlotScopeIdentity): Promise<EnsureScopeResult>;
  getScope(scopeKey: string): Promise<SlotScopeRecord | null>;

  /**
   * Create the slot at generation 0 with no device if absent; concurrent initializers of one slot
   * converge on the same row. Requires a valid scope.
   */
  initSlot(key: SlotKey, init: SlotInit): Promise<InitSlotResult>;
  /**
   * Change the slot's device binding (`generation + 1`). Refused unless the slot still holds
   * `expected`, and refused when the device belongs to another slot. A device in the free pool is
   * adopted atomically.
   */
  commitBinding(
    key: SlotKey,
    expected: SlotBindingExpectation,
    next: SlotBindingCommit,
  ): Promise<CommitBindingResult>;
  /**
   * Change the slot state under the same binding. Entering a fencing state
   * ({@link FENCING_SLOT_STATES}) bumps the generation; any other change keeps it. Entering
   * `replacing` is refused while a live execution owns the slot.
   */
  updateSlotState(
    key: SlotKey,
    expected: SlotBindingExpectation,
    state: SlotAssignmentState,
    options?: UpdateSlotStateOptions,
  ): Promise<UpdateSlotStateResult>;
  /**
   * Return every `settling` slot (of `scopeKey`, or of any scope) whose settler is dead and which
   * no live execution owns to `ready`: its released work died with the settler's process. The
   * restart-time recovery for a drain whose watcher never finished. Returns the recovered slots.
   */
  recoverSettledSlots(scopeKey?: string): Promise<SlotAssignmentRecord[]>;

  /**
   * Record the live execution holding a ready slot; refused while another live owner holds it,
   * unless that owner is the session `options.supersedesSessionUuid` names.
   */
  claimExecution(
    key: SlotKey,
    expected: SlotBindingExpectation,
    owner: SlotExecOwner,
    options?: ClaimExecutionOptions,
  ): Promise<ClaimExecutionResult>;
  /** Clear the execution owner if `sessionUuid` holds it. Never touches the binding. Idempotent. */
  releaseExecution(key: SlotKey, sessionUuid: string): Promise<ReleaseExecutionResult>;

  getAssignment(key: SlotKey): Promise<SlotAssignmentRecord | null>;
  listAssignments(scopeKey: string): Promise<SlotAssignmentRecord[]>;
  /**
   * Every slot whose recorded execution owner is `sessionUuid`, in any scope, ordered by scope and
   * slot index. The drain on session release (#11177) resolves its slots from this, since the
   * releasing session — not the caller — is what identifies the execution.
   */
  findExecutionAssignments(sessionUuid: string): Promise<SlotAssignmentRecord[]>;
  /** Who holds a device: a slot (any scope state) or the free pool. */
  findDeviceHolder(platform: SlotPlatform, stableDeviceId: string): Promise<DeviceHolder | null>;
  /** True only when the device is bound to a slot whose scope is `valid`. */
  isDeviceAssignedToValidSlot(platform: SlotPlatform, stableDeviceId: string): Promise<boolean>;
  /**
   * Every device generic allocation must exclude: bound to a slot of a scope that is not yet
   * invalidated, or parked in the free pool.
   */
  snapshotManagedDevices(): Promise<ManagedDeviceEntry[]>;
  listFreeDevices(): Promise<FreeSlotDeviceRecord[]>;

  /**
   * valid → invalidating. Idempotent; blocks new acquisitions immediately. An explicit reset of a
   * scope already abandoned records the reset reason, so the scope can no longer be revived.
   */
  beginScopeInvalidation(
    scopeKey: string,
    reason: SlotScopeInvalidationReason,
  ): Promise<BeginScopeInvalidationResult>;
  /**
   * invalidating → invalidated once no live owner, no `cleanup_pending` slot, no open journal entry
   * and no slot settling under a live settler remains (a dead settler's slot is settled and does not block): bound
   * devices move to the free pool and the scope's slots are removed. Idempotent.
   *
   * A scope invalidated only by abandonment is still revivable, so its slots are KEPT (their
   * devices stay excluded and reserved for the same incarnation); they move to the free pool only
   * when the invalidation becomes permanent — an explicit reset or a newer incarnation.
   */
  completeScopeInvalidation(scopeKey: string): Promise<CompleteScopeInvalidationResult>;

  /**
   * Valid scopes with no activity (acquisition or execution release) within the threshold and no
   * live execution owner or settler.
   */
  findAbandonedScopes(query?: AbandonmentQuery): Promise<SlotScopeRecord[]>;
  /**
   * Atomically re-check abandonment and move the scope to `invalidating` with reason `abandoned`,
   * so no acquisition races the later device deletion.
   */
  markScopeAbandoned(scopeKey: string, query?: AbandonmentQuery): Promise<MarkScopeAbandonedResult>;
  /** Free-pool devices that have sat unadopted for at least the threshold. */
  findReclaimableFreeDevices(query?: AbandonmentQuery): Promise<FreeSlotDeviceRecord[]>;
  /** Every scope of `(namespace, incarnation)`, optionally narrowed to one host scope. */
  findScopes(query: SlotScopeQuery): Promise<SlotScopeRecord[]>;
  /**
   * Scopes marked abandoned and not yet revived or reset (`invalidating`, reason `abandoned`):
   * their slots keep their bindings so a returning incarnation can revive them.
   */
  listAbandonedScopes(): Promise<SlotScopeRecord[]>;

  /**
   * Open a journal entry for a slot together with its anchoring assignment change. Refused while
   * the slot has another open entry or the binding moved.
   */
  openSlotJournal(key: SlotKey, input: OpenSlotJournalInput): Promise<OpenSlotJournalResult>;
  /** Move an open entry to its next phase (and apply its assignment change) in one transaction. */
  advanceSlotJournal(id: number, input: AdvanceSlotJournalInput): Promise<AdvanceSlotJournalResult>;
  /** Take over an open entry from `expected` (a dead owner); refused if the owner changed. */
  claimSlotJournal(
    id: number,
    expected: SlotJournalOwner,
    next: SlotJournalOwner,
  ): Promise<ClaimSlotJournalResult>;
  getSlotJournal(id: number): Promise<SlotJournalEntry | null>;
  /** Open entries (all slots, or one slot), earliest retry first. */
  listOpenSlotJournal(key?: SlotKey): Promise<SlotJournalEntry[]>;

  close(): Promise<void>;
}

/**
 * Deterministic scope key: sha256 over the JSON array of the three identity parts, so no choice of
 * separator inside a part can make two different identities collide.
 */
export function computeSlotScopeKey(identity: SlotScopeIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.managedHostScope,
        identity.runnerNamespace,
        identity.runnerIncarnation,
      ]),
    )
    .digest("hex");
}

/** Reject a malformed slot key before it reaches storage. */
export function assertValidSlotKey(key: SlotKey): void {
  if (!Number.isInteger(key.slotIndex) || key.slotIndex < 0) {
    throw new ActionableError(
      `Managed slot index must be a non-negative integer, got ${key.slotIndex}`,
    );
  }
  if (key.scopeKey.length === 0) {
    throw new ActionableError("Managed slot scope key must not be empty");
  }
}

export function resolveAbandonmentThresholdMs(query: AbandonmentQuery | undefined): number {
  const thresholdMs = query?.thresholdMs ?? MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS;
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
    throw new ActionableError(
      `Abandonment threshold must be a non-negative number, got ${thresholdMs}`,
    );
  }
  return thresholdMs;
}

/**
 * Whether an acquisition of the same incarnation may reactivate this scope: it left `valid` only
 * because it was abandoned, not because of a reset (owner decision 2026-10-09).
 */
export function isRevivableScope(scope: SlotScopeRecord): boolean {
  return scope.state !== "valid" && scope.invalidationReason === "abandoned";
}

/** Whether a reason makes an invalidation permanent (anything but abandonment). */
export function isPermanentInvalidationReason(reason: SlotScopeInvalidationReason): boolean {
  return reason !== "abandoned";
}

/** Whether entering `state` needs a settler, and whether one was given. */
export function assertSettlerForState(
  state: SlotAssignmentState,
  options: UpdateSlotStateOptions | undefined,
): SlotProcessIdentity | null {
  if (state !== "settling") {
    return null;
  }
  if (!options?.settler) {
    throw new ActionableError("Marking a managed slot settling requires the settling daemon");
  }
  return options.settler;
}

/** The scope's most recent acquisition or execution release: the abandonment clock's start. */
export function lastScopeActivityMs(scope: SlotScopeRecord): number {
  return Math.max(scope.lastAcquiredAtMs, scope.lastReleasedAtMs ?? 0);
}

export function bindingMatches(
  assignment: SlotAssignmentRecord,
  expected: SlotBindingExpectation,
): boolean {
  return (
    assignment.generation === expected.generation &&
    assignment.stableDeviceId === expected.stableDeviceId
  );
}

export function journalOwnersEqual(a: SlotJournalOwner, b: SlotJournalOwner): boolean {
  return (
    a.daemonId === b.daemonId &&
    a.pid === b.pid &&
    (a.processGenerationToken ?? null) === (b.processGenerationToken ?? null)
  );
}

export function sameBinding(a: SlotBindingExpectation, b: SlotBindingExpectation): boolean {
  return a.generation === b.generation && a.stableDeviceId === b.stableDeviceId;
}

/**
 * The stable id an open journal entry's new device has, or will have: the recorded id once creation
 * returned it, else (Android) the generated AVD name, which is the stable id.
 */
export function journalNewStableId(entry: SlotJournalEntry): string | null {
  return entry.target.newStableId ?? (entry.platform === "android" ? entry.target.newName : null);
}

/**
 * Devices open journal entries are creating but have not bound yet. Generic allocation must skip
 * them too, so a device mid-creation is never handed to another client before the slot commits it.
 */
export function journalTargetEntries(
  open: readonly SlotJournalEntry[],
  known: readonly ManagedDeviceEntry[],
): ManagedDeviceEntry[] {
  const seen = new Set(
    known.map((entry) => JSON.stringify([entry.platform, entry.stableDeviceId])),
  );
  return open.flatMap((entry): ManagedDeviceEntry[] => {
    const stableDeviceId = journalNewStableId(entry);
    if (stableDeviceId === null || seen.has(JSON.stringify([entry.platform, stableDeviceId]))) {
      return [];
    }
    seen.add(JSON.stringify([entry.platform, stableDeviceId]));
    return [
      {
        platform: entry.platform,
        stableDeviceId,
        holder: "slot",
        scopeKey: entry.scopeKey,
        slotIndex: entry.slotIndex,
        scopeState: null,
        // No execution owns a device before its slot commits it.
        execSessionUuid: null,
      },
    ];
  });
}

/**
 * Slot mutations need a `valid` scope. Journaled settlement may also run while the scope is
 * `invalidating`: completing the invalidation waits for exactly that work.
 */
export function scopeAcceptsSlotChange(scope: SlotScopeRecord | null, journaled: boolean): boolean {
  return scope?.state === "valid" || (journaled && scope?.state === "invalidating");
}
