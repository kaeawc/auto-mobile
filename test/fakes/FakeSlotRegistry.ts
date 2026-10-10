import {
  assertValidSlotKey,
  bindingMatches,
  computeSlotScopeKey,
  resolveAbandonmentThresholdMs,
  type AbandonmentQuery,
  type BeginScopeInvalidationResult,
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
    if (existing) {
      if (existing.state !== "valid") {
        return { kind: "scope_invalidated", scope: { ...existing } };
      }
      existing.lastAcquiredAtMs = nowMs;
      return { kind: "ready", scope: { ...existing }, created: false };
    }
    const live = [...this.scopes.values()].find(
      (scope) =>
        scope.managedHostScope === identity.managedHostScope &&
        scope.runnerNamespace === identity.runnerNamespace &&
        scope.state !== "invalidated",
    );
    if (live) {
      return { kind: "incarnation_conflict", current: { ...live } };
    }
    const scope: SlotScopeRecord = {
      ...identity,
      scopeKey,
      state: "valid",
      createdAtMs: nowMs,
      lastAcquiredAtMs: nowMs,
      invalidationReason: null,
      invalidatingAtMs: null,
      invalidatedAtMs: null,
    };
    this.scopes.set(scopeKey, scope);
    return { kind: "ready", scope: { ...scope }, created: true };
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
    const checked = this.checkBinding(key, expected);
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
  ): Promise<UpdateSlotStateResult> {
    const checked = this.checkBinding(key, expected);
    if ("kind" in checked) {
      return checked;
    }
    checked.state = state;
    checked.updatedAtMs = this.timer.now();
    return { kind: "updated", assignment: copy(checked) };
  }

  async claimExecution(
    key: SlotKey,
    expected: SlotBindingExpectation,
    owner: SlotExecOwner,
  ): Promise<ClaimExecutionResult> {
    const checked = this.checkBinding(key, expected);
    if ("kind" in checked) {
      return checked;
    }
    if (checked.state !== "ready" || checked.stableDeviceId === null) {
      return { kind: "slot_not_ready", assignment: copy(checked) };
    }
    const current = checked.execOwner;
    if (current && current.sessionUuid !== owner.sessionUuid && this.isExecOwnerLive(current)) {
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
    return { released: true, assignment: copy(assignment) };
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
      if (assignment.stableDeviceId === null || !scope || scope.state === "invalidated") {
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
    }));
    return [...bound, ...freed];
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
    if (scope.state === "invalidating") {
      return { kind: "already_invalidating", scope: { ...scope } };
    }
    if (scope.state === "invalidated") {
      return { kind: "already_invalidated", scope: { ...scope } };
    }
    this.markInvalidating(scope, reason);
    return { kind: "invalidating", scope: { ...scope } };
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
    const cleanupPending = assignments.filter(
      (assignment) => assignment.state === "cleanup_pending",
    );
    if (liveOwners.length > 0 || cleanupPending.length > 0) {
      return {
        kind: "pending",
        scope: { ...scope },
        liveOwners: liveOwners.map(copy),
        cleanupPending: cleanupPending.map(copy),
      };
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
    for (const assignment of assignments) {
      this.assignments.delete(slotId(assignment));
    }
    for (const device of freedDevices) {
      this.free.set(deviceId(device.platform, device.stableDeviceId), { ...device });
    }
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
          scope.lastAcquiredAtMs <= cutoffMs &&
          !this.hasLiveExecOwner(scope.scopeKey),
      )
      .sort((a, b) => a.lastAcquiredAtMs - b.lastAcquiredAtMs)
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
    if (scope.lastAcquiredAtMs > this.timer.now() - thresholdMs) {
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

  async close(): Promise<void> {
    this.closed = true;
  }

  private checkBinding(
    key: SlotKey,
    expected: SlotBindingExpectation,
  ): SlotAssignmentRecord | SlotCasFailure {
    assertValidSlotKey(key);
    const scope = this.scopes.get(key.scopeKey);
    if (scope?.state !== "valid") {
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
    return [...this.assignments.values()].some(
      (assignment) =>
        assignment.scopeKey === scopeKey &&
        assignment.execOwner !== null &&
        this.isExecOwnerLive(assignment.execOwner),
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
    execOwner: assignment.execOwner ? { ...assignment.execOwner } : null,
  };
}
