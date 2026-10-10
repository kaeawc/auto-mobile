import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS,
  SLOT_JOURNAL_TERMINAL_RETENTION_MS,
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

    test("updateSlotState CASes on the binding; a non-fencing change keeps the generation", async () => {
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
        "provisioning",
      );
      expect(updated).toMatchObject({
        kind: "updated",
        assignment: { generation: 1, state: "provisioning" },
      });
    });

    test("entering replacing or cleanup_pending bumps the generation, fencing stale writers", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      const before = { generation: 1, stableDeviceId: "avd-1" };
      const fenced = await registry.updateSlotState(key, before, "replacing");
      expect(fenced).toMatchObject({
        kind: "updated",
        assignment: { generation: 2, stableDeviceId: "avd-1", state: "replacing" },
      });

      // A reuse that read `ready` before the fence can no longer overwrite it, nor claim.
      expect((await registry.updateSlotState(key, before, "ready")).kind).toBe("stale_binding");
      expect((await registry.claimExecution(key, before, ownerFor(1, "s1"))).kind).toBe(
        "stale_binding",
      );
      expect((await registry.getAssignment(key))?.state).toBe("replacing");

      const pending = await registry.updateSlotState(
        key,
        { generation: 2, stableDeviceId: "avd-1" },
        "cleanup_pending",
      );
      expect(pending).toMatchObject({ kind: "updated", assignment: { generation: 3 } });
      // Re-entering the same fencing state is not a new fence.
      expect(
        await registry.updateSlotState(
          key,
          { generation: 3, stableDeviceId: "avd-1" },
          "cleanup_pending",
        ),
      ).toMatchObject({ kind: "updated", assignment: { generation: 3 } });
    });

    test("entering replacing is refused while a live execution owns the slot", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      livePids.add(100);
      await registry.claimExecution(key, binding, ownerFor(100, "s1"));

      expect(await registry.updateSlotState(key, binding, "replacing")).toMatchObject({
        kind: "slot_in_use",
        owner: { sessionUuid: "s1" },
      });
      expect(await registry.getAssignment(key)).toMatchObject({ generation: 1, state: "ready" });

      livePids.delete(100);
      expect((await registry.updateSlotState(key, binding, "replacing")).kind).toBe("updated");
    });

    test("settling records its settler, fences the slot, and clears the settler on leaving", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      await expect(registry.updateSlotState(key, binding, "settling")).rejects.toThrow(
        "settling daemon",
      );
      const settler = { daemonId: "daemon-a", pid: 300, processGenerationToken: "linux:b:1" };
      expect(await registry.updateSlotState(key, binding, "settling", { settler })).toMatchObject({
        kind: "updated",
        assignment: { generation: 2, state: "settling", settler },
      });
      expect(
        await registry.updateSlotState(key, { generation: 2, stableDeviceId: "avd-1" }, "ready"),
      ).toMatchObject({ kind: "updated", assignment: { generation: 2, settler: null } });
    });

    test("recoverSettledSlots returns only slots whose settler is gone to ready", async () => {
      const scopeKey = await readyScope();
      const other = await readyScope(SCOPE_B1);
      const mine = { scopeKey, slotIndex: 0 };
      const live = { scopeKey, slotIndex: 1 };
      const elsewhere = { scopeKey: other, slotIndex: 0 };
      await boundSlot(mine, "avd-1");
      await boundSlot(live, "avd-2");
      await boundSlot(elsewhere, "avd-3");
      livePids.add(301);
      for (const [key, id, pid] of [
        [mine, "avd-1", 300],
        [live, "avd-2", 301],
        [elsewhere, "avd-3", 300],
      ] as const) {
        await registry.updateSlotState(key, { generation: 1, stableDeviceId: id }, "settling", {
          settler: { daemonId: "d", pid },
        });
      }

      const recovered = await registry.recoverSettledSlots(scopeKey);

      expect(recovered.map((slot) => [slot.scopeKey, slot.slotIndex])).toEqual([[scopeKey, 0]]);
      expect(await registry.getAssignment(mine)).toMatchObject({
        generation: 2,
        state: "ready",
        settler: null,
      });
      expect((await registry.getAssignment(live))?.state).toBe("settling");
      expect((await registry.getAssignment(elsewhere))?.state).toBe("settling");
      expect((await registry.recoverSettledSlots()).map((slot) => slot.scopeKey)).toEqual([other]);
    });

    test("a slot settling under a dead settler does not block scope invalidation; a live one does", async () => {
      const scopeKey = await readyScope();
      const key = { scopeKey, slotIndex: 0 };
      await boundSlot(key, "avd-1");
      livePids.add(300);
      await registry.updateSlotState(key, { generation: 1, stableDeviceId: "avd-1" }, "settling", {
        settler: { daemonId: "d", pid: 300 },
      });
      timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS);
      // A live settler still drives the released work, so the scope is not abandoned.
      expect(await registry.markScopeAbandoned(scopeKey)).toMatchObject({
        kind: "not_abandoned",
        reason: "live_owner",
      });
      await registry.beginScopeInvalidation(scopeKey, "operator_reset");
      const pending = await registry.completeScopeInvalidation(scopeKey);
      expect(pending).toMatchObject({ kind: "pending", liveOwners: [], cleanupPending: [] });
      if (pending.kind !== "pending") {
        throw new Error("expected pending");
      }
      expect(pending.settling.map((slot) => slot.slotIndex)).toEqual([0]);

      livePids.delete(300);
      expect(await registry.completeScopeInvalidation(scopeKey)).toMatchObject({
        kind: "invalidated",
        freedDevices: [{ stableDeviceId: "avd-1" }],
      });
    });

    test("a claim may supersede only the reservation it names", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      livePids.add(100);
      await registry.claimExecution(key, binding, ownerFor(100, "reserve-1"));

      expect(
        await registry.claimExecution(key, binding, ownerFor(100, "s1"), {
          supersedesSessionUuid: "reserve-other",
        }),
      ).toMatchObject({ kind: "slot_in_use", owner: { sessionUuid: "reserve-1" } });
      expect(
        await registry.claimExecution(key, binding, ownerFor(100, "s1"), {
          supersedesSessionUuid: "reserve-1",
        }),
      ).toMatchObject({ kind: "claimed", assignment: { execOwner: { sessionUuid: "s1" } } });
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

    test("the owner's process-generation token round-trips and is cleared on release", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      const claimed = await registry.claimExecution(key, binding, {
        ...ownerFor(100, "s1"),
        processGenerationToken: "linux:boot:42",
      });
      expect(claimed).toMatchObject({
        kind: "claimed",
        assignment: { execOwner: { pid: 100, processGenerationToken: "linux:boot:42" } },
      });
      expect((await registry.getAssignment(key))?.execOwner?.processGenerationToken).toBe(
        "linux:boot:42",
      );
      await registry.releaseExecution(key, "s1");
      await registry.claimExecution(key, binding, ownerFor(100, "s2"));
      expect((await registry.getAssignment(key))?.execOwner?.processGenerationToken).toBeNull();
    });

    test("findExecutionAssignments resolves the slots a session holds, and none once released", async () => {
      const scopeKey = await readyScope();
      const first = { scopeKey, slotIndex: 0 };
      const second = { scopeKey, slotIndex: 1 };
      await boundSlot(first, "avd-1");
      await boundSlot(second, "avd-2");
      livePids.add(100);
      await registry.claimExecution(
        first,
        { generation: 1, stableDeviceId: "avd-1" },
        ownerFor(100, "s1"),
      );
      await registry.claimExecution(
        second,
        { generation: 1, stableDeviceId: "avd-2" },
        ownerFor(100, "s1"),
      );

      const held = await registry.findExecutionAssignments("s1");
      expect(held.map((assignment) => assignment.slotIndex)).toEqual([0, 1]);
      expect(await registry.findExecutionAssignments("s2")).toEqual([]);

      await registry.releaseExecution(first, "s1");
      expect((await registry.findExecutionAssignments("s1")).map((a) => a.slotIndex)).toEqual([1]);
      // The binding survives the release.
      expect(await registry.getAssignment(first)).toMatchObject({
        stableDeviceId: "avd-1",
        execOwner: null,
      });
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
          execSessionUuid: null,
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
          execSessionUuid: null,
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
      expect(await registry.markScopeAbandoned(key.scopeKey)).toMatchObject({
        kind: "not_abandoned",
        reason: "not_valid",
      });
      expect(await registry.findAbandonedScopes()).toEqual([]);
    });

    async function abandon(scopeKey: string): Promise<void> {
      timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS);
      expect((await registry.markScopeAbandoned(scopeKey)).kind).toBe("marked");
    }

    test("an abandoned scope revives when the same incarnation returns, keeping its bindings", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      await abandon(key.scopeKey);
      expect(await registry.isDeviceAssignedToValidSlot("android", "avd-1")).toBe(false);

      const revived = await registry.ensureScope(SCOPE_A1);
      expect(revived).toMatchObject({
        kind: "ready",
        created: false,
        revived: true,
        scope: {
          state: "valid",
          invalidationReason: null,
          invalidatingAtMs: null,
          lastAcquiredAtMs: timer.now(),
        },
      });
      // The surviving binding is reused as-is; a deleted device is the reconciler's to recreate.
      expect(await registry.getAssignment(key)).toMatchObject({
        generation: 1,
        stableDeviceId: "avd-1",
        state: "ready",
      });
      expect(await registry.isDeviceAssignedToValidSlot("android", "avd-1")).toBe(true);
      expect(
        await registry.commitBinding(
          key,
          { generation: 1, stableDeviceId: "avd-1" },
          readyBinding("avd-1b", 2),
        ),
      ).toMatchObject({ kind: "committed", assignment: { generation: 2 } });
      expect(await registry.ensureScope(SCOPE_A1)).toMatchObject({ kind: "ready", revived: false });
    });

    test("a scope abandoned through to invalidated keeps its slots, reserved for its revival", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      await abandon(key.scopeKey);
      expect(await registry.completeScopeInvalidation(key.scopeKey)).toMatchObject({
        kind: "invalidated",
        freedDevices: [],
      });

      // Still excluded from generic allocation, not in the free pool, not adoptable elsewhere.
      expect(await registry.listFreeDevices()).toEqual([]);
      expect(await registry.snapshotManagedDevices()).toEqual([
        expect.objectContaining({
          stableDeviceId: "avd-1",
          holder: "slot",
          slotIndex: 0,
          scopeState: "invalidated",
        }),
      ]);
      const other = { scopeKey: await readyScope(SCOPE_B1), slotIndex: 0 };
      await registry.initSlot(other, INIT);
      expect(
        await registry.commitBinding(
          other,
          { generation: 0, stableDeviceId: null },
          readyBinding("avd-1", 1),
        ),
      ).toMatchObject({ kind: "device_assigned_elsewhere" });

      expect(await registry.ensureScope(SCOPE_A1)).toMatchObject({
        kind: "ready",
        revived: true,
        scope: { state: "valid", invalidatedAtMs: null },
      });
      // The same row, binding and generation: nothing is re-created or re-adopted.
      expect(await registry.getAssignment(key)).toMatchObject({
        generation: 1,
        stableDeviceId: "avd-1",
        state: "ready",
      });
      expect(await registry.isDeviceAssignedToValidSlot("android", "avd-1")).toBe(true);
    });

    test("the abandonment clock runs from the last execution release, not the acquisition", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      livePids.add(100);
      await registry.claimExecution(key, binding, ownerFor(100, "s1"));
      // A 50-minute execution ends.
      timer.advanceTime(50 * 60 * 1000);
      await registry.releaseExecution(key, "s1");
      livePids.delete(100);
      expect((await registry.getScope(key.scopeKey))?.lastReleasedAtMs).toBe(timer.now());

      timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS - 1);
      expect(await registry.findAbandonedScopes()).toEqual([]);
      expect(await registry.markScopeAbandoned(key.scopeKey)).toMatchObject({
        kind: "not_abandoned",
        reason: "recent_acquisition",
      });
      timer.advanceTime(1);
      expect((await registry.findAbandonedScopes()).map((scope) => scope.scopeKey)).toEqual([
        key.scopeKey,
      ]);
    });

    test("an explicit reset of an abandoned scope is permanent and frees its kept slots", async () => {
      const invalidating = await readyScope(SCOPE_A1);
      await abandon(invalidating);
      expect(await registry.beginScopeInvalidation(invalidating, "operator_reset")).toMatchObject({
        kind: "already_invalidating",
        scope: { invalidationReason: "operator_reset" },
      });
      expect((await registry.ensureScope(SCOPE_A1)).kind).toBe("scope_invalidated");

      const invalidated = await readyScope(SCOPE_B1);
      const kept = { scopeKey: invalidated, slotIndex: 0 };
      await boundSlot(kept, "avd-b");
      await abandon(invalidated);
      await registry.completeScopeInvalidation(invalidated);
      expect(await registry.listAssignments(invalidated)).toHaveLength(1);
      expect(await registry.beginScopeInvalidation(invalidated, "operator_reset")).toMatchObject({
        kind: "already_invalidated",
        scope: { invalidationReason: "operator_reset" },
      });
      expect((await registry.ensureScope(SCOPE_B1)).kind).toBe("scope_invalidated");
      expect(await registry.listAssignments(invalidated)).toEqual([]);
      expect((await registry.listFreeDevices()).map((device) => device.stableDeviceId)).toEqual([
        "avd-b",
      ]);
    });

    test("an abandonment-only re-mark keeps the scope revivable", async () => {
      const scopeKey = await readyScope();
      await abandon(scopeKey);
      expect(await registry.beginScopeInvalidation(scopeKey, "abandoned")).toMatchObject({
        kind: "already_invalidating",
        scope: { invalidationReason: "abandoned" },
      });
      expect(await registry.ensureScope(SCOPE_A1)).toMatchObject({ kind: "ready", revived: true });
    });

    test("a newer incarnation makes an abandoned one permanently invalid and frees its slots", async () => {
      const oldKey = await readyScope(SCOPE_A1);
      await boundSlot({ scopeKey: oldKey, slotIndex: 0 }, "avd-old");
      await abandon(oldKey);
      // Still invalidating: the old incarnation blocks the new one until it settles.
      expect((await registry.ensureScope(SCOPE_A2)).kind).toBe("incarnation_conflict");
      await registry.completeScopeInvalidation(oldKey);
      expect(await registry.listFreeDevices()).toEqual([]);

      const newKey = await readyScope(SCOPE_A2);
      expect((await registry.getScope(oldKey))?.invalidationReason).toBe("incarnation_reset");
      expect(await registry.listAssignments(oldKey)).toEqual([]);
      expect(await registry.findDeviceHolder("android", "avd-old")).toMatchObject({
        kind: "free",
        device: { fromScopeKey: oldKey },
      });
      expect((await registry.ensureScope(SCOPE_A1)).kind).toBe("scope_invalidated");

      await registry.beginScopeInvalidation(newKey, "operator_reset");
      await registry.completeScopeInvalidation(newKey);
      expect((await registry.ensureScope(SCOPE_A1)).kind).toBe("scope_invalidated");
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

    describe("slot journal (#11179)", () => {
      const OWNER_1 = { daemonId: "daemon-1", pid: 101, processGenerationToken: "tok-1" };
      const OWNER_2 = { daemonId: "daemon-2", pid: 202, processGenerationToken: null };
      const TARGET = {
        oldStableId: "avd-1",
        oldName: "amslot-avd-1-g1",
        newName: null,
        newStableId: null,
        requestedSpec: { apiLevel: 36 },
        resolvedSpec: null,
        specFingerprint: "fp-new",
      };
      const BOUND = { generation: 1, stableDeviceId: "avd-1" };
      // Entering `replacing` is a fence: it bumps the generation (#11242).
      const FENCED = { generation: 2, stableDeviceId: "avd-1" };

      async function openReplace(key: SlotKey) {
        const opened = await registry.openSlotJournal(key, {
          kind: "replace",
          phase: "deleting",
          owner: OWNER_1,
          target: TARGET,
          assignment: { kind: "state", expected: BOUND, state: "replacing" },
        });
        if (opened.kind !== "opened") {
          throw new Error(`journal not opened: ${opened.kind}`);
        }
        return opened.entry;
      }

      test("opening records the exact target and binding with the assignment change, one per slot", async () => {
        const key = { scopeKey: await readyScope(), slotIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);

        expect(entry).toMatchObject({
          kind: "replace",
          phase: "deleting",
          platform: "android",
          fromGeneration: 1,
          toGeneration: 2,
          binding: FENCED,
          target: TARGET,
          owner: OWNER_1,
          attempts: 0,
          nextAttemptAtMs: 1_000_000,
        });
        expect((await registry.getAssignment(key))?.state).toBe("replacing");
        expect(await registry.listOpenSlotJournal(key)).toEqual([entry]);
        const second = await registry.openSlotJournal(key, {
          kind: "release",
          phase: "intent",
          owner: OWNER_2,
          target: TARGET,
          assignment: { kind: "state", expected: BOUND, state: "cleanup_pending" },
        });
        expect(second).toMatchObject({ kind: "journal_open", entry: { id: entry.id } });
        expect((await registry.getAssignment(key))?.state).toBe("replacing");
      });

      test("a stale binding refuses to open and writes nothing", async () => {
        const key = { scopeKey: await readyScope(), slotIndex: 0 };
        await boundSlot(key, "avd-1");
        const refused = await registry.openSlotJournal(key, {
          kind: "replace",
          phase: "deleting",
          owner: OWNER_1,
          target: TARGET,
          assignment: {
            kind: "state",
            expected: { generation: 0, stableDeviceId: null },
            state: "replacing",
          },
        });
        expect(refused.kind).toBe("stale_binding");
        expect(await registry.listOpenSlotJournal()).toEqual([]);
        expect((await registry.getAssignment(key))?.state).toBe("ready");
      });

      test("advancing commits the binding and the phase together and tracks the new binding", async () => {
        const key = { scopeKey: await readyScope(), slotIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        const deleted = await registry.advanceSlotJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "deleted",
          assignment: {
            kind: "commit",
            expected: FENCED,
            next: {
              stableDeviceId: null,
              deviceName: null,
              resolvedSpec: null,
              specFingerprint: null,
              state: "provisioning",
            },
          },
        });
        expect(deleted).toMatchObject({
          kind: "advanced",
          entry: {
            phase: "deleted",
            toGeneration: 3,
            binding: { generation: 3, stableDeviceId: null },
          },
          assignment: { generation: 3, stableDeviceId: null, state: "provisioning" },
        });

        const creating = await registry.advanceSlotJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleted",
          phase: "creating",
          target: { newName: "amslot-new-g3" },
        });
        expect(creating).toMatchObject({
          kind: "advanced",
          entry: { phase: "creating", target: { ...TARGET, newName: "amslot-new-g3" } },
          assignment: null,
        });
      });

      test("a failed assignment CAS leaves the entry unchanged; wrong phase, owner or binding conflict", async () => {
        const key = { scopeKey: await readyScope(), slotIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        // Someone else rebinds the slot underneath the entry.
        await registry.commitBinding(key, FENCED, readyBinding("avd-9", 3));

        const stale = await registry.advanceSlotJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "deleting",
          assignment: { kind: "state", expected: FENCED, state: "cleanup_pending" },
        });
        expect(stale.kind).toBe("stale_binding");
        expect(await registry.getSlotJournal(entry.id)).toEqual(entry);

        const wrongBinding = await registry.advanceSlotJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "deleted",
          assignment: {
            kind: "state",
            expected: { generation: 2, stableDeviceId: "avd-9" },
            state: "ready",
          },
        });
        expect(wrongBinding.kind).toBe("journal_conflict");
        expect(
          (
            await registry.advanceSlotJournal(entry.id, {
              owner: OWNER_2,
              expectedPhase: "deleting",
              phase: "rolled_back",
            })
          ).kind,
        ).toBe("journal_conflict");
        expect(
          (
            await registry.advanceSlotJournal(entry.id, {
              owner: OWNER_1,
              expectedPhase: "creating",
              phase: "rolled_back",
            })
          ).kind,
        ).toBe("journal_conflict");
      });

      test("attempts record backoff; terminal entries free the slot for a new entry", async () => {
        const key = { scopeKey: await readyScope(), slotIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        const failed = await registry.advanceSlotJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "deleting",
          assignment: { kind: "state", expected: FENCED, state: "cleanup_pending" },
          attempt: { error: "delete failed", nextAttemptAtMs: 1_002_000 },
        });
        // replacing → cleanup_pending is another fence: the generation moves again.
        expect(failed).toMatchObject({
          kind: "advanced",
          entry: {
            attempts: 1,
            lastError: "delete failed",
            nextAttemptAtMs: 1_002_000,
            binding: { generation: 3, stableDeviceId: "avd-1" },
          },
          assignment: { state: "cleanup_pending", generation: 3 },
        });
        await registry.advanceSlotJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "rolled_back",
        });
        expect(await registry.listOpenSlotJournal()).toEqual([]);
        expect(
          (
            await registry.advanceSlotJournal(entry.id, {
              owner: OWNER_1,
              expectedPhase: "rolled_back",
              phase: "committed",
            })
          ).kind,
        ).toBe("journal_conflict");
        const reopened = await registry.openSlotJournal(key, {
          kind: "replace",
          phase: "deleting",
          owner: OWNER_1,
          target: TARGET,
          assignment: {
            kind: "state",
            expected: { generation: 3, stableDeviceId: "avd-1" },
            state: "cleanup_pending",
          },
        });
        expect(reopened.kind).toBe("opened");
      });

      test("claiming moves ownership only from the expected owner", async () => {
        const key = { scopeKey: await readyScope(), slotIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        expect(await registry.claimSlotJournal(entry.id, OWNER_2, OWNER_2)).toMatchObject({
          kind: "journal_conflict",
        });
        expect(await registry.claimSlotJournal(entry.id, OWNER_1, OWNER_2)).toMatchObject({
          kind: "claimed",
          entry: { owner: OWNER_2 },
        });
        expect(await registry.claimSlotJournal(entry.id, OWNER_1, OWNER_1)).toMatchObject({
          kind: "journal_conflict",
        });
        expect(
          (
            await registry.advanceSlotJournal(entry.id, {
              owner: OWNER_1,
              expectedPhase: "deleting",
              phase: "rolled_back",
            })
          ).kind,
        ).toBe("journal_conflict");
      });

      test("open work blocks scope invalidation but may settle while the scope is invalidating", async () => {
        const key = { scopeKey: await readyScope(), slotIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        await registry.beginScopeInvalidation(key.scopeKey, "incarnation_reset");
        const pending = await registry.completeScopeInvalidation(key.scopeKey);
        expect(pending).toMatchObject({ kind: "pending", openJournal: [{ id: entry.id }] });

        const settled = await registry.advanceSlotJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "deleted",
          assignment: {
            kind: "commit",
            expected: FENCED,
            next: {
              stableDeviceId: null,
              deviceName: null,
              resolvedSpec: null,
              specFingerprint: null,
              state: "provisioning",
            },
          },
        });
        expect(settled.kind).toBe("advanced");
        await registry.advanceSlotJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleted",
          phase: "committed",
        });
        expect((await registry.completeScopeInvalidation(key.scopeKey)).kind).toBe("invalidated");
        // Non-journaled mutations still need a valid scope.
        expect(
          (await registry.updateSlotState(key, { generation: 3, stableDeviceId: null }, "ready"))
            .kind,
        ).toBe("scope_not_valid");
      });

      test("a device an open entry is creating is excluded from generic allocation", async () => {
        const key = { scopeKey: await readyScope(), slotIndex: 0 };
        await registry.initSlot(key, INIT);
        const opened = await registry.openSlotJournal(key, {
          kind: "create",
          phase: "creating",
          owner: OWNER_1,
          target: { ...TARGET, oldStableId: null, oldName: null, newName: "amslot-new-g1" },
          assignment: {
            kind: "state",
            expected: { generation: 0, stableDeviceId: null },
            state: "provisioning",
          },
        });
        expect(opened.kind).toBe("opened");
        expect(await registry.snapshotManagedDevices()).toEqual([
          {
            platform: "android",
            stableDeviceId: "amslot-new-g1",
            holder: "slot",
            scopeKey: key.scopeKey,
            slotIndex: 0,
            scopeState: null,
            execSessionUuid: null,
          },
        ]);
      });

      test("terminal entries are pruned after the retention window; open ones never are", async () => {
        const key = { scopeKey: await readyScope(), slotIndex: 0 };
        const other = { scopeKey: key.scopeKey, slotIndex: 1 };
        await boundSlot(key, "avd-1");
        await boundSlot(other, "avd-2");
        const entry = await openReplace(key);
        await registry.advanceSlotJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "rolled_back",
        });
        const open = await registry.openSlotJournal(other, {
          kind: "release",
          phase: "intent",
          owner: OWNER_1,
          target: TARGET,
          assignment: {
            kind: "state",
            expected: { generation: 1, stableDeviceId: "avd-2" },
            state: "cleanup_pending",
          },
        });
        expect(open.kind).toBe("opened");
        timer.advanceTime(SLOT_JOURNAL_TERMINAL_RETENTION_MS + 1);
        await registry.openSlotJournal(key, {
          kind: "release",
          phase: "intent",
          owner: OWNER_1,
          target: TARGET,
          assignment: { kind: "state", expected: BOUND, state: "cleanup_pending" },
        });
        expect(await registry.getSlotJournal(entry.id)).toBeNull();
        expect(await registry.listOpenSlotJournal(other)).toHaveLength(1);
      });
    });

    test("findScopes selects by namespace and incarnation, optionally by host", async () => {
      const a1 = await readyScope(SCOPE_A1);
      const otherHost = await readyScope({ ...SCOPE_A1, managedHostScope: "host-2" });
      await readyScope(SCOPE_B1);
      const query = { runnerNamespace: "runner-a", runnerIncarnation: "boot-1" };
      expect((await registry.findScopes(query)).map((scope) => scope.scopeKey).sort()).toEqual(
        [a1, otherHost].sort(),
      );
      expect(
        (await registry.findScopes({ ...query, managedHostScope: "host-1" })).map(
          (scope) => scope.scopeKey,
        ),
      ).toEqual([a1]);
      expect(await registry.findScopes({ ...query, runnerIncarnation: "boot-9" })).toEqual([]);
    });

    test("listAbandonedScopes lists abandoned scopes until they are revived or reset", async () => {
      const key = { scopeKey: await readyScope(), slotIndex: 0 };
      await boundSlot(key, "avd-1");
      expect(await registry.listAbandonedScopes()).toEqual([]);
      await abandon(key.scopeKey);
      expect((await registry.listAbandonedScopes()).map((scope) => scope.scopeKey)).toEqual([
        key.scopeKey,
      ]);
      await registry.ensureScope(SCOPE_A1);
      expect(await registry.listAbandonedScopes()).toEqual([]);
      await abandon(key.scopeKey);
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      expect(await registry.listAbandonedScopes()).toEqual([]);
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
