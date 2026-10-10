import {
  isSlotJournalPhaseOpen,
  journalOwnersEqual,
  journalTargetEntries,
  sameBinding,
  scopeAcceptsSlotChange,
  SLOT_JOURNAL_TERMINAL_RETENTION_MS,
  type AdvanceSlotJournalInput,
  type AdvanceSlotJournalResult,
  type ClaimSlotJournalResult,
  type OpenSlotJournalInput,
  type OpenSlotJournalResult,
  type SlotJournalAssignmentChange,
  type SlotJournalChangeFailure,
  type SlotJournalEntry,
  type SlotJournalOwner,
  type SlotJournalTarget,
  type SlotProcessIdentity,
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
  type SlotRegistry,
  type SlotScopeIdentity,
  type SlotScopeInvalidationReason,
  type SlotScopeQuery,
  type SlotScopeRecord,
  type UpdateSlotStateOptions,
  type UpdateSlotStateResult,
} from "../../src/daemon/managedSlots/slotRegistry";
import type { Timer } from "../../src/utils/SystemTimer";

/**
 * In-memory {@link SlotRegistry} with the same semantics as the SQLite implementation (both run
 * the shared contract suite). Specs are JSON round-tripped so callers cannot alias stored state.
 */
export class FakeSlotRegistry implements SlotRegistry {
  private readonly scopes = new Map<string, SlotScopeRecord>();
  private readonly assignments = new Map<string, SlotAssignmentRecord>();
  private readonly free = new Map<string, FreeSlotDeviceRecord>();
  private readonly journal = new Map<number, SlotJournalEntry>();
  private nextJournalId = 1;
  private closed = false;

  constructor(
    private readonly timer: Timer,
    private isExecOwnerLive: SlotExecOwnerLiveness = () => true,
  ) {}

  setExecOwnerLiveness(liveness: SlotExecOwnerLiveness): void {
    this.isExecOwnerLive = liveness;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async ensureScope(identity: SlotScopeIdentity): Promise<EnsureScopeResult> {
    const scopeKey = computeSlotScopeKey(identity);
    const nowMs = this.timer.now();
    const existing = this.scopes.get(scopeKey);
    if (existing?.state === "valid") {
      existing.lastAcquiredAtMs = nowMs;
      return { kind: "ready", scope: { ...existing }, created: false, revived: false };
    }
    if (existing && !isRevivableScope(existing)) {
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
    if (existing) {
      existing.state = "valid";
      existing.invalidationReason = null;
      existing.invalidatingAtMs = null;
      existing.invalidatedAtMs = null;
      existing.lastAcquiredAtMs = nowMs;
      return { kind: "ready", scope: { ...existing }, created: false, revived: true };
    }
    for (const superseded of sameNamespace) {
      if (superseded.invalidationReason === "abandoned") {
        superseded.invalidationReason = "incarnation_reset";
        this.releaseSlotsToFreePool(superseded.scopeKey);
      }
    }
    const scope: SlotScopeRecord = {
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

  async getScope(scopeKey: string): Promise<SlotScopeRecord | null> {
    const scope = this.scopes.get(scopeKey);
    return scope ? { ...scope } : null;
  }

  async initSlot(key: SlotKey, init: SlotInit): Promise<InitSlotResult> {
    assertValidSlotKey(key);
    const scope = this.scopes.get(key.scopeKey);
    if (scope?.state !== "valid") {
      return { kind: "scope_not_valid", scope: scope ? { ...scope } : null };
    }
    const existing = this.assignments.get(slotId(key));
    if (existing) {
      return { kind: "ready", assignment: copy(existing), created: false };
    }
    const assignment: SlotAssignmentRecord = {
      scopeKey: key.scopeKey,
      slotIndex: key.slotIndex,
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
    this.assignments.set(slotId(key), assignment);
    return { kind: "ready", assignment: copy(assignment), created: true };
  }

  async commitBinding(
    key: SlotKey,
    expected: SlotBindingExpectation,
    next: SlotBindingCommit,
  ): Promise<CommitBindingResult> {
    return this.commitBindingSync(key, expected, next);
  }

  private commitBindingSync(
    key: SlotKey,
    expected: SlotBindingExpectation,
    next: SlotBindingCommit,
    journaled = false,
  ): CommitBindingResult {
    const checked = this.checkBinding(key, expected, journaled);
    if ("kind" in checked) {
      return checked;
    }
    let adoptedFreeDevice: FreeSlotDeviceRecord | null = null;
    if (next.stableDeviceId !== null) {
      const holder = [...this.assignments.values()].find(
        (assignment) =>
          assignment.platform === checked.platform &&
          assignment.stableDeviceId === next.stableDeviceId &&
          slotId(assignment) !== slotId(key),
      );
      if (holder) {
        return { kind: "device_assigned_elsewhere", holder: copy(holder) };
      }
      const freeId = deviceId(checked.platform, next.stableDeviceId);
      const freed = this.free.get(freeId);
      if (freed) {
        this.free.delete(freeId);
        adoptedFreeDevice = { ...freed };
      }
    }
    const deviceChanged = next.stableDeviceId !== checked.stableDeviceId;
    checked.generation += 1;
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
    return { kind: "committed", assignment: copy(checked), adoptedFreeDevice };
  }

  async updateSlotState(
    key: SlotKey,
    expected: SlotBindingExpectation,
    state: SlotAssignmentState,
    options?: UpdateSlotStateOptions,
  ): Promise<UpdateSlotStateResult> {
    return this.updateSlotStateSync(key, expected, state, assertSettlerForState(state, options));
  }

  private updateSlotStateSync(
    key: SlotKey,
    expected: SlotBindingExpectation,
    state: SlotAssignmentState,
    settler: SlotProcessIdentity | null,
    journaled = false,
  ): UpdateSlotStateResult {
    const checked = this.checkBinding(key, expected, journaled);
    if ("kind" in checked) {
      return checked;
    }
    const owner = checked.execOwner;
    if (state === "replacing" && owner && this.isExecOwnerLive(owner)) {
      return { kind: "slot_in_use", owner: { ...owner }, assignment: copy(checked) };
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
    key: SlotKey,
    expected: SlotBindingExpectation,
    owner: SlotExecOwner,
    options: ClaimExecutionOptions = {},
  ): Promise<ClaimExecutionResult> {
    const checked = this.checkBinding(key, expected);
    if ("kind" in checked) {
      return checked;
    }
    if (checked.state !== "ready" || checked.stableDeviceId === null) {
      return { kind: "slot_not_ready", assignment: copy(checked) };
    }
    const current = checked.execOwner;
    if (
      current &&
      current.sessionUuid !== owner.sessionUuid &&
      current.sessionUuid !== options.supersedesSessionUuid &&
      this.isExecOwnerLive(current)
    ) {
      return { kind: "slot_in_use", owner: { ...current }, assignment: copy(checked) };
    }
    checked.execOwner = { ...owner };
    checked.updatedAtMs = this.timer.now();
    return { kind: "claimed", assignment: copy(checked) };
  }

  async releaseExecution(key: SlotKey, sessionUuid: string): Promise<ReleaseExecutionResult> {
    assertValidSlotKey(key);
    const assignment = this.assignments.get(slotId(key));
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

  async recoverSettledSlots(scopeKey?: string): Promise<SlotAssignmentRecord[]> {
    const settled = [...this.assignments.values()]
      .filter(
        (assignment) =>
          assignment.state === "settling" &&
          (scopeKey === undefined || assignment.scopeKey === scopeKey) &&
          this.isSettled(assignment),
      )
      .sort((a, b) =>
        a.scopeKey === b.scopeKey ? a.slotIndex - b.slotIndex : a.scopeKey < b.scopeKey ? -1 : 1,
      );
    for (const assignment of settled) {
      assignment.state = "ready";
      assignment.settler = null;
      assignment.updatedAtMs = this.timer.now();
    }
    return settled.map(copy);
  }

  async getAssignment(key: SlotKey): Promise<SlotAssignmentRecord | null> {
    assertValidSlotKey(key);
    const assignment = this.assignments.get(slotId(key));
    return assignment ? copy(assignment) : null;
  }

  async listAssignments(scopeKey: string): Promise<SlotAssignmentRecord[]> {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.scopeKey === scopeKey)
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map(copy);
  }

  async findExecutionAssignments(sessionUuid: string): Promise<SlotAssignmentRecord[]> {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.execOwner?.sessionUuid === sessionUuid)
      .sort((a, b) =>
        a.scopeKey === b.scopeKey ? a.slotIndex - b.slotIndex : a.scopeKey < b.scopeKey ? -1 : 1,
      )
      .map(copy);
  }

  async findDeviceHolder(
    platform: SlotPlatform,
    stableDeviceId: string,
  ): Promise<DeviceHolder | null> {
    const assignment = this.findBound(platform, stableDeviceId);
    const scope = assignment ? this.scopes.get(assignment.scopeKey) : undefined;
    if (assignment && scope) {
      return { kind: "slot", scope: { ...scope }, assignment: copy(assignment) };
    }
    const freed = this.free.get(deviceId(platform, stableDeviceId));
    return freed ? { kind: "free", device: { ...freed } } : null;
  }

  async isDeviceAssignedToValidSlot(
    platform: SlotPlatform,
    stableDeviceId: string,
  ): Promise<boolean> {
    const assignment = this.findBound(platform, stableDeviceId);
    return assignment !== undefined && this.scopes.get(assignment.scopeKey)?.state === "valid";
  }

  async snapshotManagedDevices(): Promise<ManagedDeviceEntry[]> {
    const bound = [...this.assignments.values()].flatMap((assignment): ManagedDeviceEntry[] => {
      const scope = this.scopes.get(assignment.scopeKey);
      // A revivable (abandoned) scope's kept slots stay reserved for its returning incarnation.
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
          holder: "slot",
          scopeKey: assignment.scopeKey,
          slotIndex: assignment.slotIndex,
          scopeState: scope.state,
          execSessionUuid: assignment.execOwner?.sessionUuid ?? null,
        },
      ];
    });
    const freed = [...this.free.values()].map((device): ManagedDeviceEntry => ({
      platform: device.platform,
      stableDeviceId: device.stableDeviceId,
      holder: "free",
      scopeKey: device.fromScopeKey,
      slotIndex: null,
      scopeState: null,
      execSessionUuid: null,
    }));
    const entries = [...bound, ...freed];
    return [...entries, ...journalTargetEntries(await this.listOpenSlotJournal(), entries)];
  }

  async listFreeDevices(): Promise<FreeSlotDeviceRecord[]> {
    return [...this.free.values()]
      .sort((a, b) => a.freedAtMs - b.freedAtMs)
      .map((device) => ({ ...device }));
  }

  async beginScopeInvalidation(
    scopeKey: string,
    reason: SlotScopeInvalidationReason,
  ): Promise<BeginScopeInvalidationResult> {
    const scope = this.scopes.get(scopeKey);
    if (!scope) {
      return { kind: "not_found" };
    }
    if (scope.state === "valid") {
      this.markInvalidating(scope, reason);
      return { kind: "invalidating", scope: { ...scope } };
    }
    if (isRevivableScope(scope) && isPermanentInvalidationReason(reason)) {
      scope.invalidationReason = reason;
      if (scope.state === "invalidated") {
        this.releaseSlotsToFreePool(scopeKey);
      }
    }
    return scope.state === "invalidating"
      ? { kind: "already_invalidating", scope: { ...scope } }
      : { kind: "already_invalidated", scope: { ...scope } };
  }

  async completeScopeInvalidation(scopeKey: string): Promise<CompleteScopeInvalidationResult> {
    const scope = this.scopes.get(scopeKey);
    if (!scope) {
      return { kind: "not_found" };
    }
    if (scope.state === "invalidated") {
      return { kind: "already_invalidated", scope: { ...scope } };
    }
    if (scope.state !== "invalidating") {
      return { kind: "not_invalidating", scope: { ...scope } };
    }
    const assignments = [...this.assignments.values()]
      .filter((assignment) => assignment.scopeKey === scopeKey)
      .sort((a, b) => a.slotIndex - b.slotIndex);
    const liveOwners = assignments.filter(
      (assignment) => assignment.execOwner !== null && this.isExecOwnerLive(assignment.execOwner),
    );
    const settling = assignments.filter(
      (assignment) => assignment.state === "settling" && !this.isSettled(assignment),
    );
    const cleanupPending = assignments.filter(
      (assignment) => assignment.state === "cleanup_pending",
    );
    const openJournal = [...this.journal.values()]
      .filter((entry) => entry.scopeKey === scopeKey && isSlotJournalPhaseOpen(entry.phase))
      .sort((a, b) => a.id - b.id)
      .map(copyEntry);
    if (
      liveOwners.length > 0 ||
      settling.length > 0 ||
      cleanupPending.length > 0 ||
      openJournal.length > 0
    ) {
      return {
        kind: "pending",
        scope: { ...scope },
        liveOwners: liveOwners.map(copy),
        settling: settling.map(copy),
        cleanupPending: cleanupPending.map(copy),
        openJournal,
      };
    }
    const nowMs = this.timer.now();
    // An abandoned scope stays revivable: keep its slots until the invalidation is permanent.
    const freedDevices =
      scope.invalidationReason === "abandoned" ? [] : this.releaseSlotsToFreePool(scopeKey);
    scope.state = "invalidated";
    scope.invalidatedAtMs = nowMs;
    return { kind: "invalidated", scope: { ...scope }, freedDevices };
  }

  async findAbandonedScopes(query?: AbandonmentQuery): Promise<SlotScopeRecord[]> {
    const cutoffMs = this.timer.now() - resolveAbandonmentThresholdMs(query);
    return [...this.scopes.values()]
      .filter(
        (scope) =>
          scope.state === "valid" &&
          lastScopeActivityMs(scope) <= cutoffMs &&
          !this.hasLiveExecOwner(scope.scopeKey),
      )
      .sort((a, b) => lastScopeActivityMs(a) - lastScopeActivityMs(b))
      .map((scope) => ({ ...scope }));
  }

  async markScopeAbandoned(
    scopeKey: string,
    query?: AbandonmentQuery,
  ): Promise<MarkScopeAbandonedResult> {
    const thresholdMs = resolveAbandonmentThresholdMs(query);
    const scope = this.scopes.get(scopeKey);
    if (!scope) {
      return { kind: "not_found" };
    }
    if (scope.state !== "valid") {
      return { kind: "not_abandoned", scope: { ...scope }, reason: "not_valid" };
    }
    if (lastScopeActivityMs(scope) > this.timer.now() - thresholdMs) {
      return { kind: "not_abandoned", scope: { ...scope }, reason: "recent_acquisition" };
    }
    if (this.hasLiveExecOwner(scopeKey)) {
      return { kind: "not_abandoned", scope: { ...scope }, reason: "live_owner" };
    }
    this.markInvalidating(scope, "abandoned");
    return { kind: "marked", scope: { ...scope } };
  }

  async findReclaimableFreeDevices(query?: AbandonmentQuery): Promise<FreeSlotDeviceRecord[]> {
    const cutoffMs = this.timer.now() - resolveAbandonmentThresholdMs(query);
    return (await this.listFreeDevices()).filter((device) => device.freedAtMs <= cutoffMs);
  }

  async openSlotJournal(key: SlotKey, input: OpenSlotJournalInput): Promise<OpenSlotJournalResult> {
    assertValidSlotKey(key);
    if (!isSlotJournalPhaseOpen(input.phase)) {
      throw new Error(`A managed slot journal entry cannot open at phase '${input.phase}'`);
    }
    const nowMs = this.timer.now();
    for (const [id, entry] of this.journal) {
      if (
        !isSlotJournalPhaseOpen(entry.phase) &&
        entry.updatedAtMs < nowMs - SLOT_JOURNAL_TERMINAL_RETENTION_MS
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
    const entry: SlotJournalEntry = {
      id: this.nextJournalId++,
      scopeKey: key.scopeKey,
      slotIndex: key.slotIndex,
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

  async advanceSlotJournal(
    id: number,
    input: AdvanceSlotJournalInput,
  ): Promise<AdvanceSlotJournalResult> {
    const entry = this.journal.get(id);
    if (
      !entry ||
      !isSlotJournalPhaseOpen(entry.phase) ||
      entry.phase !== input.expectedPhase ||
      !journalOwnersEqual(entry.owner, input.owner)
    ) {
      return { kind: "journal_conflict", entry: entry ? copyEntry(entry) : null };
    }
    let assignment: SlotAssignmentRecord | null = null;
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

  async claimSlotJournal(
    id: number,
    expected: SlotJournalOwner,
    next: SlotJournalOwner,
  ): Promise<ClaimSlotJournalResult> {
    const entry = this.journal.get(id);
    if (
      !entry ||
      !isSlotJournalPhaseOpen(entry.phase) ||
      !journalOwnersEqual(entry.owner, expected)
    ) {
      return { kind: "journal_conflict", entry: entry ? copyEntry(entry) : null };
    }
    entry.owner = { ...next };
    entry.updatedAtMs = this.timer.now();
    return { kind: "claimed", entry: copyEntry(entry) };
  }

  async getSlotJournal(id: number): Promise<SlotJournalEntry | null> {
    const entry = this.journal.get(id);
    return entry ? copyEntry(entry) : null;
  }

  async listOpenSlotJournal(key?: SlotKey): Promise<SlotJournalEntry[]> {
    return [...this.journal.values()]
      .filter(
        (entry) => isSlotJournalPhaseOpen(entry.phase) && (!key || slotId(entry) === slotId(key)),
      )
      .sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs || a.id - b.id)
      .map(copyEntry);
  }

  async findScopes(query: SlotScopeQuery): Promise<SlotScopeRecord[]> {
    return [...this.scopes.values()]
      .filter(
        (scope) =>
          scope.runnerNamespace === query.runnerNamespace &&
          scope.runnerIncarnation === query.runnerIncarnation &&
          (query.managedHostScope === undefined ||
            scope.managedHostScope === query.managedHostScope),
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.scopeKey < b.scopeKey ? -1 : 1))
      .map((scope) => ({ ...scope }));
  }

  async listAbandonedScopes(): Promise<SlotScopeRecord[]> {
    return [...this.scopes.values()]
      .filter((scope) => scope.state === "invalidating" && scope.invalidationReason === "abandoned")
      .sort((a, b) => (a.invalidatingAtMs ?? 0) - (b.invalidatingAtMs ?? 0))
      .map((scope) => ({ ...scope }));
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private findOpenEntry(key: SlotKey): SlotJournalEntry | undefined {
    return [...this.journal.values()].find(
      (entry) => slotId(entry) === slotId(key) && isSlotJournalPhaseOpen(entry.phase),
    );
  }

  /** The fake is single-threaded, so the CAS check and both writes are already atomic. */
  private applyAssignmentChange(
    key: SlotKey,
    change: SlotJournalAssignmentChange,
  ): SlotAssignmentRecord | SlotJournalChangeFailure {
    const result =
      change.kind === "state"
        ? this.updateSlotStateSync(
            key,
            change.expected,
            change.state,
            assertSettlerForState(change.state, change.options),
            true,
          )
        : this.commitBindingSync(key, change.expected, change.next, true);
    return result.kind === "committed" || result.kind === "updated"
      ? this.assignments.get(slotId(key))!
      : result;
  }

  private checkBinding(
    key: SlotKey,
    expected: SlotBindingExpectation,
    journaled = false,
  ): SlotAssignmentRecord | SlotCasFailure {
    assertValidSlotKey(key);
    const scope = this.scopes.get(key.scopeKey);
    if (!scopeAcceptsSlotChange(scope ?? null, journaled)) {
      return { kind: "scope_not_valid", scope: scope ? { ...scope } : null };
    }
    const current = this.assignments.get(slotId(key));
    if (!current) {
      return { kind: "slot_missing" };
    }
    if (!bindingMatches(current, expected)) {
      return { kind: "stale_binding", current: copy(current) };
    }
    return current;
  }

  /** Free a scope's bound devices and remove its slots (a permanent invalidation). */
  private releaseSlotsToFreePool(scopeKey: string): FreeSlotDeviceRecord[] {
    const nowMs = this.timer.now();
    const assignments = [...this.assignments.values()]
      .filter((assignment) => assignment.scopeKey === scopeKey)
      .sort((a, b) => a.slotIndex - b.slotIndex);
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
    for (const assignment of assignments) {
      this.assignments.delete(slotId(assignment));
    }
    for (const device of freedDevices) {
      this.free.set(deviceId(device.platform, device.stableDeviceId), { ...device });
    }
    return freedDevices;
  }

  private findBound(
    platform: SlotPlatform,
    stableDeviceId: string,
  ): SlotAssignmentRecord | undefined {
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
  private isSettled(assignment: SlotAssignmentRecord): boolean {
    const { settler, execOwner } = assignment;
    return (
      (settler === null || !this.isExecOwnerLive(settler)) &&
      (execOwner === null || !this.isExecOwnerLive(execOwner))
    );
  }

  private markInvalidating(scope: SlotScopeRecord, reason: SlotScopeInvalidationReason): void {
    scope.state = "invalidating";
    scope.invalidationReason = reason;
    scope.invalidatingAtMs = this.timer.now();
  }
}

function slotId(key: SlotKey): string {
  return JSON.stringify([key.scopeKey, key.slotIndex]);
}

function deviceId(platform: SlotPlatform, stableDeviceId: string): string {
  return JSON.stringify([platform, stableDeviceId]);
}

function roundTrip(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

function copy(assignment: SlotAssignmentRecord): SlotAssignmentRecord {
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

function copyEntry(entry: SlotJournalEntry): SlotJournalEntry {
  return {
    ...entry,
    binding: { ...entry.binding },
    target: copyTarget(entry.target),
    owner: { ...entry.owner, processGenerationToken: entry.owner.processGenerationToken ?? null },
  };
}

function copyTarget(target: SlotJournalTarget): SlotJournalTarget {
  return {
    ...target,
    requestedSpec: roundTrip(target.requestedSpec),
    resolvedSpec: roundTrip(target.resolvedSpec),
  };
}
