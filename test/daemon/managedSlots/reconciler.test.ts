import { beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  deviceStableId,
  encodeManagedSpecFingerprint,
  managedSlotDeviceName,
  type ManagedSlotBootCapacity,
  type ManagedSlotCapacityCheck,
  type ManagedSlotDeletionResult,
  type ManagedSlotDeletionTarget,
  type ManagedSlotDeviceClaim,
  type ManagedSlotDeviceClaims,
  type ManagedSlotDeviceDeleter,
  type ManagedSlotDeviceProvisioner,
  type ManagedSlotInventory,
  type ManagedSlotInventorySnapshot,
  type ManagedSlotProvisionRequest,
  type ManagedSlotProvisionedDevice,
  type ManagedSlotReconcileRequest,
  type ManagedSlotReconcileResult,
  type ManagedSpecMatch,
  type ManagedSpecMatcher,
} from "../../../src/daemon/managedSlots/reconciler";
import type { SlotKey, SlotPlatform } from "../../../src/daemon/managedSlots/slotRegistry";
import {
  ProvisionDeviceError,
  type ExactDeviceSpecification,
  type ExactIosRuntimeCatalog,
} from "../../../src/devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../src/models";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import type { AvdConfig } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../../../src/utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IOS_17 = "com.apple.CoreSimulator.SimRuntime.iOS-17-5";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const SPEC_18: ExactDeviceSpecification = { runtime: IOS_18, deviceType: IPHONE_16 };
const SPEC_17: ExactDeviceSpecification = { runtime: IOS_17, deviceType: IPHONE_16 };

class FakeInventory implements ManagedSlotInventory {
  complete = true;
  devices: DeviceInfo[] = [];
  async list(platform: SlotPlatform): Promise<ManagedSlotInventorySnapshot> {
    return {
      complete: this.complete,
      devices: this.devices.filter((device) => device.platform === platform),
    };
  }
  has(stableId: string): boolean {
    return this.devices.some((device) => deviceStableId(device) === stableId);
  }
  remove(stableId: string): void {
    this.devices = this.devices.filter((device) => deviceStableId(device) !== stableId);
  }
}

/** iOS-style matching on listed runtime/device type; overrides force a verdict per stable id. */
class FakeMatcher implements ManagedSpecMatcher {
  readonly overrides = new Map<string, ManagedSpecMatch>();
  async matches(device: DeviceInfo, spec: ExactDeviceSpecification): Promise<ManagedSpecMatch> {
    const override = this.overrides.get(deviceStableId(device) ?? "");
    if (override) {
      return override;
    }
    return device.runtime === spec.runtime && device.deviceType === spec.deviceType
      ? "match"
      : "mismatch";
  }
}

class FakeProvisioner implements ManagedSlotDeviceProvisioner {
  readonly calls: ManagedSlotProvisionRequest[] = [];
  readonly released: string[] = [];
  failWith: ((request: ManagedSlotProvisionRequest) => unknown) | undefined;
  /** Runs after the device exists but before the result returns (race injection). */
  beforeReturn: ((request: ManagedSlotProvisionRequest) => Promise<void>) | undefined;
  readinessStatus = "automation_ready";
  private nextUdid = 1;
  private nextSession = 1;

  constructor(private readonly inventory: FakeInventory) {}

  async provision(request: ManagedSlotProvisionRequest): Promise<ManagedSlotProvisionedDevice> {
    this.calls.push(request);
    const failure = this.failWith?.(request);
    if (failure) {
      throw failure;
    }
    let device: DeviceInfo | undefined;
    if (request.mode === "adopt") {
      device = this.inventory.devices.find((entry) =>
        request.deviceId ? entry.deviceId === request.deviceId : entry.name === request.name,
      );
      if (!device) {
        throw new ProvisionDeviceError("identity_conflict", `no device ${request.name}`);
      }
    } else {
      device = {
        name: request.name,
        platform: request.platform,
        isRunning: true,
        runtime: request.spec.runtime,
        deviceType: request.spec.deviceType,
        ...(request.platform === "ios" ? { deviceId: `UDID-${this.nextUdid++}` } : {}),
      };
      this.inventory.devices.push(device);
    }
    device.isRunning = true;
    await this.beforeReturn?.(request);
    const stableId = deviceStableId(device)!;
    return {
      device: {
        stableId,
        transportId: device.deviceId ?? `emulator-${stableId}`,
        name: device.name,
      },
      created: request.mode === "create",
      sessionUuid: `session-${this.nextSession++}`,
      readiness: { mode: "automation", status: this.readinessStatus },
    };
  }

  async releaseSession(sessionUuid: string): Promise<void> {
    this.released.push(sessionUuid);
  }

  created(): ManagedSlotProvisionRequest[] {
    return this.calls.filter((call) => call.mode === "create");
  }
}

class FakeDeleter implements ManagedSlotDeviceDeleter {
  readonly calls: ManagedSlotDeletionTarget[] = [];
  failWith: string | undefined;
  constructor(private readonly inventory: FakeInventory) {}
  async deleteAndVerifyAbsence(
    target: ManagedSlotDeletionTarget,
  ): Promise<ManagedSlotDeletionResult> {
    this.calls.push(target);
    if (this.failWith) {
      return { kind: "failed", message: this.failWith };
    }
    this.inventory.remove(target.stableId);
    return { kind: "absent", evidence: { verified: true } };
  }
}

class FakeClaims implements ManagedSlotDeviceClaims {
  readonly claims = new Map<string, ManagedSlotDeviceClaim>();
  beforeDescribe: (() => Promise<void>) | undefined;
  async describe(device: DeviceInfo): Promise<ManagedSlotDeviceClaim> {
    await this.beforeDescribe?.();
    return this.claims.get(deviceStableId(device) ?? "") ?? { kind: "free" };
  }
}

class FakeCapacity implements ManagedSlotBootCapacity {
  result: ManagedSlotCapacityCheck = { kind: "available" };
  checks = 0;
  async check(): Promise<ManagedSlotCapacityCheck> {
    this.checks += 1;
    return this.result;
  }
}

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

  describe("empty slot", () => {
    test("creates a device under the generated name and commits it ready at generation 1", async () => {
      const result = expectReady(await reconciler.reconcile(request()));

      expect(result.disposition).toBe("created");
      expect(result.device.name).toBe(managedSlotDeviceName(key, 1));
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
          name: managedSlotDeviceName(key, 1),
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
        name: managedSlotDeviceName(key, 1),
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
      expect(deleter.calls.map((call) => call.name)).toEqual([managedSlotDeviceName(key, 1)]);
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
      expect(result.device.name).toBe(managedSlotDeviceName(key, 2));
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

  describe("assigned and not matching", () => {
    test("replaces: deletes and verifies the old device, creates a new one, commits into the same slot", async () => {
      const oldId = await seedAssigned(SPEC_17);

      const result = expectReady(await reconciler.reconcile(request(SPEC_18)));

      expect(result.disposition).toBe("replaced");
      expect(deleter.calls.map((call) => call.stableId)).toEqual([oldId]);
      expect(inventory.has(oldId)).toBe(false);
      expect(result.evidence.deletedStableId).toBe(oldId);
      expect(result.device.stableId).not.toBe(oldId);
      expect(result.device.name).toBe(managedSlotDeviceName(key, 3));
      expect(result.assignment).toMatchObject({
        generation: 3,
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
        generation: 1,
        stableDeviceId: oldId,
        state: "cleanup_pending",
      });
      expect(provisioner.calls).toHaveLength(0);

      deleter.failWith = undefined;
      const retry = expectFailed(await reconciler.reconcile(request(SPEC_18)));
      expect(retry.failure.code).toBe("cleanup_pending");
      expect(deleter.calls).toHaveLength(1);
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
        generation: 2,
        stableDeviceId: null,
        state: "provisioning",
      });

      provisioner.failWith = undefined;
      const retry = expectReady(await reconciler.reconcile(request(SPEC_18)));
      expect(retry.disposition).toBe("created");
      expect(retry.assignment.generation).toBe(3);
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

    test("an interrupted replacement is left for journal redrive, never guessed at", async () => {
      const oldId = await seedAssigned(SPEC_17);
      await registry.updateSlotState(key, { generation: 1, stableDeviceId: oldId }, "replacing");

      const result = expectFailed(await reconciler.reconcile(request(SPEC_18)));

      expect(result.failure.code).toBe("reconcile_in_progress");
      expect(deleter.calls).toHaveLength(0);
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

    test("a slot keeps its platform", async () => {
      await seedAssigned();

      const result = expectFailed(
        await reconciler.reconcile(
          request(
            { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" },
            { platform: "android" },
          ),
        ),
      );

      expect(result.failure.code).toBe("slot_platform_conflict");
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
