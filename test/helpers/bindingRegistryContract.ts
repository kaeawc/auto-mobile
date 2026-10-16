import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BINDING_JOURNAL_TERMINAL_RETENTION_MS,
  computeBindingScopeKey,
  type BindingExecOwner,
  type BindingExecOwnerLiveness,
  type BindingKey,
  type BindingRegistry,
  type BindingScopeIdentity,
} from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import { ManagedExecutionReowner } from "../../src/daemon/sessionBroker/provisioning/executionReowner";
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
 * Behaviour every {@link BindingRegistry} must share. Run against the fake and the SQLite registry so
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
            holder: "session_broker",
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
          holder: "session_broker",
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

    test("malformed binding keys and thresholds are rejected before storage", async () => {
      const scopeKey = await readyScope();
      await expect(registry.initBinding({ scopeKey, bindingIndex: -1 }, INIT)).rejects.toThrow(
        "non-negative integer",
      );
      await expect(registry.initBinding({ scopeKey, bindingIndex: 1.5 }, INIT)).rejects.toThrow(
        "non-negative integer",
      );
    });

    test("mutations on a missing binding are refused", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      const missing = await registry.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        readyBinding("avd-1", 1),
      );
      expect(missing.kind).toBe("binding_missing");
    });

    test("read APIs identify bound devices and unknown identities", async () => {
      const key = { scopeKey: await readyScope(), bindingIndex: 0 };
      await boundSlot(key, "avd-1");
      expect(await registry.findDeviceHolder("android", "avd-1")).toMatchObject({
        kind: "binding",
        scope: { state: "valid" },
        assignment: { bindingIndex: 0 },
      });
      expect(await registry.findDeviceHolder("android", "unknown")).toBeNull();
    });

    test("scope namespaces remain independent and an existing incarnation conflicts", async () => {
      await readyScope(SCOPE_A1);
      expect((await registry.ensureScope(SCOPE_B1)).kind).toBe("ready");
      expect(
        await registry.ensureScope({ ...SCOPE_A1, runnerIncarnation: "boot-2" }),
      ).toMatchObject({ kind: "incarnation_conflict" });
      expect((await registry.getScope(computeBindingScopeKey(SCOPE_B1)))?.state).toBe("valid");
    });
  });
}
