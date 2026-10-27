import { describe, expect, test } from "bun:test";
import {
  BindingReconciler,
  DefaultManagedSpecResolver,
  type BindingReconcileRequest,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import {
  BOOT_CAPACITY_CHECK_TIMEOUT_MS,
  GateBindingBootCapacity,
} from "../../../../src/daemon/sessionBroker/provisioning/GateBindingBootCapacity";
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
  FakeHostBootAdmissionRegistry,
  SharedBootAdmissionHostState,
} from "../../../fakes/FakeHostBootAdmissionRegistry";
import { drainMicrotasks, drainUntil } from "../../../helpers/fakeTimerStepping";
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
  const host = new SharedBootAdmissionHostState();
  const hostRegistry = new FakeHostBootAdmissionRegistry(host, 100, timer);
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
          hostRegistry,
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
    host,
    hostRegistry,
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
        if (platform === "android") {
          expect(result.failure.capacity?.booted).toBe(3);
          expect(result.failure.message).toContain("3");
        }
      }
      expect(h.deleter.calls).toHaveLength(0);
    });
  });
}

test("Android serial reuse cannot hide the replacement's held slot before consumption", async () => {
  const h = await setup("android");
  if (!(h.gate instanceof AndroidBootAdmissionGate)) {
    throw new Error("expected Android gate");
  }
  h.setBooted(["emulator-5554"]);
  const bootB = await h.gate.admit({ avdName: "B", timeoutMs: 60_000 });
  h.deleter.afterDelete = async () => {
    // B was admitted before reservation; deleting OLD frees its lowest console port for B.
    h.setBooted(["emulator-5554"]);
    bootB.handOff("emulator-5554");
    bootB.release();
  };
  h.provisioner.beforeCreate = async () => {
    expect(await h.gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 1 });
    await h.boot("REPLACEMENT");
  };
  expect((await h.reconciler.reconcile(h.request)).outcome).toBe("ready");
});

test("Android provision failure after consumption retains an unlisted handed-off boot", async () => {
  const h = await setup("android");
  if (!(h.gate instanceof AndroidBootAdmissionGate)) {
    throw new Error("expected Android gate");
  }
  const gate = h.gate;
  let release = () => {};
  h.deleter.afterDelete = async () => h.setBooted(["OTHER"]);
  h.provisioner.beforeCreate = async () => {
    const admission = await gate.admit({ avdName: "REPLACEMENT", timeoutMs: 60_000 });
    admission.handOff("emulator-5556");
    release = admission.release;
    throw new Error("readiness failed after spawn");
  };
  expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
  expect(await gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 1 });
  await expect(gate.admit({ avdName: "C", timeoutMs: 60_000 })).rejects.toBeInstanceOf(
    BootCapacityExhaustedError,
  );
  h.timer.advanceTime(60_000);
  expect((await gate.describeCapacity()).inFlight).toBe(0);
  release();
});

test("Android runtime lookup is bounded before deletion and ignores a late serial", async () => {
  const h = await setup("android");
  h.old.deviceId = undefined;
  let lookupStarted = false;
  let lookupSignal: AbortSignal | undefined;
  let resolve: (serial: string) => void = () => {};
  h.inventory.runtimeDeviceId = async (_device, options) => {
    lookupStarted = true;
    lookupSignal = options.signal;
    return await new Promise<string>((done) => {
      resolve = done;
    });
  };
  let result: Awaited<ReturnType<typeof h.reconciler.reconcile>> | undefined;
  const pending = h.reconciler.reconcile(h.request).then((value) => {
    result = value;
    return value;
  });
  await drainUntil(() => lookupStarted, { description: "runtime lookup" });
  h.timer.advanceTime(BOOT_CAPACITY_CHECK_TIMEOUT_MS);
  await drainMicrotasks(200);
  expect(result).toMatchObject({ outcome: "failed", failure: { code: "discovery_incomplete" } });
  expect(lookupSignal?.aborted).toBe(true);
  expect(h.deleter.calls).toHaveLength(0);
  resolve("emulator-5554");
  await pending;
  await drainMicrotasks(200);
  expect((await h.gate.describeCapacity()).inFlight).toBe(0);
  expect(h.deleter.calls).toHaveLength(0);
});

test("unmatched Android runtime lookup grants no replacement credit", async () => {
  const h = await setup("android");
  h.old.deviceId = undefined;
  h.inventory.runtimeDeviceId = async () => undefined;
  expect(await h.reconciler.reconcile(h.request)).toMatchObject({
    outcome: "failed",
    failure: { code: "capacity_exhausted", capacity: { booted: 2 } },
  });
  expect(h.deleter.calls).toHaveLength(0);
});

test("registry clear failure still boots replacement with the consumed reservation and assigns a device", async () => {
  const h = await setup("android");
  if (!(h.gate instanceof AndroidBootAdmissionGate)) {
    throw new Error("expected Android gate");
  }
  const gate = h.gate;
  h.deleter.afterDelete = async () => {
    h.setBooted(["OTHER"]);
    h.hostRegistry.failWrites = true;
  };
  let release = () => {};
  let booted = false;
  h.provisioner.beforeCreate = async () => {
    expect([...h.host.records.values()][0].deviceId).toBe("emulator-5554");
    expect(await gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 1 });
    await gate.assertCapacityAvailable();
    // At the limit, this can only succeed by consuming the replacement reservation.
    const admission = await gate.admit({ avdName: "REPLACEMENT", timeoutMs: 60_000 });
    h.hostRegistry.failWrites = false;
    admission.handOff("REPLACEMENT");
    release = admission.release;
    booted = true;
  };
  const result = await h.reconciler.reconcile(h.request);
  expect(result.outcome).toBe("ready");
  expect(booted).toBe(true);
  if (result.outcome === "ready") {
    expect(result.disposition).toBe("replaced");
    expect((await h.registry.getAssignment(h.request.key))?.stableDeviceId).toBe(
      result.device.stableId,
    );
    expect(h.inventory.has(result.device.stableId)).toBe(true);
  }
  // The reconciler released its reservation; the consumed slot still belongs to the boot.
  expect(await gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 1 });
  expect([...h.host.records.values()][0]).toMatchObject({
    deviceId: "REPLACEMENT",
    replacement: false,
  });
  release();
  expect((await gate.describeCapacity()).inFlight).toBe(0);
  expect(h.host.records.size).toBe(0);
});
