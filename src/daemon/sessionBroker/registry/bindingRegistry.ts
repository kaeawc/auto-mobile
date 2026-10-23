import { createHash } from "node:crypto";
import { ActionableError } from "../../../models/ActionableError";

/**
 * Host-wide registry of managed device bindings (#11172, #11174).
 *
 * A binding is identified by `(managed host scope, runner namespace, runner incarnation, binding index)`
 * and maps to at most one stable device identifier (AVD name or simulator UDID) plus the spec it
 * was resolved against. Assignment state is deliberately independent of sessions: a session ending
 * clears only the execution owner, never the binding, so an idle assigned device stays assigned.
 *
 * Every binding change bumps the binding's `generation`, and every mutating step compare-and-sets
 * `(scope, binding, generation, stableDeviceId)`, so a stale actor can never overwrite a newer binding.
 * Idempotency comes from that scoped identity plus the generation; there is no caller operation id.
 */

export type BindingPlatform = "android" | "ios";

/** The three caller-declared parts of a scope; the scope key is derived from them. */
export interface BindingScopeIdentity {
  managedHostScope: string;
  runnerNamespace: string;
  runnerIncarnation: string;
}

/**
 * `valid` scopes accept acquisitions. `invalidating` blocks new acquisitions while old owners and
 * cleanup settle. `invalidated` is a tombstone so an old-incarnation request can never recreate the
 * scope's assignments. The one exception is a scope invalidated only because it was abandoned: the
 * same incarnation returning revives it (owner decision 2026-10-09), until an explicit reset or a
 * newer incarnation of its namespace makes the invalidation permanent. Unjournaled devices are
 * reused; already journaled deletes complete first, then a later acquisition creates anew (#11545).
 */
export type BindingScopeState = "valid" | "invalidating" | "invalidated";

export type BindingScopeInvalidationReason = "incarnation_reset" | "operator_reset" | "abandoned";

export interface BindingScopeRecord extends BindingScopeIdentity {
  scopeKey: string;
  state: BindingScopeState;
  createdAtMs: number;
  /** Last time {@link BindingRegistry.ensureScope} admitted an acquisition into this scope. */
  lastAcquiredAtMs: number;
  /** Last time an execution released one of this scope's bindings, if any did. */
  lastReleasedAtMs: number | null;
  invalidationReason: BindingScopeInvalidationReason | null;
  invalidatingAtMs: number | null;
  invalidatedAtMs: number | null;
}

export interface BindingKey {
  scopeKey: string;
  bindingIndex: number;
}

/**
 * - `provisioning`: no device yet, or a bound device not yet confirmed ready.
 * - `ready`: the bound device satisfies the spec and may be claimed.
 * - `replacing`: the bound device is being deleted for a replacement (fenced).
 * - `settling`: a released execution's work (an action, or the release's restoration) has not
 *   ended yet; the device itself is fine. Its {@link BindingAssignmentRecord.settler} returns it to
 *   `ready` once the work settles, and a dead settler means the work died with it, so the binding is
 *   recoverable (`recoverSettledBindings`).
 * - `cleanup_pending`: deleting the bound device failed, so it may half-exist. Only the journal
 *   redrive (#11179) or an operator resolves it.
 */
export type BindingAssignmentState =
  | "provisioning"
  | "ready"
  | "replacing"
  | "settling"
  | "cleanup_pending";

/** A daemon process, as recorded for liveness checks. */
export interface BindingProcessIdentity {
  daemonId: string;
  pid: number;
  /**
   * The process's generation token (its start identity), so a reused PID is not mistaken for it.
   * Absent or null when the platform cannot report one: liveness then falls back to the PID alone.
   */
  processGenerationToken?: string | null;
}

/** The live execution currently holding a binding's device; cleared on session release. */
export interface BindingExecOwner extends BindingProcessIdentity {
  sessionUuid: string;
}

export interface BindingAssignmentRecord extends BindingKey {
  role: string;
  platform: BindingPlatform;
  generation: number;
  stableDeviceId: string | null;
  deviceName: string | null;
  requestedSpec: unknown;
  resolvedSpec: unknown;
  specFingerprint: string | null;
  state: BindingAssignmentState;
  execOwner: BindingExecOwner | null;
  /** The daemon watching a `settling` binding's work; null in every other state. */
  settler: BindingProcessIdentity | null;
  updatedAtMs: number;
}

/** One statement's consistent view of the total-resource ledger. */
export interface BindingResourceSnapshot {
  managed: ManagedDeviceEntry[];
  openJournal: BindingJournalEntry[];
}

/** The optimistic-concurrency token every mutating binding step must present. */
export interface BindingBindingExpectation {
  generation: number;
  stableDeviceId: string | null;
}

export interface BindingInit {
  role: string;
  platform: BindingPlatform;
  requestedSpec: unknown;
}

export interface BindingBindingCommit {
  /**
   * Moves the binding to another platform (owner decision 2026-10-09, #11232: a platform change is a
   * replacement). Only allowed together with an empty binding (`stableDeviceId: null`), so the old
   * platform's device is always deleted and verified absent first.
   */
  platform?: BindingPlatform;
  stableDeviceId: string | null;
  deviceName: string | null;
  /** Replaces the stored requested spec when present. */
  requestedSpec?: unknown;
  resolvedSpec: unknown;
  specFingerprint: string | null;
  state: BindingAssignmentState;
}

export type EnsureScopeResult =
  | {
      kind: "ready";
      scope: BindingScopeRecord;
      created: boolean;
      /**
       * The scope had been abandoned and this acquisition reactivated it. Its binding rows (kept
       * through abandonment) keep unjournaled bindings and generations. Already journaled deletes,
       * even blocked ones, complete first; the reconciler then creates a new device (#11545).
       */
      revived: boolean;
    }
  /** This exact incarnation was reset (explicitly or by a newer incarnation); permanent. */
  | { kind: "scope_invalidated"; scope: BindingScopeRecord }
  /** Another incarnation of the same `(host, namespace)` is not yet invalidated. */
  | { kind: "incarnation_conflict"; current: BindingScopeRecord };

export type InitBindingResult =
  | { kind: "ready"; assignment: BindingAssignmentRecord; created: boolean }
  | { kind: "scope_not_valid"; scope: BindingScopeRecord | null };

/** Reasons a compare-and-set binding mutation is refused. The caller re-reads and decides. */
export type BindingCasFailure =
  | { kind: "scope_not_valid"; scope: BindingScopeRecord | null }
  | { kind: "binding_missing" }
  | { kind: "stale_binding"; current: BindingAssignmentRecord }
  | { kind: "device_assigned_elsewhere"; holder: BindingAssignmentRecord };

export type CommitBindingResult =
  | {
      kind: "committed";
      assignment: BindingAssignmentRecord;
    }
  | BindingCasFailure;

export type UpdateBindingStateResult =
  | { kind: "updated"; assignment: BindingAssignmentRecord }
  /** Entering `replacing` while a live execution holds the binding (retryable). */
  | { kind: "binding_in_use"; owner: BindingExecOwner; assignment: BindingAssignmentRecord }
  | BindingCasFailure;

/**
 * States that fence the binding's device against concurrent use: entering one bumps the generation,
 * so every actor still holding the previous binding (a reuse about to mark the binding `ready`, an
 * execution about to claim it) loses its compare-and-set instead of overwriting the fence.
 */
export const FENCING_BINDING_STATES: ReadonlySet<BindingAssignmentState> = new Set([
  "replacing",
  "settling",
  "cleanup_pending",
]);

export interface UpdateBindingStateOptions {
  /** Required when entering `settling`: the daemon whose watcher will settle the binding. */
  settler?: BindingProcessIdentity;
}

/** Whether moving from `current` to `next` enters a fencing state (and so bumps the generation). */
export function entersFencingState(
  current: BindingAssignmentState,
  next: BindingAssignmentState,
): boolean {
  return current !== next && FENCING_BINDING_STATES.has(next);
}

export interface ClaimExecutionOptions {
  /**
   * Take the binding over from this session even though it is live: the caller's own reservation,
   * claimed before provisioning, handing over to the session provisioning produced.
   */
  supersedesSessionUuid?: string;
}

export type ClaimExecutionResult =
  | { kind: "claimed"; assignment: BindingAssignmentRecord }
  /** A live execution already holds the binding (retryable `binding_in_use`). */
  | { kind: "binding_in_use"; owner: BindingExecOwner; assignment: BindingAssignmentRecord }
  | { kind: "binding_not_ready"; assignment: BindingAssignmentRecord }
  | BindingCasFailure;

export interface ReleaseExecutionResult {
  /** False when the session did not hold the binding (already released or superseded). */
  released: boolean;
  assignment: BindingAssignmentRecord | null;
}

export type DeviceHolder = {
  kind: "binding";
  scope: BindingScopeRecord;
  assignment: BindingAssignmentRecord;
};

/** One device the binding system holds, for generic-pool exclusion snapshots. */
export interface ManagedDeviceEntry {
  platform: BindingPlatform;
  stableDeviceId: string;
  holder: "session_broker";
  scopeKey: string;
  bindingIndex: number | null;
  scopeState: BindingScopeState | null;
  /** The live execution's session for a binding entry, if one is recorded; null for free devices. */
  execSessionUuid: string | null;
}

// ---------------------------------------------------------------------------------------------
// Binding journal (#11179)
// ---------------------------------------------------------------------------------------------

/**
 * What a journal entry records: a device creation, a replacement (delete + verify absence, then
 * create), or the end of an execution whose work had not settled (`release`).
 */
export type BindingJournalKind = "create" | "replace" | "release";

/**
 * Phase of a journal entry. `intent`, `deleting`, `deleted`, `creating` and `created` are open: the
 * accepted work is unfinished and a redrive must converge it. `committed` and `rolled_back` are
 * terminal. An entry's phase changes in the same transaction as any assignment change it implies.
 */
export type BindingJournalPhase =
  | "intent"
  | "deleting"
  | "deleted"
  | "creating"
  | "created"
  | "committed"
  | "rolled_back";

export const BINDING_JOURNAL_TERMINAL_PHASES: readonly BindingJournalPhase[] = [
  "committed",
  "rolled_back",
];

export function isBindingJournalPhaseOpen(phase: BindingJournalPhase): boolean {
  return !BINDING_JOURNAL_TERMINAL_PHASES.includes(phase);
}

/** The exact devices an entry acts on, so recovery never confuses an old device with its successor. */
export interface BindingJournalTarget {
  /** Durable removal intent for the created device; once true, it can never be adopted. */
  removalRequested?: true;
  /**
   * When the entry's delete was quarantined: the teardown's soft kills and process escalation both
   * failed (#14018). A quarantined entry never re-sends the delete; due probes only watch for the
   * device to disappear. The entry stays open, so the device stays charged against capacity.
   */
  quarantinedAtMs?: number;
  /**
   * The platform the entry creates on, when it differs from the entry's (the binding's platform when
   * the entry was opened, which the old device lives on): a cross-platform replacement (#11232).
   * Absent means the same platform.
   */
  newPlatform?: BindingPlatform;
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
export type BindingJournalOwner = BindingProcessIdentity;

export interface BindingJournalEntry extends BindingKey {
  id: number;
  kind: BindingJournalKind;
  phase: BindingJournalPhase;
  platform: BindingPlatform;
  /** Binding generation when the entry was opened. */
  fromGeneration: number;
  /** Binding generation after the entry's latest binding commit (null before any). */
  toGeneration: number | null;
  /** The binding the entry expects the binding to hold now; every redrive step CASes on it. */
  binding: BindingBindingExpectation;
  target: BindingJournalTarget;
  owner: BindingJournalOwner;
  /** Failed attempts so far; never a reason to abandon the entry. */
  attempts: number;
  lastError: string | null;
  /** Earliest time a redrive retries the entry (fair backoff between attempts). */
  nextAttemptAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The assignment change an entry transition applies atomically with the phase change. */
export type BindingJournalAssignmentChange =
  | { kind: "commit"; expected: BindingBindingExpectation; next: BindingBindingCommit }
  | {
      kind: "state";
      expected: BindingBindingExpectation;
      state: BindingAssignmentState;
      /** Required when entering `settling` (the settling daemon). */
      options?: UpdateBindingStateOptions;
    };

/** Why a journaled assignment change was refused; nothing was written. */
export type BindingJournalChangeFailure =
  | BindingCasFailure
  | Extract<UpdateBindingStateResult, { kind: "binding_in_use" }>;

export interface OpenBindingJournalInput {
  kind: BindingJournalKind;
  /** The entry's first (open) phase. */
  phase: BindingJournalPhase;
  target: BindingJournalTarget;
  owner: BindingJournalOwner;
  /** Anchors the entry to the binding's current binding; applied in the same transaction. */
  assignment: BindingJournalAssignmentChange;
}

export type OpenBindingJournalResult =
  | { kind: "opened"; entry: BindingJournalEntry; assignment: BindingAssignmentRecord }
  /** The binding already has unfinished journaled work; only one open entry per binding. */
  | { kind: "journal_open"; entry: BindingJournalEntry }
  | BindingJournalChangeFailure;

export interface AdvanceBindingJournalInput {
  /** Must equal the entry's recorded owner: a superseded driver can never advance it. */
  owner: BindingJournalOwner;
  expectedPhase: BindingJournalPhase;
  phase: BindingJournalPhase;
  target?: Partial<BindingJournalTarget>;
  assignment?: BindingJournalAssignmentChange;
  /** Record a failed attempt: `attempts + 1`, the error and the next retry time. */
  attempt?: { error: string; nextAttemptAtMs: number };
}

export type AdvanceBindingJournalResult =
  | { kind: "advanced"; entry: BindingJournalEntry; assignment: BindingAssignmentRecord | null }
  /** The entry is missing, terminal, at another phase, or owned by another driver. */
  | { kind: "journal_conflict"; entry: BindingJournalEntry | null }
  | BindingJournalChangeFailure;

export type ClaimBindingJournalResult =
  | { kind: "claimed"; entry: BindingJournalEntry }
  | { kind: "journal_conflict"; entry: BindingJournalEntry | null };

/** Terminal journal entries are kept this long as recovery evidence, then pruned. */
export const BINDING_JOURNAL_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Decides whether a recorded execution owner (or settler) is still alive. The default
 * (`defaultBindingExecOwnerLiveness`) requires its PID to run as the same process generation.
 */
export type BindingExecOwnerLiveness = (owner: BindingProcessIdentity) => boolean;

export interface BindingRegistry {
  /**
   * Admit an acquisition into a scope, creating it on first use and recording the acquisition time.
   * Revives a scope invalidated only by abandonment; never revives one that was reset, and never
   * silently replaces another incarnation. Creating a new incarnation makes every abandoned
   * incarnation of the same namespace permanently invalid.
   */
  ensureScope(identity: BindingScopeIdentity): Promise<EnsureScopeResult>;
  getScope(scopeKey: string): Promise<BindingScopeRecord | null>;

  /**
   * Create the binding at generation 0 with no device if absent; concurrent initializers of one binding
   * converge on the same row. Requires a valid scope.
   */
  initBinding(key: BindingKey, init: BindingInit): Promise<InitBindingResult>;
  /** Delete only the exact unbound provisioning row, without an execution owner or open journal. */
  removeUnboundBinding(
    key: BindingKey,
    expected: { generation: number; stableDeviceId: null },
  ): Promise<boolean>;

  /**
   * Change the binding's device binding (`generation + 1`). Refused unless the binding still holds
   * `expected`, and refused when the device belongs to another binding. A device in the free pool is
   * adopted atomically.
   */
  commitBinding(
    key: BindingKey,
    expected: BindingBindingExpectation,
    next: BindingBindingCommit,
  ): Promise<CommitBindingResult>;
  /**
   * Change the binding state under the same binding. Entering a fencing state
   * ({@link FENCING_BINDING_STATES}) bumps the generation; any other change keeps it. Entering
   * `replacing` is refused while a live execution owns the binding.
   */
  updateBindingState(
    key: BindingKey,
    expected: BindingBindingExpectation,
    state: BindingAssignmentState,
    options?: UpdateBindingStateOptions,
  ): Promise<UpdateBindingStateResult>;
  /**
   * Return every `settling` binding (of `scopeKey`, or of any scope) whose settler is dead and which
   * no live execution owns to `ready`: its released work died with the settler's process. The
   * restart-time recovery for a drain whose watcher never finished. Returns the recovered bindings.
   */
  recoverSettledBindings(scopeKey?: string): Promise<BindingAssignmentRecord[]>;

  /**
   * Record the live execution holding a ready binding; refused while another live owner holds it,
   * unless that owner is the session `options.supersedesSessionUuid` names. Needs a `valid` scope,
   * except that the session the binding already records may re-stamp its owner process while the
   * scope is `invalidating` ({@link scopeAcceptsSameSessionClaim}).
   */
  claimExecution(
    key: BindingKey,
    expected: BindingBindingExpectation,
    owner: BindingExecOwner,
    options?: ClaimExecutionOptions,
  ): Promise<ClaimExecutionResult>;
  /** Clear the execution owner if `sessionUuid` holds it. Never touches the binding. Idempotent. */
  releaseExecution(key: BindingKey, sessionUuid: string): Promise<ReleaseExecutionResult>;

  getAssignment(key: BindingKey): Promise<BindingAssignmentRecord | null>;
  listAssignments(scopeKey: string): Promise<BindingAssignmentRecord[]>;
  /**
   * Every binding whose recorded execution owner is `sessionUuid`, in any scope, ordered by scope and
   * binding index. The drain on session release (#11177) resolves its bindings from this, since the
   * releasing session — not the caller — is what identifies the execution.
   */
  findExecutionAssignments(sessionUuid: string): Promise<BindingAssignmentRecord[]>;
  /** Who holds a device: a binding (any scope state) or the free pool. */
  findDeviceHolder(platform: BindingPlatform, stableDeviceId: string): Promise<DeviceHolder | null>;
  /** True only when the device is bound to a binding whose scope is `valid`. */
  isDeviceAssignedToValidBinding(
    platform: BindingPlatform,
    stableDeviceId: string,
  ): Promise<boolean>;
  /**
   * Every device generic allocation must exclude: bound to a binding of a scope that is not yet
   * invalidated, or parked in the free pool.
   */
  snapshotManagedDevices(): Promise<ManagedDeviceEntry[]>;
  snapshotBindingResources(): Promise<BindingResourceSnapshot>;
  openBindingJournal(
    key: BindingKey,
    input: OpenBindingJournalInput,
  ): Promise<OpenBindingJournalResult>;
  /** Move an open entry to its next phase (and apply its assignment change) in one transaction. */
  advanceBindingJournal(
    id: number,
    input: AdvanceBindingJournalInput,
  ): Promise<AdvanceBindingJournalResult>;
  /** Take over an open entry from `expected` (a dead owner); refused if the owner changed. */
  claimBindingJournal(
    id: number,
    expected: BindingJournalOwner,
    next: BindingJournalOwner,
  ): Promise<ClaimBindingJournalResult>;
  getBindingJournal(id: number): Promise<BindingJournalEntry | null>;
  /** Open entries (all bindings, or one binding), earliest retry first. */
  listOpenBindingJournal(key?: BindingKey): Promise<BindingJournalEntry[]>;

  close(): Promise<void>;
}

/**
 * Deterministic scope key: sha256 over the JSON array of the three identity parts, so no choice of
 * separator inside a part can make two different identities collide.
 */
export function computeBindingScopeKey(identity: BindingScopeIdentity): string {
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

/** Reject a malformed binding key before it reaches storage. */
export function assertValidBindingKey(key: BindingKey): void {
  if (!Number.isInteger(key.bindingIndex) || key.bindingIndex < 0) {
    throw new ActionableError(
      `Binding index must be a non-negative integer, got ${key.bindingIndex}`,
    );
  }
  if (key.scopeKey.length === 0) {
    throw new ActionableError("Binding scope key must not be empty");
  }
}

/** Whether entering `state` needs a settler, and whether one was given. */
export function assertSettlerForState(
  state: BindingAssignmentState,
  options: UpdateBindingStateOptions | undefined,
): BindingProcessIdentity | null {
  if (state !== "settling") {
    return null;
  }
  if (!options?.settler) {
    throw new ActionableError("Marking a binding settling requires the settling daemon");
  }
  return options.settler;
}

export function bindingMatches(
  assignment: BindingAssignmentRecord,
  expected: BindingBindingExpectation,
): boolean {
  return (
    assignment.generation === expected.generation &&
    assignment.stableDeviceId === expected.stableDeviceId
  );
}

export function journalOwnersEqual(a: BindingJournalOwner, b: BindingJournalOwner): boolean {
  return (
    a.daemonId === b.daemonId &&
    a.pid === b.pid &&
    (a.processGenerationToken ?? null) === (b.processGenerationToken ?? null)
  );
}

export function sameBinding(a: BindingBindingExpectation, b: BindingBindingExpectation): boolean {
  return a.generation === b.generation && a.stableDeviceId === b.stableDeviceId;
}

/**
 * The stable id an open journal entry's new device has, or will have: the recorded id once creation
 * returned it, else the generated name (the AVD identity on Android, a temporary iOS identity).
 */
export function journalNewStableId(entry: BindingJournalEntry): string | null {
  return entry.target.newStableId ?? entry.target.newName;
}

/**
 * Devices open journal entries are creating but have not bound yet. Generic allocation must skip
 * them too, so a device mid-creation is never handed to another client before the binding commits it.
 */
export function journalTargetEntries(
  open: readonly BindingJournalEntry[],
  known: readonly ManagedDeviceEntry[],
): ManagedDeviceEntry[] {
  const seen = new Set(
    known.map((entry) => JSON.stringify([entry.platform, entry.stableDeviceId])),
  );
  return open.flatMap((entry): ManagedDeviceEntry[] => {
    const stableDeviceId = journalNewStableId(entry);
    const platform = journalCreationPlatform(entry);
    if (stableDeviceId === null || seen.has(JSON.stringify([platform, stableDeviceId]))) {
      return [];
    }
    seen.add(JSON.stringify([platform, stableDeviceId]));
    return [
      {
        platform,
        stableDeviceId,
        holder: "session_broker",
        scopeKey: entry.scopeKey,
        bindingIndex: entry.bindingIndex,
        scopeState: null,
        // No execution owns a device before its binding commits it.
        execSessionUuid: null,
      },
    ];
  });
}

/**
 * Binding mutations need a `valid` scope. Journaled settlement may also run while the scope is
 * `invalidating`: completing the invalidation waits for exactly that work.
 */
export function scopeAcceptsBindingChange(
  scope: BindingScopeRecord | null,
  journaled: boolean,
): boolean {
  return scope?.state === "valid" || (journaled && scope?.state === "invalidating");
}

/**
 * Whether an execution claim by `sessionUuid` may go through in a scope that does not accept binding
 * changes (#11642). Only one case: the scope is `invalidating` and the binding's recorded execution
 * is that same session, so the claim re-stamps which process holds a session the scope is already
 * waiting for (a restarted daemon re-owning its live execution). It adds no owner to the scope:
 * an ownerless binding and a binding recorded for any other session stay refused, and an `invalidated`
 * scope accepts nothing.
 */
export function scopeAcceptsSameSessionClaim(
  scope: BindingScopeRecord | null,
  current: Pick<BindingAssignmentRecord, "execOwner"> | null,
  sessionUuid: string,
): boolean {
  return scope?.state === "invalidating" && current?.execOwner?.sessionUuid === sessionUuid;
}

/**
 * The platform a binding commit leaves the binding on. A platform change is a replacement (#11232),
 * so it is refused unless the commit empties the binding: a device of the new platform is only ever
 * bound after the old platform's device was deleted and verified absent.
 */
export function assertPlatformChangeAllowed(
  current: Pick<BindingAssignmentRecord, "platform">,
  next: Pick<BindingBindingCommit, "platform" | "stableDeviceId">,
): BindingPlatform {
  const platform = next.platform ?? current.platform;
  if (platform !== current.platform && next.stableDeviceId !== null) {
    throw new ActionableError(
      `A binding moves from ${current.platform} to ${platform} only with an empty binding`,
    );
  }
  return platform;
}

/** The platform a journal entry creates its device on (#11232). */
export function journalCreationPlatform(entry: Pick<BindingJournalEntry, "platform" | "target">) {
  return entry.target.newPlatform ?? entry.platform;
}
