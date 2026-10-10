import { beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  managedSlotDeviceName,
  type ManagedSlotReconcileRequest,
  type ManagedSlotReconcileResult,
} from "../../../src/daemon/managedSlots/reconciler";
import {
  ManagedSlotJournal,
  SlotJournalInFlight,
  SlotJournalRedriveLoop,
} from "../../../src/daemon/managedSlots/slotJournal";
import type {
  AdvanceSlotJournalInput,
  SlotJournalOwner,
  SlotKey,
  SlotRegistry,
} from "../../../src/daemon/managedSlots/slotRegistry";
import type { ExactDeviceSpecification } from "../../../src/devices/exactDeviceProvisioning";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

// #11179: every create/replace/release of a managed slot is journaled with its exact devices. A
// process that dies at any commit boundary leaves an open entry; the next daemon (at startup or at
// the slot's next acquisition) redrives it to convergence without repeating destructive work.
//
// A "crash" here is a boundary that never returns: the first daemon's promise is abandoned at that
// point, exactly like a process killed there, and a second daemon takes over the shared registry.

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IOS_17 = "com.apple.CoreSimulator.SimRuntime.iOS-17-5";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const SPEC_18: ExactDeviceSpecification = { runtime: IOS_18, deviceType: IPHONE_16 };
const SPEC_17: ExactDeviceSpecification = { runtime: IOS_17, deviceType: IPHONE_16 };
const SCOPE = { managedHostScope: "host-a", runnerNamespace: "ns", runnerIncarnation: "inc-1" };

function owner(daemonId: string): SlotJournalOwner {
  return {
    daemonId,
    pid: daemonId === "daemon-1" ? 1001 : 2002,
    processGenerationToken: `${daemonId}-start`,
  };
}

/** A boundary that never returns, and a promise that resolves once execution reaches it. */
function crashPoint(): { reached: Promise<void>; hang: () => Promise<never> } {
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return {
    reached,
    hang: () => {
      signal();
      return new Promise<never>(() => {});
    },
  };
}

/**
 * Registry that "crashes" on the first `advanceSlotJournal` into `phase`: before the write lands,
 * or after it committed but before the caller sees the result.
 */
function crashingRegistry(
  registry: SlotRegistry,
  phase: AdvanceSlotJournalInput["phase"],
  when: "before" | "after",
  hang: () => Promise<never>,
): SlotRegistry {
  let fired = false;
  return new Proxy(registry, {
    get(target, property, receiver) {
      if (property !== "advanceSlotJournal") {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (id: number, input: AdvanceSlotJournalInput) => {
        if (fired || input.phase !== phase) {
          return target.advanceSlotJournal(id, input);
        }
        fired = true;
        if (when === "before") {
          return hang();
        }
        await target.advanceSlotJournal(id, input);
        return hang();
      };
    },
  });
}

describe("managed slot journal redrive", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let inventory: FakeInventory;
  let matcher: FakeMatcher;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let claims: FakeClaims;
  let liveDaemons: Set<string>;
  let key: SlotKey;

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    registry = new FakeSlotRegistry(timer);
    inventory = new FakeInventory();
    matcher = new FakeMatcher();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    claims = new FakeClaims();
    liveDaemons = new Set(["daemon-1", "daemon-2"]);
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  });

  function daemon(daemonId: string, slotRegistry: SlotRegistry = registry) {
    return new ManagedSlotReconciler({
      registry: slotRegistry,
      inventory,
      matcher,
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      claims,
      timer,
      journal: {
        owner: owner(daemonId),
        isOwnerLive: (candidate) => liveDaemons.has(candidate.daemonId),
        inFlight: new SlotJournalInFlight(),
      },
    });
  }

  function request(spec: ExactDeviceSpecification = SPEC_18): ManagedSlotReconcileRequest {
    return {
      key,
      role: "app",
      platform: "ios",
      requestedSpec: spec,
      deadlineMs: timer.now() + 60_000,
    };
  }

  function expectReady(result: ManagedSlotReconcileResult) {
    if (result.outcome !== "ready") {
      throw new Error(`expected ready, got ${JSON.stringify(result.failure)}`);
    }
    return result;
  }

  function expectFailed(result: ManagedSlotReconcileResult) {
    if (result.outcome !== "failed") {
      throw new Error(`expected failure, got ${result.disposition}`);
    }
    return result;
  }

  /** Slot 0 bound to a SPEC_17 device; returns its UDID. */
  async function seedOldDevice(): Promise<string> {
    const seeded = expectReady(await daemon("daemon-0").reconcile(request(SPEC_17)));
    provisioner.calls.length = 0;
    return seeded.device.stableId;
  }

  /** Daemon 1 dies; daemon 2 starts. */
  function restart(): ManagedSlotReconciler {
    liveDaemons.delete("daemon-1");
    return daemon("daemon-2");
  }

  async function expectSettledSlot(): Promise<void> {
    expect(await registry.listOpenSlotJournal()).toEqual([]);
    expect((await registry.getAssignment(key))?.state).toBe("ready");
  }

  describe("replacement interrupted at every boundary converges on the next acquisition", () => {
    test("crash before the delete: the restarted daemon deletes the recorded device once", async () => {
      const oldId = await seedOldDevice();
      const crash = crashPoint();
      deleter.beforeDelete = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;
      expect(await registry.getAssignment(key)).toMatchObject({
        stableDeviceId: oldId,
        state: "replacing",
      });
      deleter.beforeDelete = undefined;

      const result = expectReady(await restart().reconcile(request()));

      expect(inventory.has(oldId)).toBe(false);
      expect(result.evidence.redriven).toEqual([
        expect.objectContaining({ kind: "replace", outcome: "settled" }),
      ]);
      expect(provisioner.created()).toHaveLength(1);
      expect(result.device.stableId).not.toBe(oldId);
      await expectSettledSlot();
    });

    test("crash after the delete: complete discovery proves absence, no second delete", async () => {
      const oldId = await seedOldDevice();
      const crash = crashPoint();
      deleter.afterDelete = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;

      const result = expectReady(await restart().reconcile(request()));

      expect(deleter.stableIds()).toEqual([oldId]);
      expect(provisioner.created()).toHaveLength(1);
      expect(result.assignment.stableDeviceId).toBe(result.device.stableId);
      await expectSettledSlot();
    });

    test("crash after the deletion is recorded: the empty slot is filled, nothing deleted again", async () => {
      const oldId = await seedOldDevice();
      const crash = crashPoint();
      const d1 = daemon("daemon-1", crashingRegistry(registry, "deleted", "after", crash.hang));
      void d1.reconcile(request());
      await crash.reached;
      expect(await registry.getAssignment(key)).toMatchObject({
        stableDeviceId: null,
        state: "provisioning",
      });

      const result = expectReady(await restart().reconcile(request()));

      expect(deleter.stableIds()).toEqual([oldId]);
      expect(result.disposition).toBe("created");
      await expectSettledSlot();
    });

    test("crash before the create: proven absence rolls the entry back and one device is created", async () => {
      await seedOldDevice();
      const crash = crashPoint();
      provisioner.beforeCreate = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;
      provisioner.beforeCreate = undefined;

      const result = expectReady(await restart().reconcile(request()));

      expect(inventory.devices.map((device) => device.runtime)).toEqual([IOS_18]);
      expect(result.disposition).toBe("created");
      await expectSettledSlot();
    });

    test("crash after the create: the recorded device is adopted, not recreated or deleted", async () => {
      const oldId = await seedOldDevice();
      const crash = crashPoint();
      provisioner.beforeReturn = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;
      provisioner.beforeReturn = undefined;
      const createdByDaemon1 = inventory.devices.find((device) => device.runtime === IOS_18)!;

      const result = expectReady(await restart().reconcile(request()));

      expect(result.disposition).toBe("reused");
      expect(result.device.stableId).toBe(createdByDaemon1.deviceId!);
      expect(provisioner.created()).toHaveLength(1);
      expect(deleter.stableIds()).toEqual([oldId]);
      await expectSettledSlot();
    });

    test("crash after readiness, before the binding commit: the ready device is adopted", async () => {
      const oldId = await seedOldDevice();
      const crash = crashPoint();
      const d1 = daemon("daemon-1", crashingRegistry(registry, "committed", "before", crash.hang));
      void d1.reconcile(request());
      await crash.reached;
      const [entry] = await registry.listOpenSlotJournal(key);
      expect(entry).toMatchObject({ kind: "replace", phase: "created" });

      const result = expectReady(await restart().reconcile(request()));

      expect(result.device.stableId).toBe(entry.target.newStableId!);
      expect(provisioner.created()).toHaveLength(1);
      expect(deleter.stableIds()).toEqual([oldId]);
      await expectSettledSlot();
    });

    test("crash after the binding commit: the retry reuses the committed device with a fresh session", async () => {
      const oldId = await seedOldDevice();
      const crash = crashPoint();
      const d1 = daemon("daemon-1", crashingRegistry(registry, "committed", "after", crash.hang));
      void d1.reconcile(request());
      await crash.reached;
      const committed = await registry.getAssignment(key);

      const result = expectReady(await restart().reconcile(request()));

      expect(result.disposition).toBe("reused");
      expect(result.device.stableId).toBe(committed!.stableDeviceId!);
      expect(result.evidence.redriven).toBeUndefined();
      expect(provisioner.created()).toHaveLength(1);
      expect(deleter.stableIds()).toEqual([oldId]);
      await expectSettledSlot();
    });

    test("a lost response after session persistence: the retry converges, no repeated replacement", async () => {
      const oldId = await seedOldDevice();
      const first = expectReady(await daemon("daemon-1").reconcile(request()));
      // The response never reached the caller; the execution ends and the caller retries.

      const retry = expectReady(await restart().reconcile(request()));

      expect(retry.disposition).toBe("reused");
      expect(retry.device.stableId).toBe(first.device.stableId);
      expect(retry.sessionUuid).not.toBe(first.sessionUuid);
      expect(retry.assignment.generation).toBe(first.assignment.generation);
      expect(provisioner.created()).toHaveLength(1);
      expect(deleter.stableIds()).toEqual([oldId]);
    });
  });

  describe("an interrupted create of an empty slot", () => {
    test("crash after the create: the next acquisition adopts the device under the generated name", async () => {
      const crash = crashPoint();
      provisioner.beforeReturn = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;
      provisioner.beforeReturn = undefined;

      const result = expectReady(await restart().reconcile(request()));

      // Generated name for generation 1 (its per-attempt nonce varies).
      expect(result.device.name.startsWith(managedSlotDeviceName(key, 1, "x").slice(0, -1))).toBe(
        true,
      );
      expect(inventory.devices).toHaveLength(1);
      expect(result.evidence.redriven).toEqual([
        expect.objectContaining({ kind: "create", outcome: "settled" }),
      ]);
      await expectSettledSlot();
    });

    test("an in-process provision failure with proven absence closes the entry at once", async () => {
      provisioner.failWith = () => new Error("simctl create failed");
      expectFailed(await daemon("daemon-1").reconcile(request()));
      expect(await registry.listOpenSlotJournal()).toEqual([]);
    });
  });

  describe("safety", () => {
    test("a live owner's unfinished work is never taken over", async () => {
      const oldId = await seedOldDevice();
      const crash = crashPoint();
      deleter.afterDelete = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;

      const result = expectFailed(await daemon("daemon-2").reconcile(request()));

      expect(result.failure).toMatchObject({ code: "cleanup_pending", retryable: true });
      expect(deleter.stableIds()).toEqual([oldId]);
      expect(provisioner.created()).toHaveLength(0);
    });

    test("partial inventory is never absence: the deletion is not recorded until discovery completes", async () => {
      const oldId = await seedOldDevice();
      const crash = crashPoint();
      deleter.afterDelete = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;
      inventory.complete = false;
      const d2 = restart();

      const blocked = expectFailed(await d2.reconcile(request()));
      expect(blocked.failure.code).toBe("discovery_incomplete");
      expect((await registry.getAssignment(key))?.stableDeviceId).toBe(oldId);

      inventory.complete = true;
      timer.advanceTime(1_000);
      expectReady(await d2.reconcile(request()));
      expect(deleter.stableIds()).toEqual([oldId]);
    });

    test("a created device that now belongs to another slot is never adopted or deleted", async () => {
      const crash = crashPoint();
      provisioner.beforeReturn = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;
      provisioner.beforeReturn = undefined;
      const orphan = inventory.devices[0].deviceId!;
      const other = { scopeKey: key.scopeKey, slotIndex: 1 };
      await registry.initSlot(other, { role: "b", platform: "ios", requestedSpec: SPEC_18 });
      await registry.commitBinding(
        other,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: orphan,
          deviceName: "taken",
          resolvedSpec: null,
          specFingerprint: null,
          state: "ready",
        },
      );

      const result = expectReady(await restart().reconcile(request()));

      expect(inventory.has(orphan)).toBe(true);
      expect(deleter.calls).toHaveLength(0);
      expect(result.device.stableId).not.toBe(orphan);
      expect((await registry.getAssignment(other))?.stableDeviceId).toBe(orphan);
    });

    test("a deletion entry whose slot was rebound deletes nothing", async () => {
      const oldId = await seedOldDevice();
      const crash = crashPoint();
      deleter.beforeDelete = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;
      deleter.beforeDelete = undefined;
      // An operator rebinds the slot to another device while daemon 1 is down.
      const [fenced] = await registry.listOpenSlotJournal(key);
      await registry.commitBinding(key, fenced.binding, {
        stableDeviceId: "UDID-OPERATOR",
        deviceName: "operator",
        resolvedSpec: null,
        specFingerprint: null,
        state: "ready",
      });
      liveDaemons.delete("daemon-1");
      const journal = daemon("daemon-2").journal;

      const pass = await journal.runPass();

      expect(pass.settled).toEqual([
        expect.objectContaining({ kind: "replace", phase: "rolled_back" }),
      ]);
      expect(inventory.has(oldId)).toBe(true);
      expect(deleter.calls).toHaveLength(1);
    });

    test("an uncommitted device that is held by a live session is left for a later pass", async () => {
      const crash = crashPoint();
      provisioner.beforeReturn = crash.hang;
      void daemon("daemon-1").reconcile(request());
      await crash.reached;
      provisioner.beforeReturn = undefined;
      const orphan = inventory.devices[0].deviceId!;
      // The slot moved on (another create committed), so the orphan must be removed — but a
      // generic session grabbed it meanwhile.
      const [entry] = await registry.listOpenSlotJournal(key);
      await registry.commitBinding(key, entry.binding, {
        stableDeviceId: "UDID-OTHER",
        deviceName: "other",
        resolvedSpec: null,
        specFingerprint: null,
        state: "ready",
      });
      claims.claims.set(orphan, { kind: "held", reason: "session S9" });
      liveDaemons.delete("daemon-1");
      const journal = daemon("daemon-2").journal;

      expect((await journal.runPass()).blocked).toEqual([
        expect.objectContaining({ reason: "device_busy" }),
      ]);
      expect(inventory.has(orphan)).toBe(true);

      claims.claims.delete(orphan);
      timer.advanceTime(1_000);
      expect((await journal.runPass()).settled).toEqual([
        expect.objectContaining({ phase: "rolled_back" }),
      ]);
      expect(inventory.has(orphan)).toBe(false);
    });
  });

  describe("durable local owner", () => {
    test("failed cleanup backs off fairly and is never abandoned", async () => {
      const oldId = await seedOldDevice();
      deleter.failWith = "simctl delete failed";
      expectFailed(await daemon("daemon-1").reconcile(request()));
      liveDaemons.delete("daemon-1");
      const journal = daemon("daemon-2").journal;

      for (let attempt = 0; attempt < 8; attempt += 1) {
        timer.advanceTime(60_000);
        const pass = await journal.runPass();
        expect(pass.blocked).toEqual([expect.objectContaining({ reason: "cleanup_pending" })]);
      }
      const [entry] = await registry.listOpenSlotJournal(key);
      expect(entry).toMatchObject({ phase: "deleting", attempts: 9 });
      // Not due yet: the pass skips it rather than hammering the delete.
      expect(await journal.runPass()).toEqual({ settled: [], blocked: [], skipped: 1 });

      deleter.failWith = undefined;
      timer.advanceTime(60_000);
      expect((await journal.runPass()).settled).toEqual([
        expect.objectContaining({ phase: "committed" }),
      ]);
      expect(inventory.has(oldId)).toBe(false);
      expect(await registry.getAssignment(key)).toMatchObject({
        stableDeviceId: null,
        state: "provisioning",
      });
    });

    test("one stuck entry does not starve another slot's entry", async () => {
      const oldId = await seedOldDevice();
      deleter.failWith = "stuck";
      expectFailed(await daemon("daemon-1").reconcile(request()));
      deleter.failWith = undefined;
      const other = { scopeKey: key.scopeKey, slotIndex: 1 };
      const crash = crashPoint();
      provisioner.beforeCreate = crash.hang;
      void daemon("daemon-1").reconcile({ ...request(), key: other });
      await crash.reached;
      provisioner.beforeCreate = undefined;
      deleter.failWith = "stuck";
      liveDaemons.delete("daemon-1");
      timer.advanceTime(1_000);

      const pass = await daemon("daemon-2").journal.runPass();

      expect(pass.blocked).toEqual([expect.objectContaining({ reason: "cleanup_pending" })]);
      expect(pass.settled).toEqual([
        expect.objectContaining({ kind: "create", phase: "rolled_back" }),
      ]);
      expect(inventory.has(oldId)).toBe(true);
    });

    test("a release left settling by a dead daemon returns the slot to ready once the device is free", async () => {
      const deviceId = await seedOldDevice();
      const opened = await registry.openSlotJournal(key, {
        kind: "release",
        phase: "intent",
        owner: owner("daemon-1"),
        target: {
          oldStableId: deviceId,
          oldName: null,
          newName: null,
          newStableId: null,
          requestedSpec: SPEC_17,
          resolvedSpec: null,
          specFingerprint: null,
        },
        assignment: {
          kind: "state",
          expected: { generation: 1, stableDeviceId: deviceId },
          state: "settling",
          options: { settler: owner("daemon-1") },
        },
      });
      if (opened.kind !== "opened") {
        throw new Error(`release not journaled: ${opened.kind}`);
      }
      // Entering `settling` is a fence: the generation moved (#11242).
      const binding = { generation: 2, stableDeviceId: deviceId };
      expect(opened.assignment).toMatchObject({ ...binding, state: "settling" });
      const journal = daemon("daemon-2").journal;

      // Daemon 1 is alive: its drain still guards the slot.
      expect(await journal.runPass()).toEqual({ settled: [], blocked: [], skipped: 1 });

      liveDaemons.delete("daemon-1");
      claims.claims.set(deviceId, { kind: "held", reason: "rehydrated session" });
      expect((await journal.runPass()).blocked).toEqual([
        expect.objectContaining({ kind: "release", reason: "device_busy" }),
      ]);

      claims.claims.delete(deviceId);
      timer.advanceTime(1_000);
      expect((await journal.runPass()).settled).toEqual([
        expect.objectContaining({ kind: "release", phase: "committed" }),
      ]);
      expect(await registry.getAssignment(key)).toMatchObject({ ...binding, state: "ready" });
      expect(deleter.calls).toHaveLength(0);
    });

    test("a cleanup_pending slot (failed deletion) with no journal entry has its deletion redriven", async () => {
      const deviceId = await seedOldDevice();
      await registry.updateSlotState(
        key,
        { generation: 1, stableDeviceId: deviceId },
        "cleanup_pending",
      );

      const result = expectReady(await daemon("daemon-2").reconcile(request(SPEC_18)));

      expect(deleter.stableIds()).toEqual([deviceId]);
      expect(result.evidence.redriven).toEqual([
        expect.objectContaining({ kind: "replace", outcome: "settled" }),
      ]);
      expect(inventory.has(deviceId)).toBe(false);
    });

    test("the redrive loop runs a pass at start and then every interval until stopped", async () => {
      let passes = 0;
      const loop = new SlotJournalRedriveLoop(
        {
          runPass: async () => {
            passes += 1;
            return { settled: [], blocked: [], skipped: 0 };
          },
        },
        timer,
        5_000,
      );
      const untilSleeping = async () => {
        for (let turn = 0; turn < 50 && timer.getPendingSleepCount() === 0; turn += 1) {
          await Promise.resolve();
        }
      };
      loop.start();
      await untilSleeping();
      expect(passes).toBe(1);
      timer.advanceTime(5_000);
      await untilSleeping();
      expect(passes).toBe(2);
      const stopped = loop.stop();
      timer.advanceTime(5_000);
      await stopped;
      expect(passes).toBe(2);
    });
  });

  test("an entry this process is driving is skipped by a concurrent pass", async () => {
    await seedOldDevice();
    const inFlight = new SlotJournalInFlight();
    const crash = crashPoint();
    deleter.beforeDelete = crash.hang;
    const d1 = new ManagedSlotReconciler({
      registry,
      inventory,
      matcher,
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      claims,
      timer,
      journal: { owner: owner("daemon-1"), isOwnerLive: () => true, inFlight },
    });
    void d1.reconcile(request());
    await crash.reached;
    const sameProcess = new ManagedSlotJournal({
      registry,
      inventory,
      matcher,
      deleter,
      claims,
      timer,
      owner: owner("daemon-1"),
      inFlight,
    });

    expect(await sameProcess.runPass()).toEqual({ settled: [], blocked: [], skipped: 1 });
    expect(deleter.calls).toHaveLength(1);
  });
});
