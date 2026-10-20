import { describe, expect, test } from "bun:test";
import {
  BindingReconciler,
  DefaultManagedSpecResolver,
  type BindingReconcileRequest,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { GateBindingBootCapacity } from "../../../../src/daemon/sessionBroker/provisioning/GateBindingBootCapacity";
import { AndroidBootAdmissionGate } from "../../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import {
  IosSimCapacityGate,
  assertCapacityGranted,
} from "../../../../src/features/iosSimFleet/CapacityGate";
import { IosSimFleetCostCollector } from "../../../../src/features/iosSimFleet/FleetCostCollector";
import { InMemoryBootDurationHistory } from "../../../../src/features/iosSimFleet/BootDurationHistory";
import { BootCapacityExhaustedError } from "../../../../src/models/BootCapacityExhaustedError";
import type { Platform } from "../../../../src/models/Platform";
import { FakeAndroidCapacitySource } from "../../../fakes/FakeAndroidCapacitySource";
import { FakeFleetHostSource } from "../../../fakes/FakeFleetHostSource";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

async function setup(platform: Platform) {
  const timer = new FakeTimer();
  const registry = new FakeBindingRegistry(timer);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  const deleter = new FakeDeleter(inventory);
  const androidSource = new FakeAndroidCapacitySource();
  const iosSource = new FakeFleetHostSource();
  iosSource.snapshot = {
    takenAtMs: 0,
    resources: {
      totalMemoryBytes: 64 * 1024 ** 3,
      cpuCount: 16,
      memoryPressure: "normal",
      loadAverage1m: null,
    },
    processes: [],
  };
  const gate =
    platform === "android"
      ? new AndroidBootAdmissionGate(androidSource, timer, {
          env: { AUTOMOBILE_ANDROID_MAX_BOOTED: "2" },
        })
      : new IosSimCapacityGate(
          new IosSimFleetCostCollector(iosSource, new InMemoryBootDurationHistory(), timer),
          timer,
          { env: { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" } },
        );
  const setBooted = (ids: string[]) => {
    androidSource.emulatorSerials = ids;
    iosSource.inventory = ids.map((udid) => ({
      udid,
      name: udid,
      state: "Booted",
      runtime: "iOS-18",
      isAvailable: true,
    }));
  };
  const boot = async (id: string, fail = false) => {
    if (gate instanceof AndroidBootAdmissionGate) {
      const admission = await gate.admit({ timeoutMs: 60_000, avdName: id });
      try {
        if (fail) {
          throw new Error("spawn failed");
        }
        setBooted(["OTHER", id]);
        admission.handOff(id);
      } finally {
        admission.release();
      }
    } else {
      const admission = await gate.admitBoot(undefined, { bootUdid: id });
      assertCapacityGranted(admission);
      try {
        if (fail) {
          throw new Error("boot failed");
        }
        setBooted(["OTHER", id]);
      } finally {
        admission.releaseAdmission?.(fail ? { bootFailed: true } : undefined);
      }
    }
  };
  const capacity = new GateBindingBootCapacity(
    timer,
    () => gate.assertCapacityAvailable(),
    (_target, options) => gate.reserveBoot(options),
  );
  const reconciler = new BindingReconciler({
    registry,
    inventory,
    provisioner,
    deleter,
    claims: new FakeClaims(),
    matcher: new FakeMatcher(),
    resolver: new DefaultManagedSpecResolver(),
    capacity,
    timer,
    idGenerator: new FakeIdGenerator(),
    isExecOwnerLive: () => true,
  });
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace: "test",
    runnerIncarnation: "inc",
  });
  if (scope.kind !== "ready") {
    throw new Error("scope not ready");
  }
  const runtime =
    platform === "ios"
      ? "com.apple.CoreSimulator.SimRuntime.iOS-18-0"
      : "system-images;android-35;google_apis;arm64-v8a";
  const oldSpec = {
    runtime,
    deviceType: platform === "ios" ? "com.apple.CoreSimulator.SimDeviceType.iPhone-15" : "pixel_8",
  };
  const request: BindingReconcileRequest = {
    key: { scopeKey: scope.scope.scopeKey, bindingIndex: 0 },
    role: "app",
    platform,
    requestedSpec: oldSpec,
    deadlineMs: 60_000,
  };
  const first = await reconciler.reconcile(request);
  if (first.outcome !== "ready") {
    throw new Error(`seed failed: ${JSON.stringify(first)}`);
  }
  const old = inventory.devices[0];
  old.deviceId = platform === "ios" ? first.device.stableId : "emulator-5554";
  setBooted([old.deviceId, "OTHER"]);
  request.requestedSpec = {
    runtime,
    deviceType: platform === "ios" ? "com.apple.CoreSimulator.SimDeviceType.iPhone-16" : "pixel_9",
  };
  provisioner.beforeCreate = async () => {
    // The real provision path probes before creating, then admits at the native boot boundary.
    await gate.assertCapacityAvailable();
    await boot("REPLACEMENT");
  };
  return {
    timer,
    registry,
    inventory,
    provisioner,
    deleter,
    gate,
    boot,
    setBooted,
    reconciler,
    request,
    old,
  };
}

for (const platform of ["ios", "android"] as const) {
  describe(`${platform} binding replacement boot reservation`, () => {
    test("race: concurrent boot during delete is refused and A ends with a device", async () => {
      const h = await setup(platform);
      let concurrentError: unknown;
      h.deleter.afterDelete = async () => {
        h.setBooted(["OTHER"]);
        try {
          await h.boot("B");
        } catch (error) {
          concurrentError = error;
        }
      };
      const result = await h.reconciler.reconcile(h.request);
      expect(result.outcome).toBe("ready");
      expect(concurrentError).toBeInstanceOf(BootCapacityExhaustedError);
      if (result.outcome === "ready") {
        expect(result.disposition).toBe("replaced");
        expect(result.device.stableId).not.toBe(h.old.deviceId);
        expect((await h.registry.getAssignment(h.request.key))?.stableDeviceId).toBe(
          result.device.stableId,
        );
      }
      expect((await h.gate.describeCapacity()).inFlight).toBe(0);
    });

    test("replacement resolves a running image without a transport id before reserving", async () => {
      const h = await setup(platform);
      const runtimeId = h.old.deviceId;
      h.old.deviceId = undefined;
      // Android image inventory carries the AVD name; runtime discovery supplies its serial.
      if (platform === "ios") {
        h.old.deviceId = runtimeId;
      }
      let lookups = 0;
      h.inventory.runtimeDeviceId = async () => {
        lookups += 1;
        return runtimeId;
      };
      h.deleter.afterDelete = async () => h.setBooted(["OTHER"]);
      const result = await h.reconciler.reconcile(h.request);
      expect(result.outcome).toBe("ready");
      expect(lookups).toBe(platform === "android" ? 1 : 0);
    });

    test("delete failure releases its reservation", async () => {
      const h = await setup(platform);
      h.deleter.failWith = "delete failed";
      expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
      expect((await h.gate.describeCapacity()).inFlight).toBe(0);
      h.setBooted(["OTHER"]);
      await h.boot("LATER");
    });

    test("cancellation mid-delete releases its reservation", async () => {
      const h = await setup(platform);
      const controller = new AbortController();
      h.request.signal = controller.signal;
      h.deleter.beforeDelete = async () => {
        controller.abort();
        controller.signal.throwIfAborted();
      };
      expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
      expect((await h.gate.describeCapacity()).inFlight).toBe(0);
      h.setBooted(["OTHER"]);
      await h.boot("LATER");
    });

    test("provision failure before admission releases its reservation", async () => {
      const h = await setup(platform);
      h.deleter.afterDelete = async () => h.setBooted(["OTHER"]);
      h.provisioner.beforeCreate = async () => {
        throw new Error("admission setup failed");
      };
      expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
      expect((await h.gate.describeCapacity()).inFlight).toBe(0);
      await h.boot("LATER");
    });

    test("failed boot after consumption releases its admission", async () => {
      const h = await setup(platform);
      h.deleter.afterDelete = async () => h.setBooted(["OTHER"]);
      h.provisioner.beforeCreate = async () => h.boot("REPLACEMENT", true);
      expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
      expect((await h.gate.describeCapacity()).inFlight).toBe(0);
      await h.boot("LATER");
    });

    test("no reservation capacity refuses before deletion", async () => {
      const h = await setup(platform);
      h.setBooted([h.old.deviceId!, "OTHER", "EXCESS"]);
      const result = await h.reconciler.reconcile(h.request);
      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") {
        expect(result.failure.code).toBe("capacity_exhausted");
      }
      expect(h.deleter.calls).toHaveLength(0);
    });
  });
}
