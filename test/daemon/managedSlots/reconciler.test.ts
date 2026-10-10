import { beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  encodeManagedSpecFingerprint,
  managedSlotDeviceName,
  type ManagedSlotReconcileRequest,
  type ManagedSlotReconcileResult,
  chooseIosDeviceType,
} from "../../../src/daemon/managedSlots/reconciler";
import type { SlotKey } from "../../../src/daemon/managedSlots/slotRegistry";
import {
  ProvisionDeviceError,
  type ExactDeviceSpecification,
  type ExactIosRuntimeCatalog,
} from "../../../src/devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../src/models";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import type { AvdConfig } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../../../src/utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IOS_17 = "com.apple.CoreSimulator.SimRuntime.iOS-17-5";
const IOS_9 = "com.apple.CoreSimulator.SimRuntime.iOS-9-0";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const SPEC_18: ExactDeviceSpecification = { runtime: IOS_18, deviceType: IPHONE_16 };
const SPEC_17: ExactDeviceSpecification = { runtime: IOS_17, deviceType: IPHONE_16 };
const IPHONE_15 = "com.apple.CoreSimulator.SimDeviceType.iPhone-15";
const IPAD = "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4";
const IPHONE_OLD = "com.apple.CoreSimulator.SimDeviceType.iPhone-8";

function runtime(identifier: string, version: string, isAvailable = true) {
  return {
    identifier,
    version,
    isAvailable,
    bundlePath: "",
    buildversion: "",
    runtimeRoot: "",
    name: `iOS ${version}`,
  };
}

function deviceType(identifier: string, productFamily: string, min: string, max: string) {
  return {
    identifier,
    name: identifier.split(".").at(-1)!,
    minRuntimeVersion: 0,
    maxRuntimeVersion: 0,
    minRuntimeVersionString: min,
    maxRuntimeVersionString: max,
    bundlePath: "",
    productFamily,
  };
}

/** simctl lists device types oldest first; the iPad and the old iPhone must never be chosen. */
const ANY_MODEL_CATALOG: ExactIosRuntimeCatalog = {
  getRuntimesChecked: async () => [runtime(IOS_17, "17.5"), runtime(IOS_18, "18.0")],
  getDeviceTypesChecked: async () => [
    deviceType(IPHONE_OLD, "iPhone", "11.0", "16.4"),
    deviceType(IPHONE_15, "iPhone", "17.0", "65535.255.255"),
    deviceType(IPHONE_16, "iPhone", "18.0", "65535.255.255"),
    deviceType(IPAD, "iPad", "17.0", "65535.255.255"),
  ],
};

const SCOPE = { managedHostScope: "host-a", runnerNamespace: "ns", runnerIncarnation: "inc-1" };

describe("ManagedSlotReconciler", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let inventory: FakeInventory;
  let matcher: FakeMatcher;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let claims: FakeClaims;
  let capacity: FakeCapacity;
  let reconciler: ManagedSlotReconciler;
  let key: SlotKey;

  beforeEach(async () => {
    timer = new FakeTimer();
    registry = new FakeSlotRegistry(timer);
    inventory = new FakeInventory();
    matcher = new FakeMatcher();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    claims = new FakeClaims();
    capacity = new FakeCapacity();
    reconciler = new ManagedSlotReconciler({
      registry,
      inventory,
      matcher,
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      claims,
      capacity,
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => true,
    });
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  });

  function request(
    spec: ExactDeviceSpecification = SPEC_18,
    overrides: Partial<ManagedSlotReconcileRequest> = {},
  ): ManagedSlotReconcileRequest {
    return {
      key,
      role: "app",
      platform: "ios",
      requestedSpec: spec,
      deadlineMs: timer.now() + 60_000,
      ...overrides,
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

  async function seedAssigned(spec = SPEC_18): Promise<string> {
    const result = expectReady(await reconciler.reconcile(request(spec)));
    provisioner.calls.length = 0;
    return result.device.stableId;
  }

  describe("booting a device that already exists", () => {
    test("the slot's own stopped or booting device is provisioned without asking the probe", async () => {
      const ownId = await seedAssigned();
      Object.assign(
        inventory.devices.find((device) => device.deviceId === ownId)!,
        {
          isRunning: false,
          state: "Booting",
        },
      );
      capacity.result = { kind: "exhausted", limit: 1, booted: 1, retryAfterMs: 5_000 };
      capacity.checks = 0;

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("reused");
      expect(result.device.stableId).toBe(ownId);
      expect(capacity.checks).toBe(0);
    });

    test("an adopted leftover device is provisioned without asking the probe", async () => {
      inventory.devices.push({
        name: managedSlotDeviceName(key, 1, "earlier"),
        platform: "ios",
        deviceId: "UDID-LEFTOVER",
        isRunning: false,
        state: "Booting",
        runtime: IOS_18,
        deviceType: IPHONE_16,
      });
      capacity.result = { kind: "exhausted", limit: 1, booted: 1, retryAfterMs: 5_000 };

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("adopted");
      expect(capacity.checks).toBe(0);
    });
  });

  describe("empty slot", () => {
    test("creates a device under the generated name and commits it ready at generation 1", async () => {
      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("created");
      expect(result.device.name).toBe(managedSlotDeviceName(key, 1, "fake-1"));
      expect(result.assignment).toMatchObject({
        generation: 1,
        stableDeviceId: result.device.stableId,
        state: "ready",
        specFingerprint: encodeManagedSpecFingerprint(result.specFingerprint),
      });
      expect(result.resolvedSpec).toMatchObject({ ...SPEC_18, displayCutout: expect.any(String) });
      expect(provisioner.created()).toHaveLength(1);
    });

    test("adopts a matching free-pool device from an invalidated scope", async () => {
      inventory.devices.push({
        name: "old",
        platform: "ios",
        deviceId: "UDID-FREE",
        isRunning: false,
        runtime: IOS_18,
        deviceType: IPHONE_16,
      });
      const old = await registry.ensureScope({ ...SCOPE, runnerNamespace: "other" });
      if (old.kind !== "ready") {
        throw new Error("setup");
      }
      const oldKey = { scopeKey: old.scope.scopeKey, slotIndex: 0 };
      await registry.initSlot(oldKey, { role: "app", platform: "ios", requestedSpec: SPEC_18 });
      await registry.commitBinding(
        oldKey,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: "UDID-FREE",
          deviceName: "old",
          resolvedSpec: null,
          specFingerprint: null,
          state: "ready",
        },
      );
      await registry.beginScopeInvalidation(old.scope.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(old.scope.scopeKey);

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("adopted");
      expect(result.evidence.adoptedFrom).toBe("free_pool");
      expect(result.assignment).toMatchObject({ stableDeviceId: "UDID-FREE", state: "ready" });
      expect(await registry.listFreeDevices()).toEqual([]);
      expect(provisioner.created()).toHaveLength(0);
    });

    test("adopts this slot's own uncommitted leftover, but never a matching unmanaged device", async () => {
      inventory.devices.push(
        {
          name: "My iPhone",
          platform: "ios",
          deviceId: "UDID-USER",
          isRunning: true,
          runtime: IOS_18,
          deviceType: IPHONE_16,
        },
        {
          name: managedSlotDeviceName(key, 1, "earlier"),
          platform: "ios",
          deviceId: "UDID-LEFTOVER",
          isRunning: true,
          runtime: IOS_18,
          deviceType: IPHONE_16,
        },
      );

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("adopted");
      expect(result.evidence.adoptedFrom).toBe("orphan");
      expect(result.device.stableId).toBe("UDID-LEFTOVER");
    });

    test("never adopts a matching device another valid slot holds", async () => {
      const other = await registry.ensureScope({ ...SCOPE, runnerNamespace: "other" });
      if (other.kind !== "ready") {
        throw new Error("setup");
      }
      const otherKey = { scopeKey: other.scope.scopeKey, slotIndex: 0 };
      inventory.devices.push({
        name: managedSlotDeviceName(key, 1, "earlier"),
        platform: "ios",
        deviceId: "UDID-HELD",
        isRunning: false,
        runtime: IOS_18,
        deviceType: IPHONE_16,
      });
      await registry.initSlot(otherKey, { role: "app", platform: "ios", requestedSpec: SPEC_18 });
      await registry.commitBinding(
        otherKey,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: "UDID-HELD",
          deviceName: "x",
          resolvedSpec: null,
          specFingerprint: null,
          state: "ready",
        },
      );

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("created");
      expect(result.device.stableId).not.toBe("UDID-HELD");
      expect(deleter.calls).toHaveLength(0);
    });

    test("partial inventory fails discovery_incomplete without creating", async () => {
      inventory.complete = false;

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure).toMatchObject({ code: "discovery_incomplete", retryable: true });
      expect(provisioner.calls).toHaveLength(0);
    });

    test("fails capacity_exhausted immediately at the boot limit, before creating", async () => {
      capacity.result = { kind: "exhausted", limit: 2, booted: 2, retryAfterMs: 5_000 };

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure).toMatchObject({
        code: "capacity_exhausted",
        retryable: true,
        capacity: { limit: 2, booted: 2, retryAfterMs: 5_000 },
      });
      expect(provisioner.calls).toHaveLength(0);
    });

    test("maps a boot-gate capacity refusal from provisioning to capacity_exhausted", async () => {
      provisioner.failWith = () =>
        new BootCapacityExhaustedError(
          { platform: "ios", limit: 1, booted: 1, retryAfterMs: 1_000 },
          "full",
        );

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure.code).toBe("capacity_exhausted");
      expect(result.assignment).toMatchObject({ generation: 0, stableDeviceId: null });
    });

    test("keeps a typed provision capacity_exhausted refusal typed (#11236)", async () => {
      provisioner.failWith = () =>
        new ProvisionDeviceError("capacity_exhausted", "full", true, {
          retryAfterMs: 2_000,
          capacity: { limit: 1, booted: 1 },
        });

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure).toMatchObject({
        code: "capacity_exhausted",
        retryable: true,
        capacity: { limit: 1, booted: 1, retryAfterMs: 2_000 },
      });
    });

    test("discards a created device that never reached automation readiness", async () => {
      provisioner.readinessStatus = "device_ready";

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure.code).toBe("readiness_incomplete");
      expect(provisioner.released).toEqual(["session-1"]);
      expect(deleter.calls.map((call) => call.name)).toEqual([
        managedSlotDeviceName(key, 1, "fake-1"),
      ]);
      expect(result.assignment).toMatchObject({ generation: 0, stableDeviceId: null });
    });
  });

  describe("assigned and matching", () => {
    test("reuses the device with a fresh session and no binding change", async () => {
      const stableId = await seedAssigned();

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("reused");
      expect(result.device.stableId).toBe(stableId);
      expect(result.sessionUuid).toBe("session-2");
      expect(result.assignment.generation).toBe(1);
      expect(provisioner.calls).toEqual([
        expect.objectContaining({ mode: "adopt", deviceId: stableId }),
      ]);
      expect(deleter.calls).toHaveLength(0);
    });

    test("an omitted field stays unconstrained: a changed spec that still matches reuses at generation + 1", async () => {
      const stableId = await seedAssigned();

      const result = expectReady(
        await reconciler.reconcile(request({ ...SPEC_18, displayCutout: "any" })),
      );

      expect(result.disposition).toBe("reused");
      expect(result.device.stableId).toBe(stableId);
      expect(result.assignment.generation).toBe(2);
      expect(result.assignment.requestedSpec).toEqual({ ...SPEC_18, displayCutout: "any" });
    });

    test("an assigned device removed out of band is recreated at generation + 1", async () => {
      const stableId = await seedAssigned();
      inventory.remove(stableId);

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("created");
      expect(result.evidence.assignedMissing).toBe(true);
      expect(result.device.name).toStartWith(managedSlotDeviceName(key, 2, "x").slice(0, -1));
      expect(result.assignment.generation).toBe(2);
      expect(deleter.calls).toHaveLength(0);
    });

    test("an unlisted assigned device under partial inventory is never treated as absent", async () => {
      const stableId = await seedAssigned();
      inventory.remove(stableId);
      inventory.complete = false;

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure.code).toBe("discovery_incomplete");
      expect(provisioner.calls).toHaveLength(0);
      expect(result.assignment).toMatchObject({ generation: 1, stableDeviceId: stableId });
    });

    test("by default an owner whose PID is not running does not hold the slot", async () => {
      const stableId = await seedAssigned();
      await registry.claimExecution(
        key,
        { generation: 1, stableDeviceId: stableId },
        // A non-positive PID is never a running process.
        { daemonId: "d", pid: -1, sessionUuid: "crashed" },
      );
      reconciler = new ManagedSlotReconciler({
        registry,
        inventory,
        matcher,
        resolver: new DefaultManagedSpecResolver(),
        provisioner,
        deleter,
        claims,
        capacity,
        timer,
      });

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("reused");
    });

    test("a slot settling under a live settler refuses slot_settling; a dead settler's slot is recovered and reused", async () => {
      const stableId = await seedAssigned();
      await registry.updateSlotState(key, { generation: 1, stableDeviceId: stableId }, "settling", {
        settler: { daemonId: "d", pid: 300 },
      });

      const busy = expectFailed(await reconciler.reconcile(request()));
      expect(busy.failure).toMatchObject({ code: "slot_settling", retryable: true });
      expect(provisioner.calls).toHaveLength(0);

      registry.setExecOwnerLiveness((owner) => owner.pid !== 300);
      const result = expectReady(await reconciler.reconcile(request()));
      expect(result.disposition).toBe("reused");
      expect(result.assignment).toMatchObject({ generation: 2, state: "ready", settler: null });
    });

    test("a live execution owner refuses with slot_in_use", async () => {
      const stableId = await seedAssigned();
      await registry.claimExecution(
        key,
        { generation: 1, stableDeviceId: stableId },
        { daemonId: "d", pid: 1, sessionUuid: "live" },
      );

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure).toMatchObject({ code: "slot_in_use", retryable: true });
      expect(provisioner.calls).toHaveLength(0);
    });
  });

  describe("fresh session per execution", () => {
    /**
     * The production bind is bind-or-reuse: provisioning a device the pool still holds a session
     * on hands that session back. Model it, with releases removing the session from the pool.
     */
    function bindOrReuse(options: { releaseFails?: boolean; releaseIgnored?: boolean } = {}) {
      const provision = provisioner.provision.bind(provisioner);
      provisioner.provision = async (provisionRequest) => {
        const provisioned = await provision(provisionRequest);
        const held = claims.sessions.get(provisioned.device.stableId)?.[0];
        return held ? { ...provisioned, sessionUuid: held } : provisioned;
      };
      provisioner.releaseSession = async (sessionUuid) => {
        provisioner.released.push(sessionUuid);
        if (options.releaseFails) {
          throw new Error("release failed");
        }
        if (!options.releaseIgnored) {
          for (const [stableId, sessions] of claims.sessions) {
            claims.sessions.set(
              stableId,
              sessions.filter((session) => session !== sessionUuid),
            );
          }
        }
      };
    }

    test("a leaked session on the slot's device is released first; the execution gets a fresh one", async () => {
      const stableId = await seedAssigned();
      claims.sessions.set(stableId, ["leaked-session"]);
      bindOrReuse();

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("reused");
      expect(result.sessionUuid).not.toBe("leaked-session");
      expect(provisioner.released).toEqual(["leaked-session"]);
      expect(result.evidence.releasedStaleSessions).toEqual(["leaked-session"]);
    });

    test("a provision that still hands back the leaked session is refused, never reported ready", async () => {
      const stableId = await seedAssigned();
      claims.sessions.set(stableId, ["leaked-session"]);
      bindOrReuse({ releaseIgnored: true });

      const failed = expectFailed(await reconciler.reconcile(request()));

      expect(failed.failure).toMatchObject({ code: "stale_session", retryable: true });
      expect((await registry.getAssignment(key))?.execOwner ?? null).toBeNull();
    });

    test("a leaked session that cannot be released refuses before provisioning", async () => {
      const stableId = await seedAssigned();
      claims.sessions.set(stableId, ["leaked-session"]);
      bindOrReuse({ releaseFails: true });

      const failed = expectFailed(await reconciler.reconcile(request()));

      expect(failed.failure).toMatchObject({ code: "stale_session", retryable: true });
      expect(provisioner.calls).toEqual([]);
    });

    test("a live execution whose recorded owner died with a restart is refused slot_in_use, never released (#11275)", async () => {
      const stableId = await seedAssigned();
      // The registry names a daemon that restarted; this daemon still holds the session live.
      await registry.claimExecution(
        key,
        { generation: 1, stableDeviceId: stableId },
        { daemonId: "before-restart", pid: 4101, sessionUuid: "live-execution" },
      );
      registry.setExecOwnerLiveness((owner) => owner.pid !== 4101);
      reconciler = new ManagedSlotReconciler({
        registry,
        inventory,
        matcher,
        resolver: new DefaultManagedSpecResolver(),
        provisioner,
        deleter,
        claims,
        capacity,
        timer,
        idGenerator: new FakeIdGenerator(),
        isExecOwnerLive: (owner) => owner.pid !== 4101,
      });
      claims.sessions.set(stableId, ["live-execution"]);
      claims.liveExecutions.add("live-execution");
      bindOrReuse();

      const failed = expectFailed(
        await reconciler.reconcile(
          request(SPEC_18, { owner: { daemonId: "after-restart", pid: 4102 } }),
        ),
      );

      expect(failed.failure).toMatchObject({ code: "slot_in_use", retryable: true });
      expect(provisioner.released).toEqual([]);
      expect(provisioner.calls).toEqual([]);
      expect(claims.sessions.get(stableId)).toEqual(["live-execution"]);
      // Refused before reserving, so the live execution's record is left exactly as it was.
      expect((await registry.getAssignment(key))?.execOwner).toMatchObject({
        sessionUuid: "live-execution",
      });
    });

    test("an orphan leftover someone holds a session on is never adopted", async () => {
      inventory.devices.push({
        name: managedSlotDeviceName(key, 1, "earlier"),
        platform: "ios",
        deviceId: "UDID-LEFTOVER",
        isRunning: true,
        runtime: IOS_18,
        deviceType: IPHONE_16,
      });
      claims.sessions.set("UDID-LEFTOVER", ["generic-session"]);

      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("created");
      expect(result.device.stableId).not.toBe("UDID-LEFTOVER");
      expect(provisioner.released).toEqual([]);
    });
  });

  describe("assigned and not matching", () => {
    test("replaces: deletes and verifies the old device, creates a new one, commits into the same slot", async () => {
      const oldId = await seedAssigned(SPEC_17);

      const result = expectReady(await reconciler.reconcile(request(SPEC_18)));

      expect(result.disposition).toBe("replaced");
      expect(deleter.calls.map((call) => call.stableId)).toEqual([oldId]);
      expect(inventory.has(oldId)).toBe(false);
      expect(result.evidence.deletedStableId).toBe(oldId);
      expect(result.device.stableId).not.toBe(oldId);
      // generation 2 fenced the old device (`replacing`), 3 recorded its verified absence.
      expect(result.device.name).toStartWith(managedSlotDeviceName(key, 4, "x").slice(0, -1));
      expect(result.assignment).toMatchObject({
        generation: 4,
        stableDeviceId: result.device.stableId,
        state: "ready",
      });
    });

    test("a failed deletion keeps the old device bound as cleanup_pending and creates nothing", async () => {
      const oldId = await seedAssigned(SPEC_17);
      deleter.failWith = "simctl delete failed";

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure).toMatchObject({ code: "cleanup_pending", retryable: true });
      expect(result.assignment).toMatchObject({
        generation: 3,
        stableDeviceId: oldId,
        state: "cleanup_pending",
      });
      expect(provisioner.calls).toHaveLength(0);

      // The accepted deletion is journaled: an immediate retry waits out the backoff without
      // repeating it, and the next due retry finishes it and converges (#11179).
      deleter.failWith = undefined;
      const retry = expectFailed(await reconciler.reconcile(request(SPEC_18)));
      expect(retry.failure.code).toBe("cleanup_pending");
      expect(deleter.calls).toHaveLength(1);

      timer.advanceTime(1_000);
      const converged = expectReady(await reconciler.reconcile(request(SPEC_18)));
      expect(deleter.calls.map((call) => call.stableId)).toEqual([oldId, oldId]);
      expect(converged.device.stableId).not.toBe(oldId);
      expect(inventory.has(oldId)).toBe(false);
    });

    test("a thrown deletion is unverified and also leaves cleanup_pending", async () => {
      await seedAssigned(SPEC_17);
      deleter.deleteAndVerifyAbsence = async () => {
        throw new Error("boom");
      };

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure.code).toBe("cleanup_pending");
      expect(result.assignment?.state).toBe("cleanup_pending");
    });

    test("a creation failure after verified deletion leaves an empty provisioning slot the next attempt fills", async () => {
      const oldId = await seedAssigned(SPEC_17);
      provisioner.failWith = (call) =>
        call.mode === "create"
          ? new ProvisionDeviceError("platform_command_failed", "nope")
          : undefined;

      const failed = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(failed.failure).toMatchObject({
        code: "provision_failed",
        provision: { code: "platform_command_failed", retryable: false },
      });
      expect(failed.evidence.deletedStableId).toBe(oldId);
      expect(failed.assignment).toMatchObject({
        generation: 3,
        stableDeviceId: null,
        state: "provisioning",
      });

      provisioner.failWith = undefined;
      const retry = expectReady(await reconciler.reconcile(request(SPEC_18)));
      expect(retry.disposition).toBe("created");
      expect(retry.assignment.generation).toBe(4);
      expect(deleter.calls).toHaveLength(1);
    });

    test("an unreadable configuration is never a mismatch: no deletion", async () => {
      const oldId = await seedAssigned(SPEC_17);
      matcher.overrides.set(oldId, "unknown");

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure.code).toBe("discovery_incomplete");
      expect(deleter.calls).toHaveLength(0);
    });

    test("an unavailable assigned simulator is discovery_incomplete: never deleted or replaced", async () => {
      reconciler = new ManagedSlotReconciler({
        registry,
        inventory,
        matcher: new DefaultManagedSpecMatcher({ readConfig: async () => null }),
        resolver: new DefaultManagedSpecResolver(),
        provisioner,
        deleter,
        claims,
        capacity,
        timer,
      });
      const oldId = await seedAssigned(SPEC_17);
      inventory.devices.find((device) => device.deviceId === oldId)!.isAvailable = false;

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure).toMatchObject({ code: "discovery_incomplete", retryable: true });
      expect(deleter.calls).toHaveLength(0);
      expect(result.assignment).toMatchObject({ stableDeviceId: oldId, state: "ready" });
    });

    test("partial inventory blocks replacement even when the old device is listed", async () => {
      await seedAssigned(SPEC_17);
      inventory.complete = false;

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure.code).toBe("discovery_incomplete");
      expect(deleter.calls).toHaveLength(0);
    });

    test("a live session or foreign claim on the device refuses replacement", async () => {
      const oldId = await seedAssigned(SPEC_17);
      claims.claims.set(oldId, { kind: "held", reason: "owned by another daemon" });

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure).toMatchObject({ code: "device_busy", retryable: true });
      expect(deleter.calls).toHaveLength(0);
      expect(result.assignment?.state).toBe("ready");
    });

    test("an incompatible spec is rejected before the old device is deleted", async () => {
      await seedAssigned(SPEC_17);
      const catalog: ExactIosRuntimeCatalog = {
        getRuntimesChecked: async () => [
          {
            identifier: IOS_18,
            version: "18.0",
            isAvailable: false,
            availabilityError: "runtime missing",
            bundlePath: "",
            buildversion: "",
            runtimeRoot: "",
            name: "iOS 18.0",
          },
        ],
        getDeviceTypesChecked: async () => [
          {
            identifier: IPHONE_16,
            name: "iPhone 16",
            minRuntimeVersion: 0,
            maxRuntimeVersion: 0,
            bundlePath: "",
            productFamily: "iPhone",
          },
        ],
      };
      reconciler = new ManagedSlotReconciler({
        registry,
        inventory,
        matcher,
        resolver: new DefaultManagedSpecResolver(catalog),
        provisioner,
        deleter,
        claims,
        capacity,
        timer,
      });

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure).toMatchObject({ code: "runtime_incompatible", retryable: false });
      expect(deleter.calls).toHaveLength(0);
      expect(result.assignment?.generation).toBe(1);
    });

    test("at the boot limit a stopped old device is not deleted; a running one is replaced", async () => {
      const oldId = await seedAssigned(SPEC_17);
      inventory.devices.find((device) => device.deviceId === oldId)!.isRunning = false;
      capacity.result = { kind: "exhausted", limit: 1, booted: 1, retryAfterMs: 5_000 };

      const stopped = expectFailed(await reconciler.reconcile(request(SPEC_18)));
      expect(stopped.failure.code).toBe("capacity_exhausted");
      expect(deleter.calls).toHaveLength(0);

      inventory.devices.find((device) => device.deviceId === oldId)!.isRunning = true;
      // Deleting the running device frees the boot slot the replacement needs.
      let deleted = false;
      capacity.check = async () =>
        deleted
          ? { kind: "available" }
          : { kind: "exhausted", limit: 1, booted: 1, retryAfterMs: 1 };
      const deleteOld = deleter.deleteAndVerifyAbsence.bind(deleter);
      deleter.deleteAndVerifyAbsence = async (target) => {
        deleted = true;
        return deleteOld(target);
      };
      const running = expectReady(await reconciler.reconcile(request(SPEC_18)));
      expect(running.disposition).toBe("replaced");
    });

    test("a booting or shutting-down old simulator holds the boot slot its replacement takes", async () => {
      for (const state of ["Booting", "Shutting Down"]) {
        const oldId = await seedAssigned(SPEC_17);
        Object.assign(
          inventory.devices.find((device) => device.deviceId === oldId)!,
          {
            isRunning: false,
            state,
          },
        );
        capacity.result = { kind: "exhausted", limit: 1, booted: 1, retryAfterMs: 5_000 };

        const result = expectReady(await reconciler.reconcile(request(SPEC_18)));

        expect(result.disposition).toBe("replaced");
        expect(deleter.calls.at(-1)?.stableId).toBe(oldId);
        capacity.result = { kind: "available" };
      }
    });

    test("a replacement is not refused after the delete while the old device is still counted", async () => {
      const oldId = await seedAssigned(SPEC_17);
      inventory.devices.find((device) => device.deviceId === oldId)!.isRunning = true;
      // The gate keeps counting the deleted device (still shutting down) for the whole attempt.
      capacity.result = { kind: "exhausted", limit: 1, booted: 1, retryAfterMs: 5_000 };
      capacity.checks = 0;

      const result = expectReady(await reconciler.reconcile(request(SPEC_18)));

      expect(result.disposition).toBe("replaced");
      expect(capacity.checks).toBe(1);
      expect(result.device.stableId).not.toBe(oldId);
    });

    test("an unknown booted count never replaces: discovery_incomplete before deleting", async () => {
      const oldId = await seedAssigned(SPEC_17);
      inventory.devices.find((device) => device.deviceId === oldId)!.isRunning = true;
      capacity.result = { kind: "unknown", message: "simulator count unknown" };

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure).toMatchObject({ code: "discovery_incomplete", retryable: true });
      expect(deleter.calls).toHaveLength(0);
      expect(result.assignment).toMatchObject({ stableDeviceId: oldId, state: "ready" });
    });

    test("over the boot limit a running old device is not deleted: one freed slot is not enough", async () => {
      const oldId = await seedAssigned(SPEC_17);
      inventory.devices.find((device) => device.deviceId === oldId)!.isRunning = true;
      capacity.result = { kind: "exhausted", limit: 1, booted: 2, retryAfterMs: 5_000 };

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure).toMatchObject({
        code: "capacity_exhausted",
        capacity: { limit: 1, booted: 2 },
      });
      expect(deleter.calls).toHaveLength(0);
    });

    test("a running device of another platform frees no boot slot: not deleted at the limit", async () => {
      const oldId = await seedAssigned();
      inventory.devices.find((device) => device.deviceId === oldId)!.isRunning = true;
      capacity.result = { kind: "exhausted", limit: 1, booted: 1, retryAfterMs: 5_000 };

      const result = expectFailed(
        await reconciler.reconcile(
          request(
            { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" },
            { platform: "android" },
          ),
        ),
      );

      expect(result.failure.code).toBe("capacity_exhausted");
      expect(deleter.calls).toHaveLength(0);
      expect(result.assignment).toMatchObject({ platform: "ios", stableDeviceId: oldId });
    });

    test("a slot left replacing without a journal entry is redriven: delete finished, slot refilled", async () => {
      const oldId = await seedAssigned(SPEC_17);
      await registry.updateSlotState(key, { generation: 1, stableDeviceId: oldId }, "replacing");

      const result = expectReady(await reconciler.reconcile(request(SPEC_18)));

      expect(deleter.calls.map((call) => call.stableId)).toEqual([oldId]);
      expect(result.evidence.redriven).toEqual([
        expect.objectContaining({ kind: "replace", outcome: "settled" }),
      ]);
      expect(result.device.stableId).not.toBe(oldId);
      expect(await registry.listOpenSlotJournal(key)).toEqual([]);
    });
  });

  describe("compare-and-set races", () => {
    test("a concurrent commit during create loses cleanly: session released, created device removed", async () => {
      provisioner.beforeReturn = async () => {
        // Another process binds the slot while this one is still provisioning.
        await registry.commitBinding(
          key,
          { generation: 0, stableDeviceId: null },
          {
            stableDeviceId: "UDID-WINNER",
            deviceName: "winner",
            resolvedSpec: null,
            specFingerprint: null,
            state: "ready",
          },
        );
      };

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure).toMatchObject({ code: "concurrent_modification", retryable: true });
      expect(provisioner.released).toEqual(["session-1"]);
      expect(result.evidence.uncommittedCleanup).toEqual({ stableId: "UDID-1", removed: true });
      expect(inventory.has("UDID-1")).toBe(false);
      expect(result.assignment).toMatchObject({ generation: 1, stableDeviceId: "UDID-WINNER" });
    });

    test("a losing Android create never deletes the AVD the winner committed under the same id", async () => {
      const androidSpec = {
        runtime: "system-images;android-35;google_apis;arm64-v8a",
        deviceType: "pixel_8",
      };
      provisioner.beforeReturn = async (call) => {
        // The winner committed a device whose stable id (the AVD name) equals ours.
        await registry.commitBinding(
          key,
          { generation: 0, stableDeviceId: null },
          {
            stableDeviceId: call.name,
            deviceName: call.name,
            resolvedSpec: null,
            specFingerprint: null,
            state: "ready",
          },
        );
      };

      const result = expectFailed(
        await reconciler.reconcile(request(androidSpec, { platform: "android" })),
      );

      expect(result.failure.code).toBe("concurrent_modification");
      expect(deleter.calls).toHaveLength(0);
      expect(result.evidence.uncommittedCleanup).toMatchObject({ removed: false });
      expect(inventory.has(result.assignment!.stableDeviceId!)).toBe(true);
    });

    test("two attempts on the same slot and generation never generate the same device name", async () => {
      const first = managedSlotDeviceName(key, 1, "attempt-a");
      const second = managedSlotDeviceName(key, 1, "attempt-b");
      expect(first).not.toBe(second);
      expect(first).toStartWith("amslot-");
      expect(first).toMatch(/^[a-z0-9-]+$/);
    });

    test("a binding change before the replace mark refuses deletion", async () => {
      const oldId = await seedAssigned(SPEC_17);
      claims.beforeDescribe = async () => {
        await registry.updateSlotState(key, { generation: 1, stableDeviceId: oldId }, "ready");
        await registry.commitBinding(
          key,
          { generation: 1, stableDeviceId: oldId },
          {
            stableDeviceId: oldId,
            deviceName: "same",
            resolvedSpec: null,
            specFingerprint: null,
            state: "ready",
          },
        );
      };

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure.code).toBe("concurrent_modification");
      expect(deleter.calls).toHaveLength(0);
      expect(result.assignment).toMatchObject({ generation: 2, stableDeviceId: oldId });
    });

    test("a reuse whose binding changed underneath releases the fresh session", async () => {
      const stableId = await seedAssigned();
      provisioner.beforeReturn = async () => {
        await registry.commitBinding(
          key,
          { generation: 1, stableDeviceId: stableId },
          {
            stableDeviceId: null,
            deviceName: null,
            resolvedSpec: null,
            specFingerprint: null,
            state: "provisioning",
          },
        );
      };

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure.code).toBe("concurrent_modification");
      expect(provisioner.released).toEqual(["session-2"]);
    });

    test("a replacement that fences the slot while a reuse provisions wins: the reuse never reports ready", async () => {
      const stableId = await seedAssigned();
      provisioner.beforeReturn = async () => {
        // Another daemon's replacer marks the slot after this reuse read it as ready.
        const marked = await registry.updateSlotState(
          key,
          { generation: 1, stableDeviceId: stableId },
          "replacing",
        );
        expect(marked.kind).toBe("updated");
      };

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure.code).toBe("concurrent_modification");
      expect(provisioner.released).toEqual(["session-2"]);
      expect(result.assignment).toMatchObject({ generation: 2, state: "replacing" });
    });

    test("an owned reuse reserves the slot before provisioning, so a replacer cannot fence it", async () => {
      const stableId = await seedAssigned();
      const owner = { daemonId: "daemon-a", pid: 4242 };
      let fenceDuringProvision: string | undefined;
      provisioner.beforeReturn = async () => {
        const current = await registry.getAssignment(key);
        expect(current?.execOwner).toMatchObject({ ...owner, sessionUuid: expect.any(String) });
        fenceDuringProvision = (
          await registry.updateSlotState(
            key,
            { generation: 1, stableDeviceId: stableId },
            "replacing",
          )
        ).kind;
      };

      const result = expectReady(await reconciler.reconcile(request(SPEC_18, { owner })));

      expect(fenceDuringProvision).toBe("slot_in_use");
      expect(result.disposition).toBe("reused");
      expect(result.assignment).toMatchObject({
        generation: 1,
        state: "ready",
        execOwner: { ...owner, sessionUuid: "session-2" },
      });
    });

    test("an owned create claims the slot for the provisioned session", async () => {
      const owner = { daemonId: "daemon-a", pid: 4242 };

      const result = expectReady(await reconciler.reconcile(request(SPEC_18, { owner })));

      expect(result.assignment.execOwner).toMatchObject({
        ...owner,
        sessionUuid: result.sessionUuid,
      });
      const again = expectFailed(await reconciler.reconcile(request(SPEC_18, { owner })));
      expect(again.failure.code).toBe("slot_in_use");
    });

    test("a lost reservation releases nothing it did not take and refuses slot_in_use", async () => {
      const stableId = await seedAssigned();
      await registry.claimExecution(
        key,
        { generation: 1, stableDeviceId: stableId },
        { daemonId: "other", pid: 7, sessionUuid: "theirs" },
      );
      registry.setExecOwnerLiveness(() => true);
      reconciler = new ManagedSlotReconciler({
        registry,
        inventory,
        matcher,
        resolver: new DefaultManagedSpecResolver(),
        provisioner,
        deleter,
        claims,
        capacity,
        timer,
        isExecOwnerLive: () => false,
      });

      const result = expectFailed(
        await reconciler.reconcile(request(SPEC_18, { owner: { daemonId: "a", pid: 1 } })),
      );

      expect(result.failure.code).toBe("slot_in_use");
      expect(provisioner.calls).toHaveLength(0);
      expect(result.assignment?.execOwner?.sessionUuid).toBe("theirs");
    });

    test("concurrent reconciliations of one slot in one process serialize onto one device", async () => {
      const [first, second] = await Promise.all([
        reconciler.reconcile(request()),
        reconciler.reconcile(request()),
      ]);

      expect(expectReady(first).disposition).toBe("created");
      expect(expectReady(second).disposition).toBe("reused");
      expect(expectReady(second).device.stableId).toBe(expectReady(first).device.stableId);
      expect(provisioner.created()).toHaveLength(1);
    });
  });

  describe("any model (omitted deviceType)", () => {
    beforeEach(() => {
      reconciler = new ManagedSlotReconciler({
        registry,
        inventory,
        matcher,
        resolver: new DefaultManagedSpecResolver(ANY_MODEL_CATALOG),
        provisioner,
        deleter,
        claims,
        capacity,
        timer,
        idGenerator: new FakeIdGenerator(),
        isExecOwnerLive: () => true,
      });
    });

    test("an empty slot creates the newest iPhone that supports the runtime and records it", async () => {
      const result = expectReady(await reconciler.reconcile(request({ runtime: IOS_17 })));

      expect(result.disposition).toBe("created");
      expect(provisioner.created()[0]?.spec).toMatchObject({
        runtime: IOS_17,
        deviceType: IPHONE_15,
      });
      expect(result.resolvedSpec).toMatchObject({ runtime: IOS_17, deviceType: IPHONE_15 });
      expect(result.assignment.requestedSpec).toEqual({ runtime: IOS_17 });
    });

    test("an assigned simulator of any model on the runtime is reused, never replaced", async () => {
      inventory.devices.push({
        name: managedSlotDeviceName(key, 1, "earlier"),
        platform: "ios",
        deviceId: "UDID-OLD-MODEL",
        isRunning: true,
        runtime: IOS_18,
        deviceType: IPHONE_15,
      });
      const first = expectReady(await reconciler.reconcile(request({ runtime: IOS_18 })));
      expect(first.disposition).toBe("adopted");

      const again = expectReady(await reconciler.reconcile(request({ runtime: IOS_18 })));

      expect(again.disposition).toBe("reused");
      expect(again.device.stableId).toBe("UDID-OLD-MODEL");
      expect(deleter.calls).toHaveLength(0);
    });

    test("a different runtime still replaces an any-model slot", async () => {
      await seedAssigned({ runtime: IOS_17 });

      const result = expectReady(await reconciler.reconcile(request({ runtime: IOS_18 })));

      expect(result.disposition).toBe("replaced");
      expect(result.resolvedSpec.deviceType).toBe(IPHONE_16);
    });
  });

  describe("request validation", () => {
    test("an unsupported spec fails before the slot is even initialised", async () => {
      const result = expectFailed(
        await reconciler.reconcile(
          request({
            ...SPEC_18,
            deviceType: "com.apple.CoreSimulator.SimDeviceType.Unknown",
            displayCutout: "notch",
          }),
        ),
      );

      expect(result.failure).toMatchObject({ code: "spec_unsupported", retryable: false });
      expect(result.assignment).toBeNull();
    });

    test("an invalidated scope refuses", async () => {
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");

      const result = expectFailed(await reconciler.reconcile(request()));

      expect(result.failure.code).toBe("scope_not_valid");
    });

    test("a platform change replaces the device across platforms, journaled (#11232)", async () => {
      const oldId = await seedAssigned();

      const result = expectReady(
        await reconciler.reconcile(
          request(
            { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" },
            { platform: "android" },
          ),
        ),
      );

      expect(result.disposition).toBe("replaced");
      expect(deleter.calls.map((call) => [call.platform, call.stableId])).toEqual([["ios", oldId]]);
      expect(provisioner.created().map((call) => call.platform)).toEqual(["android"]);
      expect(result.assignment).toMatchObject({
        platform: "android",
        stableDeviceId: result.device.stableId,
        state: "ready",
      });
      expect(await registry.findDeviceHolder("ios", oldId)).toBeNull();
      expect(result.evidence).toMatchObject({
        assignedMatch: "mismatch",
        deletedStableId: oldId,
        journal: { kind: "replace", phase: "committed" },
      });
      const entry = await registry.getSlotJournal(result.evidence.journal!.entryId);
      expect(entry).toMatchObject({
        kind: "replace",
        platform: "ios",
        target: { oldStableId: oldId, newPlatform: "android", newStableId: result.device.stableId },
      });
    });

    test("a platform change keeps the old device when its deletion fails", async () => {
      const oldId = await seedAssigned();
      deleter.failWith = "simctl delete failed";

      const result = expectFailed(
        await reconciler.reconcile(
          request(
            { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" },
            { platform: "android" },
          ),
        ),
      );

      expect(result.failure.code).toBe("cleanup_pending");
      expect(result.assignment).toMatchObject({
        platform: "ios",
        stableDeviceId: oldId,
        state: "cleanup_pending",
      });
      expect(provisioner.created()).toEqual([]);
    });

    test("a platform change of an out-of-band-removed device creates on the new platform", async () => {
      const oldId = await seedAssigned();
      inventory.remove(oldId);

      const result = expectReady(
        await reconciler.reconcile(
          request(
            { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" },
            { platform: "android" },
          ),
        ),
      );

      expect(result.disposition).toBe("created");
      expect(deleter.calls).toEqual([]);
      expect(result.assignment.platform).toBe("android");
    });

    test("a platform change never deletes on incomplete discovery", async () => {
      await seedAssigned();
      inventory.complete = false;

      const result = expectFailed(
        await reconciler.reconcile(
          request(
            { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" },
            { platform: "android" },
          ),
        ),
      );

      expect(result.failure.code).toBe("discovery_incomplete");
      expect(deleter.calls).toEqual([]);
    });

    test("an expired deadline does nothing", async () => {
      const result = expectFailed(
        await reconciler.reconcile(request(SPEC_18, { deadlineMs: timer.now() })),
      );

      expect(result.failure.code).toBe("timeout");
      expect(result.assignment).toBeNull();
    });
  });
});

describe("DefaultManagedSpecMatcher", () => {
  const runtime = "system-images;android-35;google_apis;arm64-v8a";
  const parsed = parseAndroidSystemImageRuntime(runtime)!;
  const baseConfig: AvdConfig = {
    apiLevel: parsed.apiLevel,
    tag: parsed.tag,
    architecture: parsed.architecture,
    systemImagePackage: parsed.systemImagePackage,
    deviceName: "pixel_8",
    ramSizeMb: 4096,
  };
  const avd: DeviceInfo = { name: "amslot-x", platform: "android", isRunning: false };

  function matcherFor(config: AvdConfig | null | Error) {
    return new DefaultManagedSpecMatcher({
      readConfig: async () => {
        if (config instanceof Error) {
          throw config;
        }
        return config;
      },
    });
  }

  test("an omitted Android profile or iOS model is unconstrained", async () => {
    expect(await matcherFor(baseConfig).matches(avd, { runtime })).toBe("match");
    expect(
      await matcherFor({ ...baseConfig, deviceName: undefined }).matches(avd, { runtime }),
    ).toBe("match");
    expect(
      await matcherFor(baseConfig).matches(avd, {
        runtime: "system-images;android-34;google_apis;arm64-v8a",
      }),
    ).toBe("mismatch");
    const sim: DeviceInfo = {
      name: "s",
      platform: "ios",
      deviceId: "U",
      isRunning: false,
      runtime: IOS_18,
      deviceType: IPHONE_15,
    };
    expect(await matcherFor(null).matches(sim, { runtime: IOS_18 })).toBe("match");
    expect(
      await matcherFor(null).matches({ ...sim, deviceType: undefined }, { runtime: IOS_18 }),
    ).toBe("match");
    expect(await matcherFor(null).matches(sim, { runtime: IOS_17 })).toBe("mismatch");
  });

  test("omitted configuration is unconstrained", async () => {
    expect(await matcherFor(baseConfig).matches(avd, { runtime, deviceType: "pixel_8" })).toBe(
      "match",
    );
  });

  test("an explicit configuration value is binding", async () => {
    const spec = { runtime, deviceType: "pixel_8", configuration: { memoryMb: 2048 } };
    expect(await matcherFor(baseConfig).matches(avd, spec)).toBe("mismatch");
  });

  test("a different image is a mismatch", async () => {
    const spec = {
      runtime: "system-images;android-34;google_apis;arm64-v8a",
      deviceType: "pixel_8",
    };
    expect(await matcherFor(baseConfig).matches(avd, spec)).toBe("mismatch");
  });

  test("a missing or unreadable config is unknown, never a mismatch", async () => {
    const spec = { runtime, deviceType: "pixel_8" };
    expect(await matcherFor(null).matches(avd, spec)).toBe("unknown");
    expect(await matcherFor(new Error("EACCES")).matches(avd, spec)).toBe("unknown");
  });

  test("an iOS simulator without listed runtime metadata is unknown", async () => {
    const sim: DeviceInfo = { name: "s", platform: "ios", deviceId: "U", isRunning: false };
    expect(await matcherFor(null).matches(sim, SPEC_18)).toBe("unknown");
    expect(
      await matcherFor(null).matches({ ...sim, runtime: IOS_18, deviceType: IPHONE_16 }, SPEC_18),
    ).toBe("match");
  });

  test("an unavailable iOS simulator is unknown, never a mismatch, even with matching metadata", async () => {
    const sim: DeviceInfo = {
      name: "s",
      platform: "ios",
      deviceId: "U",
      isRunning: false,
      isAvailable: false,
      runtime: IOS_17,
      deviceType: IPHONE_16,
    };
    expect(await matcherFor(null).matches(sim, SPEC_18)).toBe("unknown");
    expect(await matcherFor(null).matches({ ...sim, runtime: IOS_18 }, SPEC_18)).toBe("unknown");
  });
});

describe("DefaultManagedSpecResolver any model", () => {
  test("chooses the newest supporting iPhone, never an iPad or an out-of-range model", () => {
    const runtimes = [runtime(IOS_17, "17.5"), runtime(IOS_18, "18.0", false)];
    const types = [
      deviceType(IPHONE_OLD, "iPhone", "11.0", "16.4"),
      deviceType(IPHONE_15, "iPhone", "17.0", "65535.255.255"),
      deviceType(IPAD, "iPad", "17.0", "65535.255.255"),
    ];
    expect(chooseIosDeviceType(IOS_17, runtimes, types)).toBe(IPHONE_15);
    expect(chooseIosDeviceType(IOS_18, runtimes, types)).toBeUndefined();
    expect(chooseIosDeviceType("missing", runtimes, types)).toBeUndefined();
  });

  test("iOS without a catalog, with an unreadable one, or with no fitting model refuses", async () => {
    expect(
      await new DefaultManagedSpecResolver().resolve("ios", { runtime: IOS_18 }, {}),
    ).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
    const unreadable: ExactIosRuntimeCatalog = {
      getRuntimesChecked: async () => {
        throw new Error("simctl timed out");
      },
      getDeviceTypesChecked: async () => [],
    };
    expect(
      await new DefaultManagedSpecResolver(unreadable).resolve("ios", { runtime: IOS_18 }, {}),
    ).toMatchObject({ kind: "unresolved" });
    // The runtime is installed but no listed iPhone supports it: a model/runtime incompatibility.
    expect(
      await new DefaultManagedSpecResolver({
        getRuntimesChecked: async () => [runtime(IOS_9, "9.0")],
        getDeviceTypesChecked: ANY_MODEL_CATALOG.getDeviceTypesChecked,
      }).resolve("ios", { runtime: IOS_9 }, {}),
    ).toMatchObject({ kind: "unsupported", code: "runtime_incompatible" });
  });

  test("malformed or uninstalled iOS runtimes are spec_unsupported, as on Android (#11271)", async () => {
    const resolver = new DefaultManagedSpecResolver(ANY_MODEL_CATALOG);
    // Malformed: not a CoreSimulator runtime identifier (Android's malformed image id is the same).
    for (const spec of [
      { runtime: "android-36" },
      { runtime: "android-36", deviceType: IPHONE_16 },
    ]) {
      const malformed = await resolver.resolve("ios", spec, {});
      expect(malformed).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
      expect((malformed as { message: string }).message).toContain("android-36");
    }
    expect(
      await new DefaultManagedSpecResolver().resolve("ios", { runtime: "android-36" }, {}),
    ).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
    // Well formed but not installed, with or without a model (Android's uninstalled image too).
    for (const spec of [{ runtime: IOS_9 }, { runtime: IOS_9, deviceType: IPHONE_16 }]) {
      const missing = await resolver.resolve("ios", spec, {});
      expect(missing).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
      expect((missing as { message: string }).message).toContain(IOS_18);
    }
    // Installed but unavailable, or out of the model's range: runtime_incompatible.
    const unavailable = new DefaultManagedSpecResolver({
      getRuntimesChecked: async () => [runtime(IOS_18, "18.0", false)],
      getDeviceTypesChecked: ANY_MODEL_CATALOG.getDeviceTypesChecked,
    });
    expect(await unavailable.resolve("ios", SPEC_18, {})).toMatchObject({
      kind: "unsupported",
      code: "runtime_incompatible",
    });
    expect(
      await resolver.resolve("ios", { runtime: IOS_18, deviceType: IPHONE_OLD }, {}),
    ).toMatchObject({ kind: "unsupported", code: "runtime_incompatible" });
  });

  test("an Android image that is not installed is a typed spec_unsupported, not avdmanager text (#11268)", async () => {
    const installed = "system-images;android-35;google_apis;arm64-v8a";
    const resolver = new DefaultManagedSpecResolver(undefined, {
      androidImageCatalog: { listInstalledPackages: async () => [installed] },
    });
    const missing = await resolver.resolve(
      "android",
      { runtime: "system-images;android-99;google_apis;arm64-v8a" },
      {},
    );
    expect(missing).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
    expect((missing as { message: string }).message).toContain("android-99");
    expect(await resolver.resolve("android", { runtime: installed }, {})).toMatchObject({
      kind: "resolved",
    });
    const unreadable = new DefaultManagedSpecResolver(undefined, {
      androidImageCatalog: {
        listInstalledPackages: async () => {
          throw new Error("avdmanager timed out");
        },
      },
    });
    expect(await unreadable.resolve("android", { runtime: installed }, {})).toMatchObject({
      kind: "resolved",
    });
  });

  test("an iOS device type the simulator catalog does not list is a typed spec_unsupported (#11271)", async () => {
    const resolver = new DefaultManagedSpecResolver(ANY_MODEL_CATALOG);
    const nonexistent = "com.apple.CoreSimulator.SimDeviceType.iPhone-99-Nonexistent";
    const missing = await resolver.resolve("ios", { runtime: IOS_18, deviceType: nonexistent }, {});
    expect(missing).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
    expect((missing as { message: string }).message).toContain(nonexistent);
    expect((missing as { message: string }).message).toContain(IPHONE_16);
    expect(await resolver.resolve("ios", SPEC_18, {})).toMatchObject({ kind: "resolved" });
    // An unreadable catalog is not proof the type is missing; simctl stays the authority.
    const unreadable = new DefaultManagedSpecResolver({
      getRuntimesChecked: ANY_MODEL_CATALOG.getRuntimesChecked,
      getDeviceTypesChecked: async () => {
        throw new Error("simctl timed out");
      },
    });
    expect(
      await unreadable.resolve("ios", { runtime: IOS_18, deviceType: nonexistent }, {}),
    ).toMatchObject({ kind: "resolved" });
  });

  test("a cutout preference needs an explicit model; 'any' does not", async () => {
    const resolver = new DefaultManagedSpecResolver(ANY_MODEL_CATALOG);
    expect(
      await resolver.resolve("ios", { runtime: IOS_18, displayCutout: "notch" }, {}),
    ).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
    expect(
      await resolver.resolve("ios", { runtime: IOS_18, displayCutout: "any" }, {}),
    ).toMatchObject({ kind: "resolved", resolvedSpec: { deviceType: IPHONE_16 } });
  });

  test("Android resolves the default profile, or the configured one", async () => {
    const runtime35 = "system-images;android-35;google_apis;arm64-v8a";
    expect(
      await new DefaultManagedSpecResolver().resolve("android", { runtime: runtime35 }, {}),
    ).toMatchObject({ kind: "resolved", resolvedSpec: { deviceType: "pixel_8" } });
    expect(
      await new DefaultManagedSpecResolver(undefined, {
        androidDefaultDeviceType: "pixel_9",
      }).resolve("android", { runtime: runtime35 }, {}),
    ).toMatchObject({ kind: "resolved", resolvedSpec: { deviceType: "pixel_9" } });
  });
});

describe("DefaultManagedSpecResolver", () => {
  test("rejects a malformed Android runtime and records the resolved cutout otherwise", async () => {
    const resolver = new DefaultManagedSpecResolver();
    expect(
      await resolver.resolve("android", { runtime: "android-35", deviceType: "pixel_8" }, {}),
    ).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
    const resolved = await resolver.resolve("ios", SPEC_18, {});
    expect(resolved).toMatchObject({
      kind: "resolved",
      resolvedSpec: { ...SPEC_18, displayCutout: expect.any(String) },
      fingerprint: { version: 1, hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
  });

  test("fingerprints ignore key order and change with any constraint", async () => {
    const resolver = new DefaultManagedSpecResolver();
    const a = await resolver.resolve("ios", { runtime: IOS_18, deviceType: IPHONE_16 }, {});
    const b = await resolver.resolve("ios", { deviceType: IPHONE_16, runtime: IOS_18 }, {});
    const c = await resolver.resolve("ios", SPEC_17, {});
    if (a.kind !== "resolved" || b.kind !== "resolved" || c.kind !== "resolved") {
      throw new Error("expected resolved");
    }
    expect(a.fingerprint).toEqual(b.fingerprint);
    expect(a.fingerprint).not.toEqual(c.fingerprint);
  });
});
