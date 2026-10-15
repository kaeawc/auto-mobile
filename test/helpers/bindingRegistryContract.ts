import {
  FREE_DEVICE_STOP_CLAIM_STALE_MS,
  type FreeDeviceStopClaim,
} from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BINDING_ABANDONED_SCOPE_THRESHOLD_MS,
  BINDING_JOURNAL_TERMINAL_RETENTION_MS,
  computeBindingScopeKey,
  type BindingExecOwner,
  type BindingExecOwnerLiveness,
  type BindingKey,
  type BindingRegistry,
  type BindingScopeIdentity,
} from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import { MANAGED_EXECUTION_SETTLEMENT_CAP_MS } from "../../src/daemon/sessionBroker/provisioning/executionRelease";
import { BindingScopeReset } from "../../src/daemon/sessionBroker/provisioning/scopeReset";
import { ManagedExecutionReowner } from "../../src/daemon/managedSlots/managedExecutionReowner";
import { FakeTimer } from "../fakes/FakeTimer";
import { IosSimCapacityGate } from "../../src/features/iosSimFleet/CapacityGate";
import { IosSimFleetCostCollector } from "../../src/features/iosSimFleet/FleetCostCollector";
import { InMemoryBootDurationHistory } from "../../src/features/iosSimFleet/BootDurationHistory";
import { FakeFleetHostSource } from "../fakes/FakeFleetHostSource";
import { RegistryBindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";

export type BindingRegistryFactory = (
  timer: FakeTimer,
  isExecOwnerLive: BindingExecOwnerLiveness,
) => Promise<BindingRegistry>;

const SCOPE_A1: BindingScopeIdentity = {
  managedHostScope: "host-1",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};
const SCOPE_A2: BindingScopeIdentity = { ...SCOPE_A1, runnerIncarnation: "boot-2" };
const SCOPE_B1: BindingScopeIdentity = { ...SCOPE_A1, runnerNamespace: "runner-b" };

const SPEC = { apiLevel: 35, deviceProfile: "pixel_8" };
const INIT = { role: "primary", platform: "android" as const, requestedSpec: SPEC };

function ownerFor(pid: number, sessionUuid: string): BindingExecOwner {
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
export function describeBindingRegistryContract(
  name: string,
  factory: BindingRegistryFactory,
): void {
  describe(`${name} binding registry contract`, () => {
    let timer: FakeTimer;
    let livePids: Set<number>;
    let registry: BindingRegistry;
    const reowners: ManagedExecutionReowner[] = [];

    beforeEach(async () => {
      timer = new FakeTimer();
      timer.setCurrentTime(1_000_000);
      livePids = new Set();
      registry = await factory(timer, (owner) => livePids.has(owner.pid));
    });

    afterEach(async () => {
      for (const reowner of reowners.splice(0)) {
        reowner.close();
        await reowner.whenIdle();
      }
      await registry.close();
    });

    async function readyScope(identity: BindingScopeIdentity = SCOPE_A1): Promise<string> {
      const result = await registry.ensureScope(identity);
      if (result.kind !== "ready") {
        throw new Error(`scope not ready: ${result.kind}`);
      }
      return result.scope.scopeKey;
    }

    async function boundSlot(key: BindingKey, stableDeviceId: string): Promise<void> {
      await registry.initBinding(key, INIT);
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
      expect(second.scope.scopeKey).toBe(computeBindingScopeKey(SCOPE_A1));
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
      expect((await registry.getScope(computeBindingScopeKey(SCOPE_B1)))?.state).toBe("valid");
    });

    test("an invalidated incarnation can never be revived or re-initialized", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(key.scopeKey);
      expect((await registry.ensureScope(SCOPE_A1)).kind).toBe("scope_invalidated");
      expect((await registry.initBinding(key, INIT)).kind).toBe("scope_not_valid");
    });

    test("concurrent initialization of one binding converges on a single generation-0 row", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      const results = await Promise.all([
        registry.initBinding(key, INIT),
        registry.initBinding(key, INIT),
        registry.initBinding(key, INIT),
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

    test("the same binding index in different scopes is a different binding", async () => {
      const a = { scopeKey: await readyScope(SCOPE_A1), bindingIndex: 0 };
      const b = { scopeKey: await readyScope(SCOPE_B1), bindingIndex: 0 };
      await boundSlot(a, "avd-a");
      await boundSlot(b, "avd-b");
      expect((await registry.getAssignment(a))?.stableDeviceId).toBe("avd-a");
      expect((await registry.getAssignment(b))?.stableDeviceId).toBe("avd-b");
    });

    test("commitBinding bumps the generation and records the resolved spec", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
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

    test("actual device metadata survives a ready-state update independently of the creation fingerprint", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      const resolvedSpec = {
        runtime: "system-images;android-35;google_apis;arm64-v8a",
        deviceType: "pixel_tablet",
        displayCutout: "none",
        configuration: { memoryMb: 3072, screenWidth: 800, screenHeight: 1280 },
      };
      const committed = await registry.commitBinding(
        key,
        { generation: 1, stableDeviceId: "avd-1" },
        {
          ...readyBinding("avd-1", 2),
          requestedSpec: { runtime: resolvedSpec.runtime },
          resolvedSpec,
          specFingerprint: "creation-default-fingerprint",
        },
      );
      expect(committed.kind).toBe("committed");
      const updated = await registry.updateBindingState(
        key,
        { generation: 2, stableDeviceId: "avd-1" },
        "ready",
      );
      expect(updated).toMatchObject({
        kind: "updated",
        assignment: {
          generation: 2,
          resolvedSpec,
          specFingerprint: "creation-default-fingerprint",
        },
      });
      expect(await registry.getAssignment(key)).toMatchObject({
        resolvedSpec,
        specFingerprint: "creation-default-fingerprint",
      });
    });

    test("a stale compare-and-set loses and reports the current binding", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await registry.initBinding(key, INIT);
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
      expect(await registry.isDeviceAssignedToValidBinding("android", "avd-1")).toBe(
        first.kind === "committed",
      );
    });

    test("one device can belong to at most one slot", async () => {
      const scopeKey = await readyScope();
      const a = { scopeKey, bindingIndex: 0 };
      const b = { scopeKey: await readyScope(SCOPE_B1), bindingIndex: 0 };
      await boundSlot(a, "avd-1");
      await registry.initBinding(b, INIT);
      const stolen = await registry.commitBinding(
        b,
        { generation: 0, stableDeviceId: null },
        readyBinding("avd-1", 1),
      );
      expect(stolen).toMatchObject({ kind: "device_assigned_elsewhere" });
      if (stolen.kind !== "device_assigned_elsewhere") {
        throw new Error("expected refusal");
      }
      expect(stolen.holder).toMatchObject({ scopeKey, bindingIndex: 0 });
      expect((await registry.getAssignment(b))?.generation).toBe(0);
    });

    test("the same stable id on another platform is a different device", async () => {
      const a = { scopeKey: await readyScope(), bindingIndex: 0 };
      const b = { scopeKey: a.scopeKey, bindingIndex: 1 };
      await boundSlot(a, "shared-id");
      await registry.initBinding(b, { ...INIT, platform: "ios" });
      const result = await registry.commitBinding(
        b,
        { generation: 0, stableDeviceId: null },
        readyBinding("shared-id", 1),
      );
      expect(result.kind).toBe("committed");
    });

    test("a binding moves to another platform only through an empty binding (#11232)", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "Pixel_8");
      await expect(
        registry.commitBinding(
          key,
          { generation: 1, stableDeviceId: "Pixel_8" },
          { ...readyBinding("UDID-1", 2), platform: "ios" },
        ),
      ).rejects.toThrow(/only with an empty binding/);

      const emptied = await registry.commitBinding(
        key,
        { generation: 1, stableDeviceId: "Pixel_8" },
        {
          platform: "ios",
          stableDeviceId: null,
          deviceName: null,
          resolvedSpec: null,
          specFingerprint: null,
          state: "provisioning",
        },
      );
      expect(emptied).toMatchObject({
        kind: "committed",
        assignment: { platform: "ios", generation: 2, stableDeviceId: null },
      });
      const bound = await registry.commitBinding(
        key,
        { generation: 2, stableDeviceId: null },
        readyBinding("UDID-1", 3),
      );
      expect(bound).toMatchObject({ kind: "committed", assignment: { platform: "ios" } });
      expect(await registry.findDeviceHolder("ios", "UDID-1")).toMatchObject({ kind: "binding" });
      expect(await registry.findDeviceHolder("android", "Pixel_8")).toBeNull();
    });

    test("updateSlotState CASes on the binding; a non-fencing change keeps the generation", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      const stale = await registry.updateBindingState(
        key,
        { generation: 0, stableDeviceId: null },
        "replacing",
      );
      expect(stale.kind).toBe("stale_binding");
      const updated = await registry.updateBindingState(
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
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      const before = { generation: 1, stableDeviceId: "avd-1" };
      const fenced = await registry.updateBindingState(key, before, "replacing");
      expect(fenced).toMatchObject({
        kind: "updated",
        assignment: { generation: 2, stableDeviceId: "avd-1", state: "replacing" },
      });

      // A reuse that read `ready` before the fence can no longer overwrite it, nor claim.
      expect((await registry.updateBindingState(key, before, "ready")).kind).toBe("stale_binding");
      expect((await registry.claimExecution(key, before, ownerFor(1, "s1"))).kind).toBe(
        "stale_binding",
      );
      expect((await registry.getAssignment(key))?.state).toBe("replacing");

      const pending = await registry.updateBindingState(
        key,
        { generation: 2, stableDeviceId: "avd-1" },
        "cleanup_pending",
      );
      expect(pending).toMatchObject({ kind: "updated", assignment: { generation: 3 } });
      // Re-entering the same fencing state is not a new fence.
      expect(
        await registry.updateBindingState(
          key,
          { generation: 3, stableDeviceId: "avd-1" },
          "cleanup_pending",
        ),
      ).toMatchObject({ kind: "updated", assignment: { generation: 3 } });
    });

    test("entering replacing is refused while a live execution owns the slot", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      livePids.add(100);
      await registry.claimExecution(key, binding, ownerFor(100, "s1"));

      expect(await registry.updateBindingState(key, binding, "replacing")).toMatchObject({
        kind: "binding_in_use",
        owner: { sessionUuid: "s1" },
      });
      expect(await registry.getAssignment(key)).toMatchObject({ generation: 1, state: "ready" });

      livePids.delete(100);
      expect((await registry.updateBindingState(key, binding, "replacing")).kind).toBe("updated");
    });

    test("settling records its settler, fences the slot, and clears the settler on leaving", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      await expect(registry.updateBindingState(key, binding, "settling")).rejects.toThrow(
        "settling daemon",
      );
      const settler = { daemonId: "daemon-a", pid: 300, processGenerationToken: "linux:b:1" };
      expect(
        await registry.updateBindingState(key, binding, "settling", { settler }),
      ).toMatchObject({
        kind: "updated",
        assignment: { generation: 2, state: "settling", settler },
      });
      expect(
        await registry.updateBindingState(key, { generation: 2, stableDeviceId: "avd-1" }, "ready"),
      ).toMatchObject({ kind: "updated", assignment: { generation: 2, settler: null } });
    });

    test("recoverSettledBindings returns only bindings whose settler is gone to ready", async () => {
      const scopeKey = await readyScope();
      const other = await readyScope(SCOPE_B1);
      const mine = { scopeKey, bindingIndex: 0 };
      const live = { scopeKey, bindingIndex: 1 };
      const elsewhere = { scopeKey: other, bindingIndex: 0 };
      await boundSlot(mine, "avd-1");
      await boundSlot(live, "avd-2");
      await boundSlot(elsewhere, "avd-3");
      livePids.add(301);
      for (const [key, id, pid] of [
        [mine, "avd-1", 300],
        [live, "avd-2", 301],
        [elsewhere, "avd-3", 300],
      ] as const) {
        await registry.updateBindingState(key, { generation: 1, stableDeviceId: id }, "settling", {
          settler: { daemonId: "d", pid },
        });
      }

      const recovered = await registry.recoverSettledBindings(scopeKey);

      expect(recovered.map((binding) => [binding.scopeKey, binding.bindingIndex])).toEqual([
        [scopeKey, 0],
      ]);
      expect(await registry.getAssignment(mine)).toMatchObject({
        generation: 2,
        state: "ready",
        settler: null,
      });
      expect((await registry.getAssignment(live))?.state).toBe("settling");
      expect((await registry.getAssignment(elsewhere))?.state).toBe("settling");
      expect((await registry.recoverSettledBindings()).map((binding) => binding.scopeKey)).toEqual([
        other,
      ]);
    });

    test("a binding settling under a dead settler does not block scope invalidation; a live one does", async () => {
      const scopeKey = await readyScope();
      const key = { scopeKey, bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      livePids.add(300);
      await registry.updateBindingState(
        key,
        { generation: 1, stableDeviceId: "avd-1" },
        "settling",
        {
          settler: { daemonId: "d", pid: 300 },
        },
      );
      timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS);
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
      expect(pending.settling.map((binding) => binding.bindingIndex)).toEqual([0]);

      livePids.delete(300);
      expect(await registry.completeScopeInvalidation(scopeKey)).toMatchObject({
        kind: "invalidated",
        freedDevices: [{ stableDeviceId: "avd-1" }],
      });
    });

    // #11336: `reset-slot-scope --force` abandons a slot stuck settling under a live settler.
    describe("forced scope reset of a stuck settling slot", () => {
      const settler = { daemonId: "d", pid: 300 };
      const releaseTarget = {
        oldStableId: "avd-1",
        oldName: "avd-1",
        newName: null,
        newStableId: null,
        requestedSpec: SPEC,
        resolvedSpec: SPEC,
        specFingerprint: "fp-avd-1",
      };

      async function stuckSettling(): Promise<{ scopeKey: string }> {
        const scopeKey = await readyScope();
        const key = { scopeKey, bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        livePids.add(300);
        const expected = { generation: 1, stableDeviceId: "avd-1" };
        const opened = await registry.openBindingJournal(key, {
          kind: "release",
          phase: "intent",
          owner: settler,
          target: releaseTarget,
          assignment: { kind: "state", expected, state: "settling", options: { settler } },
        });
        expect(opened.kind).toBe("opened");
        return { scopeKey };
      }

      function resetter(): BindingScopeReset {
        timer.enableAutoAdvance();
        return new BindingScopeReset({
          registry: async () => registry,
          timer,
          isExecOwnerLive: (owner) => livePids.has(owner.pid),
        });
      }

      test("commits the release entry, invalidates and frees the device; without --force it stays pending", async () => {
        const { scopeKey } = await stuckSettling();
        const request = { ...SCOPE_A1, waitMs: 0 };
        const reset = resetter();

        expect((await reset.reset(request)).outcome).toBe("pending");
        expect((await registry.getAssignment({ scopeKey, bindingIndex: 0 }))?.state).toBe(
          "settling",
        );

        // Inside the settlement cap --force is refused with the time remaining (#11539).
        const early = await reset.reset({ ...request, force: true });
        expect(early.outcome).toBe("pending");
        expect(early.scopes[0]?.forceRefusals?.[0]?.reason).toBe("within_settlement_cap");
        expect(await registry.listFreeDevices()).toEqual([]);

        timer.setCurrentTime(timer.now() + MANAGED_EXECUTION_SETTLEMENT_CAP_MS);
        const forced = await reset.reset({ ...request, force: true });

        expect(forced).toMatchObject({
          outcome: "invalidated",
          scopes: [{ freedDevices: [{ stableDeviceId: "avd-1" }] }],
        });
        expect(await registry.listOpenBindingJournal()).toEqual([]);
        expect((await registry.listFreeDevices()).map((d) => d.stableDeviceId)).toEqual(["avd-1"]);
      });

      test("a binding with a live execution owner is still pending under --force", async () => {
        const scopeKey = await readyScope();
        const key = { scopeKey, bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        livePids.add(100);
        await registry.claimExecution(
          key,
          { generation: 1, stableDeviceId: "avd-1" },
          ownerFor(100, "s1"),
        );

        const result = await resetter().reset({ ...SCOPE_A1, waitMs: 0, force: true });

        expect(result.outcome).toBe("pending");
        expect(result.scopes[0]?.pending?.liveOwners).toEqual([
          { bindingIndex: 0, sessionUuid: "s1", pid: 100 },
        ]);
        expect((await registry.getAssignment(key))?.execOwner?.sessionUuid).toBe("s1");
      });
    });

    test("a claim may supersede only the reservation it names", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      livePids.add(100);
      await registry.claimExecution(key, binding, ownerFor(100, "reserve-1"));

      expect(
        await registry.claimExecution(key, binding, ownerFor(100, "s1"), {
          supersedesSessionUuid: "reserve-other",
        }),
      ).toMatchObject({ kind: "binding_in_use", owner: { sessionUuid: "reserve-1" } });
      expect(
        await registry.claimExecution(key, binding, ownerFor(100, "s1"), {
          supersedesSessionUuid: "reserve-1",
        }),
      ).toMatchObject({ kind: "claimed", assignment: { execOwner: { sessionUuid: "s1" } } });
    });

    test("mutations on a missing binding or an invalidating scope are refused", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      const missing = await registry.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        readyBinding("avd-1", 1),
      );
      expect(missing.kind).toBe("binding_missing");
      await registry.initBinding(key, INIT);
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      const blocked = await registry.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        readyBinding("avd-1", 1),
      );
      expect(blocked.kind).toBe("scope_not_valid");
    });

    test("execution ownership: claim, live duplicate refused, dead owner taken over, release keeps the binding", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      livePids.add(100);
      expect((await registry.claimExecution(key, binding, ownerFor(100, "s1"))).kind).toBe(
        "claimed",
      );
      expect(await registry.claimExecution(key, binding, ownerFor(200, "s2"))).toMatchObject({
        kind: "binding_in_use",
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
      expect(await registry.isDeviceAssignedToValidBinding("android", "avd-1")).toBe(true);
    });

    test("the owner's process-generation token round-trips and is cleared on release", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
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

    test("findExecutionAssignments resolves the bindings a session holds, and none once released", async () => {
      const scopeKey = await readyScope();
      const first = { scopeKey, bindingIndex: 0 };
      const second = { scopeKey, bindingIndex: 1 };
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
      expect(held.map((assignment) => assignment.bindingIndex)).toEqual([0, 1]);
      expect(await registry.findExecutionAssignments("s2")).toEqual([]);

      await registry.releaseExecution(first, "s1");
      expect((await registry.findExecutionAssignments("s1")).map((a) => a.bindingIndex)).toEqual([
        1,
      ]);
      // The binding survives the release.
      expect(await registry.getAssignment(first)).toMatchObject({
        stableDeviceId: "avd-1",
        execOwner: null,
      });
    });

    test("an execution cannot claim a binding that is not ready", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await registry.initBinding(key, INIT);
      const result = await registry.claimExecution(
        key,
        { generation: 0, stableDeviceId: null },
        ownerFor(1, "s1"),
      );
      expect(result.kind).toBe("binding_not_ready");
    });

    test("binding a different device drops the previous device's execution owner", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
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
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      expect(await registry.findDeviceHolder("android", "avd-1")).toMatchObject({
        kind: "binding",
        scope: { state: "valid" },
        assignment: { bindingIndex: 0 },
      });
      expect(await registry.findDeviceHolder("android", "unknown")).toBeNull();

      await registry.beginScopeInvalidation(key.scopeKey, "incarnation_reset");
      expect(await registry.isDeviceAssignedToValidBinding("android", "avd-1")).toBe(false);
      expect(await registry.snapshotManagedDevices()).toEqual([
        {
          platform: "android",
          stableDeviceId: "avd-1",
          holder: "binding",
          scopeKey: key.scopeKey,
          bindingIndex: 0,
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
          bindingIndex: null,
          scopeState: null,
          execSessionUuid: null,
        },
      ]);
    });

    test("scope invalidation is idempotent and waits for live owners and pending cleanup", async () => {
      const scopeKey = await readyScope();
      const owned = { scopeKey, bindingIndex: 0 };
      const cleaning = { scopeKey, bindingIndex: 1 };
      await boundSlot(owned, "avd-1");
      await boundSlot(cleaning, "avd-2");
      livePids.add(100);
      await registry.claimExecution(
        owned,
        { generation: 1, stableDeviceId: "avd-1" },
        ownerFor(100, "s1"),
      );
      await registry.updateBindingState(
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
      expect(pending.liveOwners.map((binding) => binding.bindingIndex)).toEqual([0]);
      expect(pending.cleanupPending.map((binding) => binding.bindingIndex)).toEqual([1]);
      expect(await registry.listAssignments(scopeKey)).toHaveLength(2);
      expect((await registry.getScope(scopeKey))?.invalidationReason).toBe("incarnation_reset");
    });

    test("completing invalidation frees bound devices for managed adoption only", async () => {
      const oldKey = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(oldKey, "avd-1");
      await registry.initBinding({ scopeKey: oldKey.scopeKey, bindingIndex: 1 }, INIT);
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

      const newKey = { scopeKey: await readyScope(SCOPE_A2), bindingIndex: 0 };
      await registry.initBinding(newKey, INIT);
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
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      await readyScope(SCOPE_B1);

      timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS - 1);
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
      timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS);
      expect((await registry.markScopeAbandoned(scopeKey)).kind).toBe("marked");
    }

    test("an abandoned scope revives when the same incarnation returns, keeping its bindings", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      await abandon(key.scopeKey);
      expect(await registry.isDeviceAssignedToValidBinding("android", "avd-1")).toBe(false);

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
      expect(await registry.isDeviceAssignedToValidBinding("android", "avd-1")).toBe(true);
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
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
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
          holder: "binding",
          bindingIndex: 0,
          scopeState: "invalidated",
        }),
      ]);
      const other = { scopeKey: await readyScope(SCOPE_B1), bindingIndex: 0 };
      await registry.initBinding(other, INIT);
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
      expect(await registry.isDeviceAssignedToValidBinding("android", "avd-1")).toBe(true);
    });

    test("the abandonment clock runs from the last execution release, not the acquisition", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      const binding = { generation: 1, stableDeviceId: "avd-1" };
      livePids.add(100);
      await registry.claimExecution(key, binding, ownerFor(100, "s1"));
      // A 50-minute execution ends.
      timer.advanceTime(50 * 60 * 1000);
      await registry.releaseExecution(key, "s1");
      livePids.delete(100);
      expect((await registry.getScope(key.scopeKey))?.lastReleasedAtMs).toBe(timer.now());

      timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS - 1);
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
      const kept = { scopeKey: invalidated, bindingIndex: 0 };
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
      await boundSlot({ scopeKey: oldKey, bindingIndex: 0 }, "avd-old");
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
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(key.scopeKey);
      expect(await registry.findReclaimableFreeDevices()).toEqual([]);
      timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS);
      expect(
        (await registry.findReclaimableFreeDevices()).map((device) => device.stableDeviceId),
      ).toEqual(["avd-1"]);
      expect(
        await registry.findReclaimableFreeDevices({ thresholdMs: 2 * 60 * 60 * 1000 }),
      ).toEqual([]);
    });

    describe("free-pool stop state (#11337)", () => {
      async function dueFreeDevice(): Promise<{
        target: FreeDeviceStopClaim;
        key: BindingKey;
      }> {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
        await registry.completeScopeInvalidation(key.scopeKey);
        const [freed] = await registry.listFreeDevices();
        timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS);
        return {
          target: {
            platform: "android",
            stableDeviceId: "avd-1",
            freedAtMs: freed!.freedAtMs,
            fromScopeKey: key.scopeKey,
            claimedBy: "daemon-1",
          },
          key,
        };
      }

      test("a due device goes free to stopping to stopped and keeps its row", async () => {
        const { target } = await dueFreeDevice();
        expect((await registry.listFreeDevices())[0]).toMatchObject({ state: "free" });

        expect(await registry.beginFreeDeviceStop(target)).toEqual({ kind: "begun" });
        expect((await registry.listFreeDevices())[0]).toMatchObject({ state: "stopping" });
        // An interrupted attempt is retried: still reclaimable, and begin is idempotent.
        expect(await registry.findReclaimableFreeDevices()).toHaveLength(1);
        expect(await registry.beginFreeDeviceStop(target)).toEqual({ kind: "begun" });

        expect(await registry.completeFreeDeviceStop(target)).toBe(true);
        expect((await registry.listFreeDevices())[0]).toMatchObject({ state: "stopped" });
        expect(await registry.findReclaimableFreeDevices()).toEqual([]);
        expect(await registry.beginFreeDeviceStop(target)).toEqual({ kind: "not_reclaimable" });
        // Still excluded from generic use while stopped.
        expect(await registry.snapshotManagedDevices()).toMatchObject([
          { stableDeviceId: "avd-1", holder: "free" },
        ]);
      });

      test("a stopping row is owned: only the claimer drives it until the claim is stale", async () => {
        const { target } = await dueFreeDevice();
        const other = { ...target, claimedBy: "daemon-2" };
        await registry.beginFreeDeviceStop(target);

        expect(await registry.holdsFreeDeviceStop(target)).toBe(true);
        expect(await registry.holdsFreeDeviceStop(other)).toBe(false);
        expect(await registry.beginFreeDeviceStop(other)).toEqual({ kind: "not_reclaimable" });
        expect(await registry.completeFreeDeviceStop(other)).toBe(false);
        expect(await registry.revertFreeDeviceStop(other)).toBe(false);
        expect((await registry.listFreeDevices())[0]).toMatchObject({
          state: "stopping",
          stopClaimedBy: "daemon-1",
        });

        // The claimer died: past the stale bound another daemon takes the stop over.
        timer.advanceTime(FREE_DEVICE_STOP_CLAIM_STALE_MS);
        expect(await registry.beginFreeDeviceStop(other)).toEqual({ kind: "begun" });
        expect(await registry.holdsFreeDeviceStop(target)).toBe(false);
        expect(await registry.completeFreeDeviceStop(target)).toBe(false);
        expect(await registry.completeFreeDeviceStop(other)).toBe(true);
      });

      test("a failed shutdown reverts to free so the device is adoptable again", async () => {
        const { target } = await dueFreeDevice();
        await registry.beginFreeDeviceStop(target);

        expect(await registry.revertFreeDeviceStop(target)).toBe(true);
        expect((await registry.listFreeDevices())[0]).toMatchObject({
          state: "free",
          stopClaimedBy: null,
          stopClaimedAtMs: null,
          deletion: null,
        });
        expect(await registry.findReclaimableFreeDevices()).toHaveLength(1);

        const binding = { scopeKey: await readyScope(SCOPE_B1), bindingIndex: 0 };
        await registry.initBinding(binding, INIT);
        const adopted = await registry.commitBinding(
          binding,
          { generation: 0, stableDeviceId: null },
          readyBinding("avd-1", 1),
        );
        expect(adopted).toMatchObject({ kind: "committed" });
      });

      test("a stale stopping claim no longer blocks adoption", async () => {
        const { target } = await dueFreeDevice();
        await registry.beginFreeDeviceStop(target);
        timer.advanceTime(FREE_DEVICE_STOP_CLAIM_STALE_MS);
        const binding = { scopeKey: await readyScope(SCOPE_B1), bindingIndex: 0 };
        await registry.initBinding(binding, INIT);

        const adopted = await registry.commitBinding(
          binding,
          { generation: 0, stableDeviceId: null },
          readyBinding("avd-1", 1),
        );

        expect(adopted).toMatchObject({ kind: "committed" });
        expect(await registry.holdsFreeDeviceStop(target)).toBe(false);
      });

      test("a device that is not yet due is not claimed", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
        await registry.completeScopeInvalidation(key.scopeKey);
        const [freed] = await registry.listFreeDevices();
        timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS - 1);
        expect(
          await registry.beginFreeDeviceStop({
            platform: "android",
            stableDeviceId: "avd-1",
            freedAtMs: freed!.freedAtMs,
            fromScopeKey: key.scopeKey,
            claimedBy: "daemon-1",
          }),
        ).toEqual({ kind: "not_reclaimable" });
      });

      test("an adoption that wins the race keeps the device and fails the stop CAS", async () => {
        const { target } = await dueFreeDevice();
        const binding = { scopeKey: await readyScope(SCOPE_B1), bindingIndex: 0 };
        await registry.initBinding(binding, INIT);
        const adopted = await registry.commitBinding(
          binding,
          { generation: 0, stableDeviceId: null },
          readyBinding("avd-1", 1),
        );
        expect(adopted).toMatchObject({ kind: "committed" });

        expect(await registry.beginFreeDeviceStop(target)).toEqual({ kind: "not_reclaimable" });
        expect(await registry.completeFreeDeviceStop(target)).toBe(false);
        expect(await registry.listFreeDevices()).toEqual([]);
      });

      test("adoption is refused while stopping and succeeds once stopped", async () => {
        const { target } = await dueFreeDevice();
        const binding = { scopeKey: await readyScope(SCOPE_B1), bindingIndex: 0 };
        await registry.initBinding(binding, INIT);
        await registry.beginFreeDeviceStop(target);

        expect(
          await registry.commitBinding(
            binding,
            { generation: 0, stableDeviceId: null },
            readyBinding("avd-1", 1),
          ),
        ).toEqual({ kind: "free_device_stopping" });
        expect(await registry.listFreeDevices()).toHaveLength(1);

        await registry.completeFreeDeviceStop(target);
        const adopted = await registry.commitBinding(
          binding,
          { generation: 0, stableDeviceId: null },
          readyBinding("avd-1", 1),
        );
        expect(adopted).toMatchObject({
          kind: "committed",
          adoptedFreeDevice: { stableDeviceId: "avd-1", state: "stopped" },
        });
        expect(await registry.listFreeDevices()).toEqual([]);
      });
    });

    describe("daemon restart (#11275)", () => {
      const BEFORE_RESTART = { daemonId: "daemon-before", pid: 301, processGenerationToken: "t-1" };
      const AFTER_RESTART = { daemonId: "daemon-after", pid: 302, processGenerationToken: "t-2" };

      // Daemon 301 claims the slot for the live session, then restarts as 302: the session is
      // rehydrated and its proxy re-binds, but the registry still names the dead 301.
      async function liveExecutionAcrossRestart(): Promise<BindingKey> {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const assignment = await registry.getAssignment(key);
        livePids.add(BEFORE_RESTART.pid);
        expect(
          (
            await registry.claimExecution(
              key,
              { generation: assignment!.generation, stableDeviceId: "avd-1" },
              { ...BEFORE_RESTART, sessionUuid: "live-session" },
            )
          ).kind,
        ).toBe("claimed");
        livePids.delete(BEFORE_RESTART.pid);
        livePids.add(AFTER_RESTART.pid);
        return key;
      }

      function reowner(): ManagedExecutionReowner {
        const instance = new ManagedExecutionReowner({
          registry: async () => registry,
          owner: () => AFTER_RESTART,
        });
        reowners.push(instance);
        return instance;
      }

      test("the restarted daemon re-owns the live execution, so a duplicate claim is binding_in_use", async () => {
        const key = await liveExecutionAcrossRestart();

        const reowned = await reowner().reown(["live-session"]);

        expect(reowned.map((binding) => binding.execOwner)).toEqual([
          { ...AFTER_RESTART, sessionUuid: "live-session" },
        ]);
        const assignment = await registry.getAssignment(key);
        const duplicate = await registry.claimExecution(
          key,
          { generation: assignment!.generation, stableDeviceId: "avd-1" },
          { ...AFTER_RESTART, sessionUuid: "reserve-duplicate" },
        );
        expect(duplicate).toMatchObject({
          kind: "binding_in_use",
          owner: { sessionUuid: "live-session", pid: AFTER_RESTART.pid },
        });
        // The binding is untouched: re-owning is not a binding change.
        expect(assignment).toMatchObject({ generation: 1, stableDeviceId: "avd-1" });
      });

      test("a re-owned execution keeps its scope from being abandoned past the threshold", async () => {
        const key = await liveExecutionAcrossRestart();
        await reowner().reown(["live-session"]);

        timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS + 60_000);

        expect(await registry.findAbandonedScopes()).toEqual([]);
        expect(await registry.markScopeAbandoned(key.scopeKey)).toMatchObject({
          kind: "not_abandoned",
          reason: "live_owner",
        });
      });

      test("re-owning is idempotent and never takes a binding another execution holds", async () => {
        const key = await liveExecutionAcrossRestart();
        expect(await reowner().reown(["live-session"])).toHaveLength(1);
        expect(await reowner().reown(["live-session"])).toEqual([]);
        expect(await reowner().reown(["some-other-session"])).toEqual([]);
        expect((await registry.getAssignment(key))?.execOwner).toEqual({
          ...AFTER_RESTART,
          sessionUuid: "live-session",
        });
      });

      // #11642: the runner's next incarnation asked while the execution was live, so the scope is
      // already `invalidating` when the daemon restarts.
      describe("while the scope is invalidating (#11642)", () => {
        const BINDING = { generation: 1, stableDeviceId: "avd-1" };

        async function invalidatingAcrossRestart(): Promise<BindingKey> {
          const key = await liveExecutionAcrossRestart();
          expect((await registry.ensureScope(SCOPE_A2)).kind).toBe("incarnation_conflict");
          expect(
            (await registry.beginScopeInvalidation(key.scopeKey, "incarnation_reset")).kind,
          ).toBe("invalidating");
          return key;
        }

        test("the restarted daemon re-owns its live execution and the transition waits for it", async () => {
          const key = await invalidatingAcrossRestart();
          // Unowned, the record names a dead process: any daemon would retire the scope.
          const reowned = await reowner().reown(["live-session"]);

          expect(reowned.map((binding) => binding.execOwner)).toEqual([
            { ...AFTER_RESTART, sessionUuid: "live-session" },
          ]);
          expect(await registry.completeScopeInvalidation(key.scopeKey)).toMatchObject({
            kind: "pending",
            liveOwners: [{ execOwner: { pid: AFTER_RESTART.pid, sessionUuid: "live-session" } }],
          });
          // Re-owning neither revives the scope nor touches the binding.
          expect(await registry.getScope(key.scopeKey)).toMatchObject({
            state: "invalidating",
            invalidationReason: "incarnation_reset",
          });
          expect(await registry.getAssignment(key)).toMatchObject({ ...BINDING, state: "ready" });
        });

        test("the transition completes once the re-owned execution ends, and the next incarnation proceeds", async () => {
          const key = await invalidatingAcrossRestart();
          await reowner().reown(["live-session"]);

          expect((await registry.releaseExecution(key, "live-session")).released).toBe(true);

          expect(await registry.completeScopeInvalidation(key.scopeKey)).toMatchObject({
            kind: "invalidated",
            freedDevices: [{ stableDeviceId: "avd-1" }],
          });
          expect(await registry.ensureScope(SCOPE_A2)).toMatchObject({ kind: "ready" });
          // Nothing is left to re-own in the retired scope.
          expect(await reowner().reown(["live-session"])).toEqual([]);
        });

        test("no other session, reservation or superseding claim gets into the invalidating scope", async () => {
          const key = await invalidatingAcrossRestart();
          const other = { ...AFTER_RESTART, sessionUuid: "other-session" };

          // The recorded owner's process is dead: in a valid scope each of these would be claimed.
          expect((await registry.claimExecution(key, BINDING, other)).kind).toBe("scope_not_valid");
          expect(
            (
              await registry.claimExecution(key, BINDING, other, {
                supersedesSessionUuid: "live-session",
              })
            ).kind,
          ).toBe("scope_not_valid");
          expect(
            (
              await registry.claimExecution(
                key,
                BINDING,
                { ...AFTER_RESTART, sessionUuid: "reserve-next" },
                { supersedesSessionUuid: "live-session" },
              )
            ).kind,
          ).toBe("scope_not_valid");
          expect((await registry.getAssignment(key))?.execOwner).toEqual({
            ...BEFORE_RESTART,
            sessionUuid: "live-session",
          });

          // The same session with a stale binding is still a stale binding.
          expect(
            (
              await registry.claimExecution(
                key,
                { generation: 2, stableDeviceId: "avd-1" },
                { ...AFTER_RESTART, sessionUuid: "live-session" },
              )
            ).kind,
          ).toBe("stale_binding");
        });

        test("an ownerless binding of an invalidating scope cannot be claimed, even by its last session", async () => {
          const key = await invalidatingAcrossRestart();
          await registry.releaseExecution(key, "live-session");

          expect(
            (
              await registry.claimExecution(key, BINDING, {
                ...AFTER_RESTART,
                sessionUuid: "live-session",
              })
            ).kind,
          ).toBe("scope_not_valid");
          expect(await reowner().reown(["live-session"])).toEqual([]);
        });

        test("an invalidated scope accepts no claim, the recorded session's included", async () => {
          const key = await liveExecutionAcrossRestart();
          timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS + 60_000);
          // No daemon holds the session and its process is dead: the scope is abandoned through.
          expect((await registry.markScopeAbandoned(key.scopeKey)).kind).toBe("marked");
          expect((await registry.completeScopeInvalidation(key.scopeKey)).kind).toBe("invalidated");

          expect(await reowner().reown(["live-session"])).toEqual([]);
          expect((await registry.getAssignment(key))?.execOwner).toEqual({
            ...BEFORE_RESTART,
            sessionUuid: "live-session",
          });
        });

        test("a scope marked abandoned before the re-own is not retired under the live session", async () => {
          const key = await liveExecutionAcrossRestart();
          timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS + 60_000);
          // A peer daemon judged the record by its dead process and marked the scope.
          expect((await registry.markScopeAbandoned(key.scopeKey)).kind).toBe("marked");

          expect(await reowner().reown(["live-session"])).toHaveLength(1);

          expect((await registry.completeScopeInvalidation(key.scopeKey)).kind).toBe("pending");
        });
      });
    });

    describe("binding journal (#11179)", () => {
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

      test("an abandoned-scope delete opens and fences atomically", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        await abandon(key.scopeKey);
        const opened = await registry.openBindingJournal(key, {
          kind: "replace",
          phase: "deleting",
          owner: OWNER_1,
          target: TARGET,
          requireAbandonedScope: true,
          assignment: { kind: "state", expected: BOUND, state: "replacing" },
        });
        expect(opened).toMatchObject({
          kind: "opened",
          assignment: { state: "replacing", generation: 2 },
        });
      });

      for (const revived of [true, false]) {
        test(`an abandoned-scope delete refuses a ${revived ? "revived" : "never-abandoned"} scope without writes`, async () => {
          const key = { scopeKey: await readyScope(), bindingIndex: 0 };
          await boundSlot(key, "avd-1");
          if (revived) {
            await abandon(key.scopeKey);
            expect(await registry.ensureScope(SCOPE_A1)).toMatchObject({ revived: true });
          }
          const before = await registry.getAssignment(key);
          const scope = await registry.getScope(key.scopeKey);
          const refused = await registry.openBindingJournal(key, {
            kind: "replace",
            phase: "deleting",
            owner: OWNER_1,
            target: TARGET,
            requireAbandonedScope: true,
            assignment: { kind: "state", expected: BOUND, state: "replacing" },
          });
          expect(refused).toEqual({ kind: "scope_not_abandoned", scope });
          expect(await registry.listOpenBindingJournal(key)).toEqual([]);
          expect(await registry.getBindingJournal(1)).toBeNull();
          expect(await registry.getAssignment(key)).toEqual(before);
        });
      }

      test("without the abandonment precondition a valid scope still opens a delete", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        expect(entry.phase).toBe("deleting");
        expect(await registry.getAssignment(key)).toMatchObject({
          state: "replacing",
          generation: 2,
        });
      });

      for (const reset of [true, false]) {
        test(`an abandoned-scope delete refuses a ${reset ? "reset" : "missing"} scope before changing assignments`, async () => {
          const key = { scopeKey: reset ? await readyScope() : "missing-scope", bindingIndex: 0 };
          if (reset) {
            await boundSlot(key, "avd-1");
            await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
          }
          const before = await registry.getAssignment(key);
          expect(
            await registry.openBindingJournal(key, {
              kind: "replace",
              phase: "deleting",
              owner: OWNER_1,
              target: TARGET,
              requireAbandonedScope: true,
              assignment: { kind: "state", expected: BOUND, state: "replacing" },
            }),
          ).toEqual({ kind: "scope_not_abandoned", scope: await registry.getScope(key.scopeKey) });
          expect(await registry.getAssignment(key)).toEqual(before);
          expect(await registry.listOpenBindingJournal(key)).toEqual([]);
          expect(await registry.getBindingJournal(1)).toBeNull();
        });
      }

      test("existing open work takes precedence over the abandonment precondition", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        const before = await registry.getAssignment(key);
        expect(
          await registry.openBindingJournal(key, {
            kind: "replace",
            phase: "deleting",
            owner: OWNER_2,
            target: TARGET,
            requireAbandonedScope: true,
            assignment: { kind: "state", expected: BOUND, state: "replacing" },
          }),
        ).toEqual({ kind: "journal_open", entry });
        expect(await registry.getAssignment(key)).toEqual(before);
        expect(await registry.listOpenBindingJournal(key)).toEqual([entry]);
      });

      async function openReplace(key: BindingKey) {
        const opened = await registry.openBindingJournal(key, {
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
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
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
        expect(await registry.listOpenBindingJournal(key)).toEqual([entry]);
        const second = await registry.openBindingJournal(key, {
          kind: "release",
          phase: "intent",
          owner: OWNER_2,
          target: TARGET,
          assignment: { kind: "state", expected: BOUND, state: "cleanup_pending" },
        });
        expect(second).toMatchObject({ kind: "journal_open", entry: { id: entry.id } });
        expect((await registry.getAssignment(key))?.state).toBe("replacing");
      });

      test("a cross-platform target's newPlatform survives the store and a later advance (#11457)", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const opened = await registry.openBindingJournal(key, {
          kind: "replace",
          phase: "deleting",
          owner: OWNER_1,
          target: { ...TARGET, newPlatform: "ios" },
          assignment: { kind: "state", expected: BOUND, state: "replacing" },
        });
        if (opened.kind !== "opened") {
          throw new Error(`journal not opened: ${opened.kind}`);
        }
        expect(opened.entry.target.newPlatform).toBe("ios");
        const [reread] = await registry.listOpenBindingJournal(key);
        expect(reread?.target).toEqual({ ...TARGET, newPlatform: "ios" });
        const advanced = await registry.advanceBindingJournal(opened.entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "deleted",
          target: { newName: "amslot-new-g2" },
        });
        expect(advanced).toMatchObject({
          kind: "advanced",
          entry: { target: { newPlatform: "ios", newName: "amslot-new-g2" } },
        });
        const [afterAdvance] = await registry.listOpenBindingJournal(key);
        expect(afterAdvance?.target.newPlatform).toBe("ios");
      });

      test("removal intent survives a journal target round-trip and later advance", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const opened = await registry.openBindingJournal(key, {
          kind: "replace",
          phase: "creating",
          owner: OWNER_1,
          target: { ...TARGET, removalRequested: true },
          assignment: { kind: "state", expected: BOUND, state: "provisioning" },
        });
        if (opened.kind !== "opened") {
          throw new Error(`journal not opened: ${opened.kind}`);
        }
        expect((await registry.listOpenBindingJournal(key))[0]?.target.removalRequested).toBe(true);
        expect(
          await registry.advanceBindingJournal(opened.entry.id, {
            owner: OWNER_1,
            expectedPhase: "creating",
            phase: "created",
            target: { newStableId: "new" },
          }),
        ).toMatchObject({ kind: "advanced", entry: { target: { removalRequested: true } } });
        expect((await registry.listOpenBindingJournal(key))[0]?.target.removalRequested).toBe(true);
      });

      test("a stale binding refuses to open and writes nothing", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const refused = await registry.openBindingJournal(key, {
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
        expect(await registry.listOpenBindingJournal()).toEqual([]);
        expect((await registry.getAssignment(key))?.state).toBe("ready");
      });

      test("advancing commits the binding and the phase together and tracks the new binding", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        const deleted = await registry.advanceBindingJournal(entry.id, {
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

        const creating = await registry.advanceBindingJournal(entry.id, {
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
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        // Someone else rebinds the slot underneath the entry.
        await registry.commitBinding(key, FENCED, readyBinding("avd-9", 3));

        const stale = await registry.advanceBindingJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "deleting",
          assignment: { kind: "state", expected: FENCED, state: "cleanup_pending" },
        });
        expect(stale.kind).toBe("stale_binding");
        expect(await registry.getBindingJournal(entry.id)).toEqual(entry);

        const wrongBinding = await registry.advanceBindingJournal(entry.id, {
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
            await registry.advanceBindingJournal(entry.id, {
              owner: OWNER_2,
              expectedPhase: "deleting",
              phase: "rolled_back",
            })
          ).kind,
        ).toBe("journal_conflict");
        expect(
          (
            await registry.advanceBindingJournal(entry.id, {
              owner: OWNER_1,
              expectedPhase: "creating",
              phase: "rolled_back",
            })
          ).kind,
        ).toBe("journal_conflict");
      });

      test("attempts record backoff; terminal entries free the binding for a new entry", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        const failed = await registry.advanceBindingJournal(entry.id, {
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
        await registry.advanceBindingJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "rolled_back",
        });
        expect(await registry.listOpenBindingJournal()).toEqual([]);
        expect(
          (
            await registry.advanceBindingJournal(entry.id, {
              owner: OWNER_1,
              expectedPhase: "rolled_back",
              phase: "committed",
            })
          ).kind,
        ).toBe("journal_conflict");
        const reopened = await registry.openBindingJournal(key, {
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
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        expect(await registry.claimBindingJournal(entry.id, OWNER_2, OWNER_2)).toMatchObject({
          kind: "journal_conflict",
        });
        expect(await registry.claimBindingJournal(entry.id, OWNER_1, OWNER_2)).toMatchObject({
          kind: "claimed",
          entry: { owner: OWNER_2 },
        });
        expect(await registry.claimBindingJournal(entry.id, OWNER_1, OWNER_1)).toMatchObject({
          kind: "journal_conflict",
        });
        expect(
          (
            await registry.advanceBindingJournal(entry.id, {
              owner: OWNER_1,
              expectedPhase: "deleting",
              phase: "rolled_back",
            })
          ).kind,
        ).toBe("journal_conflict");
      });

      test("open work blocks scope invalidation but may settle while the scope is invalidating", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await boundSlot(key, "avd-1");
        const entry = await openReplace(key);
        await registry.beginScopeInvalidation(key.scopeKey, "incarnation_reset");
        const pending = await registry.completeScopeInvalidation(key.scopeKey);
        expect(pending).toMatchObject({ kind: "pending", openJournal: [{ id: entry.id }] });

        const settled = await registry.advanceBindingJournal(entry.id, {
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
        await registry.advanceBindingJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleted",
          phase: "committed",
        });
        expect((await registry.completeScopeInvalidation(key.scopeKey)).kind).toBe("invalidated");
        // Non-journaled mutations still need a valid scope.
        expect(
          (await registry.updateBindingState(key, { generation: 3, stableDeviceId: null }, "ready"))
            .kind,
        ).toBe("scope_not_valid");
      });

      test("a device an open entry is creating is excluded from generic allocation", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        await registry.initBinding(key, INIT);
        const opened = await registry.openBindingJournal(key, {
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
            holder: "binding",
            scopeKey: key.scopeKey,
            bindingIndex: 0,
            scopeState: null,
            execSessionUuid: null,
          },
        ]);
      });

      test("iOS creation excludes the exact journal name until its UDID is recorded", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        const name = "amslot-12345678-0-g1-attempt";
        await registry.initBinding(key, { ...INIT, platform: "ios" });
        const opened = await registry.openBindingJournal(key, {
          kind: "create",
          phase: "creating",
          owner: OWNER_1,
          target: { ...TARGET, oldStableId: null, oldName: null, newName: name },
          assignment: {
            kind: "state",
            expected: { generation: 0, stableDeviceId: null },
            state: "provisioning",
          },
        });
        if (opened.kind !== "opened") {
          throw new Error(`journal not opened: ${opened.kind}`);
        }
        const entry = {
          platform: "ios",
          stableDeviceId: name,
          holder: "binding",
          scopeKey: key.scopeKey,
          bindingIndex: 0,
          scopeState: null,
          execSessionUuid: null,
        };
        expect(await registry.snapshotManagedDevices()).toEqual([entry]);
        // Boot admission counts the listed UDID, regardless of the registry's temporary name.
        const fleet = new FakeFleetHostSource();
        fleet.inventory = [
          {
            udid: "UDID-CREATED",
            name,
            state: "Booted",
            runtime: "iOS-18",
            isAvailable: true,
          },
        ];
        fleet.snapshot = {
          takenAtMs: timer.now(),
          processes: [],
          resources: {
            totalMemoryBytes: 16 * 1024 ** 3,
            cpuCount: 8,
            loadAverage1m: 0,
            memoryPressure: "normal",
          },
        };
        const capacity = new IosSimCapacityGate(
          new IosSimFleetCostCollector(fleet, new InMemoryBootDurationHistory(), timer),
          timer,
          { env: { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "1" } },
        );
        expect(await capacity.describeCapacity()).toMatchObject({ booted: 1, inFlight: 0 });
        await expect(capacity.assertCapacityAvailable()).rejects.toMatchObject({
          code: "capacity_exhausted",
          details: { booted: 1, externalDevices: ["UDID-CREATED"] },
        });
        const exclusion = new RegistryBindingExclusion(async () => registry, timer);
        await exclusion.refresh();
        expect(exclusion.holderOf({ platform: "ios", stableIds: [name] })).toEqual(entry);
        for (const other of ["iPhone user", `${name}-user`, "amslot-12345678-0-g1-other"]) {
          expect(exclusion.holderOf({ platform: "ios", stableIds: [other] })).toBeUndefined();
        }
        expect(
          await registry.advanceBindingJournal(opened.entry.id, {
            owner: OWNER_1,
            expectedPhase: "creating",
            phase: "created",
            target: { newStableId: "UDID-CREATED" },
          }),
        ).toMatchObject({ kind: "advanced" });
        expect(await registry.snapshotManagedDevices()).toEqual([
          { ...entry, stableDeviceId: "UDID-CREATED" },
        ]);
        await exclusion.refresh();
        expect(exclusion.stableIdsFor("ios")).toEqual(new Set(["UDID-CREATED"]));
        expect(await capacity.describeCapacity()).toMatchObject({ booted: 1, inFlight: 0 });
        await expect(capacity.assertCapacityAvailable()).rejects.toMatchObject({
          code: "capacity_exhausted",
          details: { booted: 1, externalDevices: ["UDID-CREATED"] },
        });
        expect(
          exclusion.holderOf({ platform: "ios", stableIds: ["UDID-CREATED", name] }),
        ).toMatchObject({ stableDeviceId: "UDID-CREATED" });
      });

      test("terminal entries are pruned after the retention window; open ones never are", async () => {
        const key = { scopeKey: await readyScope(), bindingIndex: 0 };
        const other = { scopeKey: key.scopeKey, bindingIndex: 1 };
        await boundSlot(key, "avd-1");
        await boundSlot(other, "avd-2");
        const entry = await openReplace(key);
        await registry.advanceBindingJournal(entry.id, {
          owner: OWNER_1,
          expectedPhase: "deleting",
          phase: "rolled_back",
        });
        const open = await registry.openBindingJournal(other, {
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
        timer.advanceTime(BINDING_JOURNAL_TERMINAL_RETENTION_MS + 1);
        await registry.openBindingJournal(key, {
          kind: "release",
          phase: "intent",
          owner: OWNER_1,
          target: TARGET,
          assignment: { kind: "state", expected: BOUND, state: "cleanup_pending" },
        });
        expect(await registry.getBindingJournal(entry.id)).toBeNull();
        expect(await registry.listOpenBindingJournal(other)).toHaveLength(1);
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
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
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

    test("the resource snapshot exposes abandoned scope keys without unrelated scope history", async () => {
      const abandoned = await readyScope(SCOPE_A1);
      const reset = await readyScope(SCOPE_B1);
      await readyScope({ ...SCOPE_A1, runnerNamespace: "untouched" });
      await abandon(abandoned);
      await registry.beginScopeInvalidation(reset, "operator_reset");
      await registry.completeScopeInvalidation(reset);
      const snapshot = await registry.snapshotBindingResources();
      expect(snapshot.abandonedScopeKeys).toEqual([abandoned]);
      expect(snapshot).not.toHaveProperty("scopes");
    });

    test("malformed binding keys and thresholds are rejected before storage", async () => {
      const scopeKey = await readyScope();
      await expect(registry.initBinding({ scopeKey, bindingIndex: -1 }, INIT)).rejects.toThrow(
        "non-negative integer",
      );
      await expect(registry.initBinding({ scopeKey, bindingIndex: 1.5 }, INIT)).rejects.toThrow(
        "non-negative integer",
      );
      await expect(registry.findAbandonedScopes({ thresholdMs: -1 })).rejects.toThrow(
        "non-negative",
      );
    });
    describe("free-device deletion journal", () => {
      const owner = { daemonId: "one", pid: 11, processGenerationToken: "generation-one" };
      const next = { daemonId: "two", pid: 12, processGenerationToken: "generation-two" };
      async function freeRow(id = "amslot-delete") {
        const scopeKey = await readyScope({ ...SCOPE_A1, runnerNamespace: id });
        await boundSlot({ scopeKey, bindingIndex: 0 }, id);
        await registry.beginScopeInvalidation(scopeKey, "operator_reset");
        await registry.completeScopeInvalidation(scopeKey);
        return (await registry.listFreeDevices()).find((row) => row.stableDeviceId === id)!;
      }
      test("begin is exact-row CAS, persists its owner and rejects a second begin", async () => {
        const row = await freeRow();
        expect(
          await registry.beginFreeDeviceDeletion({ ...row, freedAtMs: row.freedAtMs + 1 }, owner),
        ).toMatchObject({ kind: "not_evictable" });
        expect(
          await registry.beginFreeDeviceDeletion({ ...row, fromScopeKey: "other" }, owner),
        ).toMatchObject({ kind: "not_evictable" });
        expect(await registry.beginFreeDeviceDeletion(row, owner)).toMatchObject({
          kind: "begun",
          row: {
            deletion: {
              owner,
              attempts: 0,
              failedDeletes: 0,
              lastError: null,
              startedAtMs: timer.now(),
              nextAttemptAtMs: timer.now(),
            },
          },
        });
        expect(await registry.beginFreeDeviceDeletion(row, next)).toMatchObject({
          kind: "not_evictable",
        });
        expect(await registry.listFreeDeviceDeletions()).toHaveLength(1);
      });
      test("attempt and completion require the exact owner including its process token", async () => {
        const row = await freeRow();
        await registry.beginFreeDeviceDeletion(row, owner);
        const impostor = { ...owner, processGenerationToken: "reused-pid" };
        expect(
          await registry.recordFreeDeviceDeletionAttempt(row, impostor, {
            error: "bad",
            nextAttemptAtMs: 3,
          }),
        ).toBe(false);
        expect(await registry.completeFreeDeviceDeletion(row, impostor)).toBe(false);
        expect(
          await registry.recordFreeDeviceDeletionAttempt(row, owner, {
            error: "retry",
            nextAttemptAtMs: timer.now() + 500,
          }),
        ).toBe(true);
        expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
          attempts: 1,
          failedDeletes: 0,
          lastError: "retry",
          nextAttemptAtMs: timer.now() + 500,
        });
        expect(
          await registry.recordFreeDeviceDeletionAttempt(row, owner, {
            error: "native failed",
            nextAttemptAtMs: 8,
            nativeDeleteFailed: true,
          }),
        ).toBe(true);
        expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
          attempts: 2,
          failedDeletes: 1,
        });
        expect(
          await registry.completeFreeDeviceDeletion({ ...row, fromScopeKey: "other" }, owner),
        ).toBe(false);
        expect(await registry.completeFreeDeviceDeletion(row, owner)).toBe(true);
        expect(await registry.completeFreeDeviceDeletion(row, owner)).toBe(false);
        expect(await registry.listFreeDeviceDeletions()).toEqual([]);
      });
      test("claim is owner CAS and preserves the deletion commitment and retry", async () => {
        const row = await freeRow();
        await registry.beginFreeDeviceDeletion(row, owner);
        await registry.recordFreeDeviceDeletionAttempt(row, owner, {
          error: "retry",
          nativeDeleteFailed: true,
          nextAttemptAtMs: 9,
        });
        expect(await registry.claimFreeDeviceDeletion(row, next, owner)).toBe(false);
        expect(await registry.claimFreeDeviceDeletion(row, owner, next)).toBe(true);
        expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
          owner: next,
          attempts: 1,
          failedDeletes: 1,
          lastError: "retry",
          nextAttemptAtMs: 9,
        });
        expect(await registry.completeFreeDeviceDeletion(row, owner)).toBe(false);
        expect(await registry.completeFreeDeviceDeletion(row, next)).toBe(true);
      });
      test("list orders retries and marked rows remain excluded, never stoppable or adoptable", async () => {
        const first = await freeRow("amslot-first");
        const second = await freeRow("amslot-second");
        for (const row of [first, second]) {
          await registry.beginFreeDeviceDeletion(row, owner);
        }
        await registry.recordFreeDeviceDeletionAttempt(first, owner, {
          error: "retry",
          nextAttemptAtMs: timer.now() + 500,
        });
        expect((await registry.listFreeDeviceDeletions()).map((row) => row.stableDeviceId)).toEqual(
          [second.stableDeviceId, first.stableDeviceId],
        );
        expect(await registry.findReclaimableFreeDevices({ thresholdMs: 0 })).toEqual([]);
        expect(
          await registry.beginFreeDeviceStop(
            { ...first, claimedBy: "stopper" },
            { thresholdMs: 0 },
          ),
        ).toEqual({ kind: "not_reclaimable" });
        const key = { scopeKey: await readyScope(SCOPE_B1), bindingIndex: 0 };
        await registry.initBinding(key, INIT);
        expect(
          await registry.commitBinding(
            key,
            { generation: 0, stableDeviceId: null },
            readyBinding(first.stableDeviceId, 1),
          ),
        ).toEqual({ kind: "free_device_stopping" });
        const opened = await registry.openBindingJournal(key, {
          kind: "create",
          phase: "creating",
          owner,
          target: {
            oldStableId: null,
            oldName: null,
            newStableId: first.stableDeviceId,
            newName: first.stableDeviceId,
            requestedSpec: SPEC,
            resolvedSpec: SPEC,
            specFingerprint: "fp",
          },
          assignment: {
            kind: "state",
            expected: { generation: 0, stableDeviceId: null },
            state: "provisioning",
          },
        });
        if (opened.kind !== "opened") {
          throw new Error(opened.kind);
        }
        expect(
          await registry.advanceBindingJournal(opened.entry.id, {
            owner,
            expectedPhase: "creating",
            phase: "committed",
            assignment: {
              kind: "commit",
              expected: opened.entry.binding,
              next: readyBinding(first.stableDeviceId, 1),
            },
          }),
        ).toEqual({ kind: "free_device_stopping" });
        expect(await registry.listFreeDeviceDeletions()).toHaveLength(2);
        expect(
          (await registry.snapshotManagedDevices()).filter((entry) => entry.holder === "free"),
        ).toHaveLength(2);
      });
      test("deletion metadata returned by list cannot mutate the stored owner", async () => {
        const row = await freeRow();
        await registry.beginFreeDeviceDeletion(row, owner);
        const copy = (await registry.listFreeDevices())[0];
        copy.deletion!.owner.daemonId = "tampered";
        expect((await registry.listFreeDevices())[0].deletion!.owner.daemonId).toBe(owner.daemonId);
      });
    });
  });
}
