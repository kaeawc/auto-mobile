import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS,
  computeSlotScopeKey,
  type SlotExecOwner,
  type SlotExecOwnerLiveness,
  type SlotKey,
  type SlotRegistry,
  type SlotScopeIdentity,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

export type SlotRegistryFactory = (
  timer: FakeTimer,
  isExecOwnerLive: SlotExecOwnerLiveness,
) => Promise<SlotRegistry>;

const SCOPE_A1: SlotScopeIdentity = {
  managedHostScope: "host-1",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};
const SCOPE_A2: SlotScopeIdentity = { ...SCOPE_A1, runnerIncarnation: "boot-2" };
const SCOPE_B1: SlotScopeIdentity = { ...SCOPE_A1, runnerNamespace: "runner-b" };

const SPEC = { apiLevel: 35, deviceProfile: "pixel_8" };
const INIT = { role: "primary", platform: "android" as const, requestedSpec: SPEC };

function ownerFor(pid: number, sessionUuid: string): SlotExecOwner {
  return { daemonId: "daemon-1", pid, sessionUuid };
}

function readyBinding(stableDeviceId: string, generation: number) {
  return {
    stableDeviceId,
    deviceName: `amslot-${stableDeviceId}-g${generation}`,
    resolvedSpec: { ...SPEC, abi: "arm64-v8a" },
    specFingerprint: `fp-${stableDeviceId}`,
    state: "ready" as const,
  };
}

/**
 * Behaviour every {@link SlotRegistry} must share. Run against the fake and the SQLite registry so
 * a test written against the fake proves the real store too.
 */
export function describeSlotRegistryContract(name: string, factory: SlotRegistryFactory): void {
  describe(`${name} slot registry contract`, () => {
    let timer: FakeTimer;
    let livePids: Set<number>;
    let registry: SlotRegistry;

    beforeEach(async () => {
      timer = new FakeTimer();
      timer.setCurrentTime(1_000_000);
      livePids = new Set();
      registry = await factory(timer, (owner) => livePids.has(owner.pid));
    });

    afterEach(async () => {
      await registry.close();
    });

    async function readyScope(identity: SlotScopeIdentity = SCOPE_A1): Promise<string> {
      const result = await registry.ensureScope(identity);
      if (result.kind !== "ready") {
        throw new Error(`scope not ready: ${result.kind}`);
      }
      return result.scope.scopeKey;
    }

    async function boundSlot(key: SlotKey, stableDeviceId: string): Promise<void> {
      await registry.initSlot(key, INIT);
      const committed = await registry.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        readyBinding(stableDeviceId, 1),
      );
      expect(committed.kind).toBe("committed");
    }

    test("ensureScope creates once, refreshes acquisition time, and derives the scope key", async () => {
      const first = await registry.ensureScope(SCOPE_A1);
      timer.advanceTime(5_000);
      const second = await registry.ensureScope(SCOPE_A1);
      expect(first).toMatchObject({ kind: "ready", created: true });
      expect(second).toMatchObject({ kind: "ready", created: false });
      if (second.kind !== "ready") {
        throw new Error("expected ready");
      }
      expect(second.scope.scopeKey).toBe(computeSlotScopeKey(SCOPE_A1));
      expect(second.scope.lastAcquiredAtMs).toBe(1_005_000);
      expect(second.scope.createdAtMs).toBe(1_000_000);
    });

    test("a new incarnation conflicts until the old one is invalidated; other namespaces are independent", async () => {
      const oldKey = await readyScope(SCOPE_A1);
      expect((await registry.ensureScope(SCOPE_B1)).kind).toBe("ready");
      const conflict = await registry.ensureScope(SCOPE_A2);
      expect(conflict).toMatchObject({ kind: "incarnation_conflict" });

      await registry.beginScopeInvalidation(oldKey, "incarnation_reset");
      expect((await registry.ensureScope(SCOPE_A2)).kind).toBe("incarnation_conflict");
      await registry.completeScopeInvalidation(oldKey);
      expect(await registry.ensureScope(SCOPE_A2)).toMatchObject({ kind: "ready", created: true });
      expect((await registry.getScope(computeSlotScopeKey(SCOPE_B1)))?.state).toBe("valid");
    });

    test("an invalidated incarnation can never be revived or re-initialized", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(key.scopeKey);
      expect((await registry.ensureScope(SCOPE_A1)).kind).toBe("scope_invalidated");
      expect((await registry.initSlot(key, INIT)).kind).toBe("scope_not_valid");
    });

    test("concurrent initialization of one slot converges on a single generation-0 row", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      const results = await Promise.all([
        registry.initSlot(key, INIT),
        registry.initSlot(key, INIT),
        registry.initSlot(key, INIT),
      ]);
      const created = results.filter((result) => result.kind === "ready" && result.created);
      expect(created).toHaveLength(1);
      expect(await registry.getAssignment(key)).toMatchObject({
        generation: 0,
        stableDeviceId: null,
        state: "provisioning",
        requestedSpec: SPEC,
      });
    });

    test("the same slot index in different scopes is a different slot", async () => {
      const a = { scopeKey: await readyScope(SCOPE_A1), slotIndex: 0 };
      const b = { scopeKey: await readyScope(SCOPE_B1), slotIndex: 0 };
      await boundSlot(a, "avd-a");
      await boundSlot(b, "avd-b");
      expect((await registry.getAssignment(a))?.stableDeviceId).toBe("avd-a");
      expect((await registry.getAssignment(b))?.stableDeviceId).toBe("avd-b");
    });

    test("commitBinding bumps the generation and records the resolved spec", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      expect(await registry.getAssignment(key)).toMatchObject({
        generation: 1,
        stableDeviceId: "avd-1",
        deviceName: "amslot-avd-1-g1",
        resolvedSpec: { ...SPEC, abi: "arm64-v8a" },
        specFingerprint: "fp-avd-1",
        state: "ready",
      });
    });

    test("a stale compare-and-set loses and reports the current binding", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await registry.initSlot(key, INIT);
      const expected = { generation: 0, stableDeviceId: null };
      const [first, second] = await Promise.all([
        registry.commitBinding(key, expected, readyBinding("avd-1", 1)),
        registry.commitBinding(key, expected, readyBinding("avd-2", 1)),
      ]);
      const outcomes = [first.kind, second.kind].sort();
      expect(outcomes).toEqual(["committed", "stale_binding"]);
      const loser = first.kind === "stale_binding" ? first : second;
      if (loser.kind !== "stale_binding") {
        throw new Error("expected a stale loser");
      }
      expect(loser.current.generation).toBe(1);
      expect(await registry.isDeviceAssignedToValidSlot("android", "avd-1")).toBe(
        first.kind === "committed",
      );
    });

    test("one device can belong to at most one slot", async () => {
      const scopeKey = await readyScope();
      const a = { scopeKey, slotIndex: 0 };
      const b = { scopeKey: await readyScope(SCOPE_B1), slotIndex: 0 };
      await boundSlot(a, "avd-1");
      await registry.initSlot(b, INIT);
      const stolen = await registry.commitBinding(
        b,
        { generation: 0, stableDeviceId: null },
        readyBinding("avd-1", 1),
      );
      expect(stolen).toMatchObject({ kind: "device_assigned_elsewhere" });
      if (stolen.kind !== "device_assigned_elsewhere") {
        throw new Error("expected refusal");
      }
      expect(stolen.holder).toMatchObject({ scopeKey, slotIndex: 0 });
      expect((await registry.getAssignment(b))?.generation).toBe(0);
    });

    test("the same stable id on another platform is a different device", async () => {
      const a = { scopeKey: await readyScope(), slotIndex: 0 };
      const b = { scopeKey: a.scopeKey, slotIndex: 1 };
      await boundSlot(a, "shared-id");
      await registry.initSlot(b, { ...INIT, platform: "ios" });
      const result = await registry.commitBinding(
        b,
        { generation: 0, stableDeviceId: null },
        readyBinding("shared-id", 1),
      );
      expect(result.kind).toBe("committed");
    });

    test("updateSlotState CASes on the binding without changing the generation", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      const stale = await registry.updateSlotState(
        key,
        { generation: 0, stableDeviceId: null },
        "replacing",
      );
      expect(stale.kind).toBe("stale_binding");
      const updated = await registry.updateSlotState(
        key,
        { generation: 1, stableDeviceId: "avd-1" },
        "cleanup_pending",
      );
      expect(updated).toMatchObject({
        kind: "updated",
        assignment: { generation: 1, state: "cleanup_pending" },
      });
    });

    test("mutations on a missing slot or an invalidating scope are refused", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      const missing = await registry.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        readyBinding("avd-1", 1),
      );
      expect(missing.kind).toBe("slot_missing");
      await registry.initSlot(key, INIT);
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      const blocked = await registry.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        readyBinding("avd-1", 1),
      );
      expect(blocked.kind).toBe("scope_not_valid");
    });

    test("execution ownership: claim, live duplicate refused, dead owner taken over, release keeps the binding", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      livePids.add(100);
      expect((await registry.claimExecution(key, binding, ownerFor(100, "s1"))).kind).toBe(
        "claimed",
      );
      expect(await registry.claimExecution(key, binding, ownerFor(200, "s2"))).toMatchObject({
        kind: "slot_in_use",
        owner: { pid: 100, sessionUuid: "s1" },
      });

      livePids.delete(100);
      expect((await registry.claimExecution(key, binding, ownerFor(200, "s2"))).kind).toBe(
        "claimed",
      );
      expect((await registry.releaseExecution(key, "s1")).released).toBe(false);
      const released = await registry.releaseExecution(key, "s2");
      expect(released.released).toBe(true);
      expect(released.assignment).toMatchObject({
        stableDeviceId: "avd-1",
        generation: 1,
        execOwner: null,
      });
      expect((await registry.releaseExecution(key, "s2")).released).toBe(false);
      expect(await registry.isDeviceAssignedToValidSlot("android", "avd-1")).toBe(true);
    });

    test("an execution cannot claim a slot that is not ready", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await registry.initSlot(key, INIT);
      const result = await registry.claimExecution(
        key,
        { generation: 0, stableDeviceId: null },
        ownerFor(1, "s1"),
      );
      expect(result.kind).toBe("slot_not_ready");
    });

    test("binding a different device drops the previous device's execution owner", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      livePids.add(100);
      await registry.claimExecution(
        key,
        { generation: 1, stableDeviceId: "avd-1" },
        ownerFor(100, "s1"),
      );
      const replaced = await registry.commitBinding(
        key,
        { generation: 1, stableDeviceId: "avd-1" },
        readyBinding("avd-2", 2),
      );
      expect(replaced).toMatchObject({
        kind: "committed",
        assignment: { generation: 2, stableDeviceId: "avd-2", execOwner: null },
      });
    });

    test("read APIs distinguish valid slots, invalidating scopes and the free pool", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      expect(await registry.findDeviceHolder("android", "avd-1")).toMatchObject({
        kind: "slot",
        scope: { state: "valid" },
        assignment: { slotIndex: 0 },
      });
      expect(await registry.findDeviceHolder("android", "unknown")).toBeNull();

      await registry.beginScopeInvalidation(key.scopeKey, "incarnation_reset");
      expect(await registry.isDeviceAssignedToValidSlot("android", "avd-1")).toBe(false);
      expect(await registry.snapshotManagedDevices()).toEqual([
        {
          platform: "android",
          stableDeviceId: "avd-1",
          holder: "slot",
          scopeKey: key.scopeKey,
          slotIndex: 0,
          scopeState: "invalidating",
        },
      ]);

      await registry.completeScopeInvalidation(key.scopeKey);
      expect(await registry.findDeviceHolder("android", "avd-1")).toMatchObject({
        kind: "free",
        device: { fromScopeKey: key.scopeKey, specFingerprint: "fp-avd-1" },
      });
      expect(await registry.snapshotManagedDevices()).toEqual([
        {
          platform: "android",
          stableDeviceId: "avd-1",
          holder: "free",
          scopeKey: key.scopeKey,
          slotIndex: null,
          scopeState: null,
        },
      ]);
    });

    test("scope invalidation is idempotent and waits for live owners and pending cleanup", async () => {
      const scopeKey = await readyScope();
      const owned = { scopeKey, slotIndex: 0 };
      const cleaning = { scopeKey, slotIndex: 1 };
      await boundSlot(owned, "avd-1");
      await boundSlot(cleaning, "avd-2");
      livePids.add(100);
      await registry.claimExecution(
        owned,
        { generation: 1, stableDeviceId: "avd-1" },
        ownerFor(100, "s1"),
      );
      await registry.updateSlotState(
        cleaning,
        { generation: 1, stableDeviceId: "avd-2" },
        "cleanup_pending",
      );

      expect((await registry.completeScopeInvalidation(scopeKey)).kind).toBe("not_invalidating");
      expect((await registry.beginScopeInvalidation(scopeKey, "incarnation_reset")).kind).toBe(
        "invalidating",
      );
      expect((await registry.beginScopeInvalidation(scopeKey, "operator_reset")).kind).toBe(
        "already_invalidating",
      );
      const pending = await registry.completeScopeInvalidation(scopeKey);
      expect(pending.kind).toBe("pending");
      if (pending.kind !== "pending") {
        throw new Error("expected pending");
      }
      expect(pending.liveOwners.map((slot) => slot.slotIndex)).toEqual([0]);
      expect(pending.cleanupPending.map((slot) => slot.slotIndex)).toEqual([1]);
      expect(await registry.listAssignments(scopeKey)).toHaveLength(2);
      expect((await registry.getScope(scopeKey))?.invalidationReason).toBe("incarnation_reset");
    });

    test("completing invalidation frees bound devices for managed adoption only", async () => {
      const oldKey = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(oldKey, "avd-1");
      await registry.initSlot({ scopeKey: oldKey.scopeKey, slotIndex: 1 }, INIT);
      timer.advanceTime(10);
      await registry.beginScopeInvalidation(oldKey.scopeKey, "incarnation_reset");
      const done = await registry.completeScopeInvalidation(oldKey.scopeKey);
      expect(done).toMatchObject({
        kind: "invalidated",
        scope: { state: "invalidated", invalidatedAtMs: 1_000_010 },
        freedDevices: [{ stableDeviceId: "avd-1", freedAtMs: 1_000_010 }],
      });
      expect(await registry.listAssignments(oldKey.scopeKey)).toEqual([]);
      expect((await registry.completeScopeInvalidation(oldKey.scopeKey)).kind).toBe(
        "already_invalidated",
      );
      expect((await registry.beginScopeInvalidation(oldKey.scopeKey, "operator_reset")).kind).toBe(
        "already_invalidated",
      );

      const newKey = { scopeKey: await readyScope(SCOPE_A2), slotIndex: 0 };
      await registry.initSlot(newKey, INIT);
      const adopted = await registry.commitBinding(
        newKey,
        { generation: 0, stableDeviceId: null },
        readyBinding("avd-1", 1),
      );
      expect(adopted).toMatchObject({
        kind: "committed",
        adoptedFreeDevice: { stableDeviceId: "avd-1", fromScopeKey: oldKey.scopeKey },
      });
      expect(await registry.listFreeDevices()).toEqual([]);
    });

    test("invalidation of an unknown scope reports not_found", async () => {
      expect((await registry.beginScopeInvalidation("missing", "operator_reset")).kind).toBe(
        "not_found",
      );
      expect((await registry.completeScopeInvalidation("missing")).kind).toBe("not_found");
      expect((await registry.markScopeAbandoned("missing")).kind).toBe("not_found");
    });

    test("a scope is abandoned only after one hour with no acquisition and no live owner", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      await readyScope(SCOPE_B1);

      timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS - 1);
      expect(await registry.findAbandonedScopes()).toEqual([]);
      expect(await registry.markScopeAbandoned(key.scopeKey)).toMatchObject({
        kind: "not_abandoned",
        reason: "recent_acquisition",
      });

      await registry.ensureScope(SCOPE_B1);
      timer.advanceTime(1);
      const abandoned = await registry.findAbandonedScopes();
      expect(abandoned.map((scope) => scope.scopeKey)).toEqual([key.scopeKey]);

      livePids.add(100);
      await registry.claimExecution(
        key,
        { generation: 1, stableDeviceId: "avd-1" },
        ownerFor(100, "s1"),
      );
      expect(await registry.findAbandonedScopes()).toEqual([]);
      expect(await registry.markScopeAbandoned(key.scopeKey)).toMatchObject({
        kind: "not_abandoned",
        reason: "live_owner",
      });

      livePids.delete(100);
      const marked = await registry.markScopeAbandoned(key.scopeKey);
      expect(marked).toMatchObject({
        kind: "marked",
        scope: { state: "invalidating", invalidationReason: "abandoned" },
      });
      expect((await registry.ensureScope(SCOPE_A1)).kind).toBe("scope_invalidated");
      expect(await registry.markScopeAbandoned(key.scopeKey)).toMatchObject({
        kind: "not_abandoned",
        reason: "not_valid",
      });
      expect(await registry.findAbandonedScopes()).toEqual([]);
    });

    test("free devices become reclaimable after the abandonment threshold", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(key.scopeKey);
      expect(await registry.findReclaimableFreeDevices()).toEqual([]);
      timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS);
      expect(
        (await registry.findReclaimableFreeDevices()).map((device) => device.stableDeviceId),
      ).toEqual(["avd-1"]);
      expect(
        await registry.findReclaimableFreeDevices({ thresholdMs: 2 * 60 * 60 * 1000 }),
      ).toEqual([]);
    });

    test("malformed slot keys and thresholds are rejected before storage", async () => {
      const scopeKey = await readyScope();
      await expect(registry.initSlot({ scopeKey, slotIndex: -1 }, INIT)).rejects.toThrow(
        "non-negative integer",
      );
      await expect(registry.initSlot({ scopeKey, slotIndex: 1.5 }, INIT)).rejects.toThrow(
        "non-negative integer",
      );
      await expect(registry.findAbandonedScopes({ thresholdMs: -1 })).rejects.toThrow(
        "non-negative",
      );
    });
  });
}
