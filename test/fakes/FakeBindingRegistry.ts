import {
  type BindingResourceSnapshot,
  isBindingJournalPhaseOpen,
  journalOwnersEqual,
  journalTargetEntries,
  sameBinding,
  scopeAcceptsSameSessionClaim,
  scopeAcceptsBindingChange,
  BINDING_JOURNAL_TERMINAL_RETENTION_MS,
  type AdvanceBindingJournalInput,
  type AdvanceBindingJournalResult,
  type ClaimBindingJournalResult,
  type OpenBindingJournalInput,
  type OpenBindingJournalResult,
  type BindingJournalAssignmentChange,
  type BindingJournalChangeFailure,
  type BindingJournalEntry,
  type BindingJournalOwner,
  type BindingJournalTarget,
  type BindingProcessIdentity,
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
  type BindingRegistry,
  type BindingScopeIdentity,
  type BindingScopeRecord,
  type UpdateBindingStateOptions,
  type UpdateBindingStateResult,
  assertPlatformChangeAllowed,
} from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { Timer } from "../../src/utils/SystemTimer";

/**
 * In-memory {@link BindingRegistry} with the same semantics as the SQLite implementation (both run
 * the shared contract suite). Specs are JSON round-tripped so callers cannot alias stored state.
 */
export class FakeBindingRegistry implements BindingRegistry {
  private readonly scopes = new Map<string, BindingScopeRecord>();
  private readonly assignments = new Map<string, BindingAssignmentRecord>();
  private readonly journal = new Map<number, BindingJournalEntry>();
  private nextJournalId = 1;
  private closed = false;

  constructor(
    private readonly timer: Timer,
    private isExecOwnerLive: BindingExecOwnerLiveness = () => true,
  ) {}

  setExecOwnerLiveness(liveness: BindingExecOwnerLiveness): void {
    this.isExecOwnerLive = liveness;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async ensureScope(identity: BindingScopeIdentity): Promise<EnsureScopeResult> {
    const scopeKey = computeBindingScopeKey(identity);
    const nowMs = this.timer.now();
    const existing = this.scopes.get(scopeKey);
    if (existing?.state === "valid") {
      existing.lastAcquiredAtMs = nowMs;
      return { kind: "ready", scope: { ...existing }, created: false, revived: false };
    }
    if (existing) {
      return { kind: "scope_invalidated", scope: { ...existing } };
    }
    const sameNamespace = [...this.scopes.values()].filter(
      (scope) =>
        scope.managedHostScope === identity.managedHostScope &&
        scope.runnerNamespace === identity.runnerNamespace &&
        scope.scopeKey !== scopeKey,
    );
    const live = sameNamespace.find((scope) => scope.state !== "invalidated");
    if (live) {
      return { kind: "incarnation_conflict", current: { ...live } };
    }
    const scope: BindingScopeRecord = {
      ...identity,
      scopeKey,
      state: "valid",
      createdAtMs: nowMs,
      lastAcquiredAtMs: nowMs,
      lastReleasedAtMs: null,
      invalidationReason: null,
      invalidatingAtMs: null,
      invalidatedAtMs: null,
    };
    this.scopes.set(scopeKey, scope);
    return { kind: "ready", scope: { ...scope }, created: true, revived: false };
  }

  async getScope(scopeKey: string): Promise<BindingScopeRecord | null> {
    const scope = this.scopes.get(scopeKey);
    return scope ? { ...scope } : null;
  }

  async initBinding(key: BindingKey, init: BindingInit): Promise<InitBindingResult> {
    assertValidBindingKey(key);
    const scope = this.scopes.get(key.scopeKey);
    if (scope?.state !== "valid") {
      return { kind: "scope_not_valid", scope: scope ? { ...scope } : null };
    }
    const existing = this.assignments.get(bindingId(key));
    if (existing) {
      return { kind: "ready", assignment: copy(existing), created: false };
    }
    const assignment: BindingAssignmentRecord = {
      scopeKey: key.scopeKey,
      bindingIndex: key.bindingIndex,
      role: init.role,
      platform: init.platform,
      generation: 0,
      stableDeviceId: null,
      deviceName: null,
      requestedSpec: roundTrip(init.requestedSpec),
      resolvedSpec: null,
      specFingerprint: null,
      state: "provisioning",
      execOwner: null,
      settler: null,
      updatedAtMs: this.timer.now(),
    };
    this.assignments.set(bindingId(key), assignment);
    return { kind: "ready", assignment: copy(assignment), created: true };
  }

  async removeUnboundBinding(
    key: BindingKey,
    expected: { generation: number; stableDeviceId: null },
  ): Promise<boolean> {
    assertValidBindingKey(key);
    const current = this.assignments.get(bindingId(key));
    if (
      !current ||
      current.generation !== expected.generation ||
      current.stableDeviceId !== null ||
      current.state !== "provisioning" ||
      current.execOwner !== null ||
      this.findOpenEntry(key)
    ) {
      return false;
    }
    return this.assignments.delete(bindingId(key));
  }

  async commitBinding(
    key: BindingKey,
    expected: BindingBindingExpectation,
    next: BindingBindingCommit,
  ): Promise<CommitBindingResult> {
    return this.commitBindingSync(key, expected, next);
  }

  private commitBindingSync(
    key: BindingKey,
    expected: BindingBindingExpectation,
    next: BindingBindingCommit,
    journaled = false,
  ): CommitBindingResult {
    const checked = this.checkBinding(key, expected, journaled);
    if ("kind" in checked) {
      return checked;
    }
    const platform = assertPlatformChangeAllowed(checked, next);
    if (next.stableDeviceId !== null) {
      const holder = [...this.assignments.values()].find(
        (assignment) =>
          assignment.platform === platform &&
          assignment.stableDeviceId === next.stableDeviceId &&
          bindingId(assignment) !== bindingId(key),
      );
      if (holder) {
        return { kind: "device_assigned_elsewhere", holder: copy(holder) };
      }
    }
    const deviceChanged =
      next.stableDeviceId !== checked.stableDeviceId || platform !== checked.platform;
    checked.generation += 1;
    checked.platform = platform;
    checked.stableDeviceId = next.stableDeviceId;
    checked.deviceName = next.deviceName;
    checked.resolvedSpec =
      next.resolvedSpec === null || next.resolvedSpec === undefined
        ? null
        : roundTrip(next.resolvedSpec);
    checked.specFingerprint = next.specFingerprint;
    checked.state = next.state;
    checked.settler = null;
    if (next.requestedSpec !== undefined) {
      checked.requestedSpec = roundTrip(next.requestedSpec);
    }
    if (deviceChanged) {
      checked.execOwner = null;
    }
    checked.updatedAtMs = this.timer.now();
    return { kind: "committed", assignment: copy(checked) };
  }

  async updateBindingState(
    key: BindingKey,
    expected: BindingBindingExpectation,
    state: BindingAssignmentState,
    options?: UpdateBindingStateOptions,
  ): Promise<UpdateBindingStateResult> {
    return this.updateBindingStateSync(key, expected, state, assertSettlerForState(state, options));
  }

  private updateBindingStateSync(
    key: BindingKey,
    expected: BindingBindingExpectation,
    state: BindingAssignmentState,
    settler: BindingProcessIdentity | null,
    journaled = false,
  ): UpdateBindingStateResult {
    const checked = this.checkBinding(key, expected, journaled);
    if ("kind" in checked) {
      return checked;
    }
    const owner = checked.execOwner;
    if (state === "replacing" && owner && this.isExecOwnerLive(owner)) {
      return { kind: "binding_in_use", owner: { ...owner }, assignment: copy(checked) };
    }
    if (entersFencingState(checked.state, state)) {
      checked.generation += 1;
    }
    checked.state = state;
    checked.settler = settler ? { ...settler } : null;
    checked.updatedAtMs = this.timer.now();
    return { kind: "updated", assignment: copy(checked) };
  }

  async claimExecution(
    key: BindingKey,
    expected: BindingBindingExpectation,
    owner: BindingExecOwner,
    options: ClaimExecutionOptions = {},
  ): Promise<ClaimExecutionResult> {
    const checked = this.checkBinding(key, expected, false, owner.sessionUuid);
    if ("kind" in checked) {
      return checked;
    }
    if (checked.state !== "ready" || checked.stableDeviceId === null) {
      return { kind: "binding_not_ready", assignment: copy(checked) };
    }
    const current = checked.execOwner;
    if (
      current &&
      current.sessionUuid !== owner.sessionUuid &&
      current.sessionUuid !== options.supersedesSessionUuid &&
      this.isExecOwnerLive(current)
    ) {
      return { kind: "binding_in_use", owner: { ...current }, assignment: copy(checked) };
    }
    checked.execOwner = { ...owner };
    checked.updatedAtMs = this.timer.now();
    return { kind: "claimed", assignment: copy(checked) };
  }

  async releaseExecution(key: BindingKey, sessionUuid: string): Promise<ReleaseExecutionResult> {
    assertValidBindingKey(key);
    const assignment = this.assignments.get(bindingId(key));
    if (!assignment) {
      return { released: false, assignment: null };
    }
    if (assignment.execOwner?.sessionUuid !== sessionUuid) {
      return { released: false, assignment: copy(assignment) };
    }
    assignment.execOwner = null;
    assignment.updatedAtMs = this.timer.now();
    const scope = this.scopes.get(assignment.scopeKey);
    if (scope) {
      scope.lastReleasedAtMs = assignment.updatedAtMs;
    }
    return { released: true, assignment: copy(assignment) };
  }

  async recoverSettledBindings(scopeKey?: string): Promise<BindingAssignmentRecord[]> {
    const settled = [...this.assignments.values()]
      .filter(
        (assignment) =>
          assignment.state === "settling" &&
          (scopeKey === undefined || assignment.scopeKey === scopeKey) &&
          this.isSettled(assignment),
      )
      .sort((a, b) =>
        a.scopeKey === b.scopeKey
          ? a.bindingIndex - b.bindingIndex
          : a.scopeKey < b.scopeKey
            ? -1
            : 1,
      );
    for (const assignment of settled) {
      assignment.state = "ready";
      assignment.settler = null;
      assignment.updatedAtMs = this.timer.now();
    }
    return settled.map(copy);
  }

  async getAssignment(key: BindingKey): Promise<BindingAssignmentRecord | null> {
    assertValidBindingKey(key);
    const assignment = this.assignments.get(bindingId(key));
    return assignment ? copy(assignment) : null;
  }

  async listAssignments(scopeKey: string): Promise<BindingAssignmentRecord[]> {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.scopeKey === scopeKey)
      .sort((a, b) => a.bindingIndex - b.bindingIndex)
      .map(copy);
  }

  async findExecutionAssignments(sessionUuid: string): Promise<BindingAssignmentRecord[]> {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.execOwner?.sessionUuid === sessionUuid)
      .sort((a, b) =>
        a.scopeKey === b.scopeKey
          ? a.bindingIndex - b.bindingIndex
          : a.scopeKey < b.scopeKey
            ? -1
            : 1,
      )
      .map(copy);
  }

  async findDeviceHolder(
    platform: BindingPlatform,
    stableDeviceId: string,
  ): Promise<DeviceHolder | null> {
    const assignment = this.findBound(platform, stableDeviceId);
    const scope = assignment ? this.scopes.get(assignment.scopeKey) : undefined;
    if (assignment && scope) {
      return { kind: "binding", scope: { ...scope }, assignment: copy(assignment) };
    }
    return null;
  }

  async isDeviceAssignedToValidBinding(
    platform: BindingPlatform,
    stableDeviceId: string,
  ): Promise<boolean> {
    const assignment = this.findBound(platform, stableDeviceId);
    return assignment !== undefined && this.scopes.get(assignment.scopeKey)?.state === "valid";
  }

  async snapshotManagedDevices(): Promise<ManagedDeviceEntry[]> {
    const bound = [...this.assignments.values()].flatMap((assignment): ManagedDeviceEntry[] => {
      const scope = this.scopes.get(assignment.scopeKey);
      // A revivable (abandoned) scope's kept bindings stay reserved for its returning incarnation.
      if (
        assignment.stableDeviceId === null ||
        !scope ||
        (scope.state === "invalidated" && scope.invalidationReason !== "abandoned")
      ) {
        return [];
      }
      return [
        {
          platform: assignment.platform,
          stableDeviceId: assignment.stableDeviceId,
          holder: "session_broker",
          scopeKey: assignment.scopeKey,
          bindingIndex: assignment.bindingIndex,
          scopeState: scope.state,
          execSessionUuid: assignment.execOwner?.sessionUuid ?? null,
        },
      ];
    });
    const entries = bound;
    return [...entries, ...journalTargetEntries(await this.listOpenBindingJournal(), entries)];
  }

  async snapshotBindingResources(): Promise<BindingResourceSnapshot> {
    // Capture every map before yielding; no concurrent mutation can tear the ledger.
    const openJournal = [...this.journal.values()]
      .filter((entry) => isBindingJournalPhaseOpen(entry.phase))
      .map((entry) => structuredClone(entry));
    const managed = await this.snapshotManagedDevices();
    return { managed, openJournal };
  }
  async openBindingJournal(
    key: BindingKey,
    input: OpenBindingJournalInput,
  ): Promise<OpenBindingJournalResult> {
    assertValidBindingKey(key);
    if (!isBindingJournalPhaseOpen(input.phase)) {
      throw new Error(`A binding journal entry cannot open at phase '${input.phase}'`);
    }
    const nowMs = this.timer.now();
    for (const [id, entry] of this.journal) {
      if (
        !isBindingJournalPhaseOpen(entry.phase) &&
        entry.updatedAtMs < nowMs - BINDING_JOURNAL_TERMINAL_RETENTION_MS
      ) {
        this.journal.delete(id);
      }
    }
    const open = this.findOpenEntry(key);
    if (open) {
      return { kind: "journal_open", entry: copyEntry(open) };
    }
    const applied = this.applyAssignmentChange(key, input.assignment);
    if ("kind" in applied) {
      return applied;
    }
    const entry: BindingJournalEntry = {
      id: this.nextJournalId++,
      scopeKey: key.scopeKey,
      bindingIndex: key.bindingIndex,
      kind: input.kind,
      phase: input.phase,
      platform: applied.platform,
      fromGeneration: input.assignment.expected.generation,
      toGeneration:
        applied.generation === input.assignment.expected.generation ? null : applied.generation,
      binding: { generation: applied.generation, stableDeviceId: applied.stableDeviceId },
      target: copyTarget(input.target),
      owner: { ...input.owner },
      attempts: 0,
      lastError: null,
      nextAttemptAtMs: nowMs,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.journal.set(entry.id, entry);
    return { kind: "opened", entry: copyEntry(entry), assignment: copy(applied) };
  }

  async advanceBindingJournal(
    id: number,
    input: AdvanceBindingJournalInput,
  ): Promise<AdvanceBindingJournalResult> {
    const entry = this.journal.get(id);
    if (
      !entry ||
      !isBindingJournalPhaseOpen(entry.phase) ||
      entry.phase !== input.expectedPhase ||
      !journalOwnersEqual(entry.owner, input.owner)
    ) {
      return { kind: "journal_conflict", entry: entry ? copyEntry(entry) : null };
    }
    let assignment: BindingAssignmentRecord | null = null;
    if (input.assignment) {
      if (!sameBinding(entry.binding, input.assignment.expected)) {
        return { kind: "journal_conflict", entry: copyEntry(entry) };
      }
      const applied = this.applyAssignmentChange(entry, input.assignment);
      if ("kind" in applied) {
        return applied;
      }
      assignment = copy(applied);
    }
    if (assignment && assignment.generation !== entry.binding.generation) {
      entry.toGeneration = assignment.generation;
    }
    if (assignment) {
      entry.binding = {
        generation: assignment.generation,
        stableDeviceId: assignment.stableDeviceId,
      };
    }
    entry.phase = input.phase;
    entry.target = copyTarget({ ...entry.target, ...input.target });
    if (input.attempt) {
      entry.attempts += 1;
      entry.lastError = input.attempt.error;
      entry.nextAttemptAtMs = input.attempt.nextAttemptAtMs;
    }
    entry.updatedAtMs = this.timer.now();
    return { kind: "advanced", entry: copyEntry(entry), assignment };
  }

  async claimBindingJournal(
    id: number,
    expected: BindingJournalOwner,
    next: BindingJournalOwner,
  ): Promise<ClaimBindingJournalResult> {
    const entry = this.journal.get(id);
    if (
      !entry ||
      !isBindingJournalPhaseOpen(entry.phase) ||
      !journalOwnersEqual(entry.owner, expected)
    ) {
      return { kind: "journal_conflict", entry: entry ? copyEntry(entry) : null };
    }
    entry.owner = { ...next };
    entry.updatedAtMs = this.timer.now();
    return { kind: "claimed", entry: copyEntry(entry) };
  }

  async getBindingJournal(id: number): Promise<BindingJournalEntry | null> {
    const entry = this.journal.get(id);
    return entry ? copyEntry(entry) : null;
  }

  async listOpenBindingJournal(key?: BindingKey): Promise<BindingJournalEntry[]> {
    return [...this.journal.values()]
      .filter(
        (entry) =>
          isBindingJournalPhaseOpen(entry.phase) && (!key || bindingId(entry) === bindingId(key)),
      )
      .sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs || a.id - b.id)
      .map(copyEntry);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private findOpenEntry(key: BindingKey): BindingJournalEntry | undefined {
    return [...this.journal.values()].find(
      (entry) => bindingId(entry) === bindingId(key) && isBindingJournalPhaseOpen(entry.phase),
    );
  }

  /** The fake is single-threaded, so the CAS check and both writes are already atomic. */
  private applyAssignmentChange(
    key: BindingKey,
    change: BindingJournalAssignmentChange,
  ): BindingAssignmentRecord | BindingJournalChangeFailure {
    const result =
      change.kind === "state"
        ? this.updateBindingStateSync(
            key,
            change.expected,
            change.state,
            assertSettlerForState(change.state, change.options),
            true,
          )
        : this.commitBindingSync(key, change.expected, change.next, true);
    return result.kind === "committed" || result.kind === "updated"
      ? this.assignments.get(bindingId(key))!
      : result;
  }

  private checkBinding(
    key: BindingKey,
    expected: BindingBindingExpectation,
    journaled = false,
    claimingSessionUuid?: string,
  ): BindingAssignmentRecord | BindingCasFailure {
    assertValidBindingKey(key);
    const scope = this.scopes.get(key.scopeKey);
    const current = this.assignments.get(bindingId(key));
    if (
      !scopeAcceptsBindingChange(scope ?? null, journaled) &&
      !(
        claimingSessionUuid !== undefined &&
        scopeAcceptsSameSessionClaim(scope ?? null, current ?? null, claimingSessionUuid)
      )
    ) {
      return { kind: "scope_not_valid", scope: scope ? { ...scope } : null };
    }
    if (!current) {
      return { kind: "binding_missing" };
    }
    if (!bindingMatches(current, expected)) {
      return { kind: "stale_binding", current: copy(current) };
    }
    return current;
  }

  private findBound(
    platform: BindingPlatform,
    stableDeviceId: string,
  ): BindingAssignmentRecord | undefined {
    return [...this.assignments.values()].find(
      (assignment) =>
        assignment.platform === platform && assignment.stableDeviceId === stableDeviceId,
    );
  }

  private hasLiveExecOwner(scopeKey: string): boolean {
    // A live settler still drives its released work, so it keeps the scope in use too.
    return [...this.assignments.values()].some(
      (assignment) => assignment.scopeKey === scopeKey && !this.isSettled(assignment),
    );
  }

  /** No live execution owner, and (when settling) no live settler. */
  private isSettled(assignment: BindingAssignmentRecord): boolean {
    const { settler, execOwner } = assignment;
    return (
      (settler === null || !this.isExecOwnerLive(settler)) &&
      (execOwner === null || !this.isExecOwnerLive(execOwner))
    );
  }
}

function bindingId(key: BindingKey): string {
  return JSON.stringify([key.scopeKey, key.bindingIndex]);
}

function roundTrip(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

function copy(assignment: BindingAssignmentRecord): BindingAssignmentRecord {
  return {
    ...assignment,
    requestedSpec: roundTrip(assignment.requestedSpec),
    resolvedSpec: roundTrip(assignment.resolvedSpec),
    execOwner: assignment.execOwner
      ? {
          ...assignment.execOwner,
          processGenerationToken: assignment.execOwner.processGenerationToken ?? null,
        }
      : null,
    settler: assignment.settler
      ? {
          ...assignment.settler,
          processGenerationToken: assignment.settler.processGenerationToken ?? null,
        }
      : null,
  };
}

function copyEntry(entry: BindingJournalEntry): BindingJournalEntry {
  return {
    ...entry,
    binding: { ...entry.binding },
    target: copyTarget(entry.target),
    owner: { ...entry.owner, processGenerationToken: entry.owner.processGenerationToken ?? null },
  };
}

function copyTarget(target: BindingJournalTarget): BindingJournalTarget {
  return {
    ...target,
    requestedSpec: roundTrip(target.requestedSpec),
    resolvedSpec: roundTrip(target.resolvedSpec),
  };
}
