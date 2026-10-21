import { beforeAll, describe, expect, test } from "bun:test";
import {
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
  BindingReconciler,
  type BindingReconcileResult,
  type BindingRequestedSpec,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import type { BindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { openSqliteBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { ExactIosRuntimeCatalog } from "../../../../src/devices/exactDeviceProvisioning";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

/**
 * Hunt (bindings 4, 2026-10-11), cell "a spec that widens between incarnations".
 *
 * A binding result reports `requestedSpec` (the caller's constraints) and `resolvedSpec`, which #11175
 * defines as the "actual resolved configuration", returned "separately" from the constraints, with
 * creation defaults chosen "only when creation is necessary". The reconciler resolves the spec
 * once, up front, to the model a CREATION would use, and reports and records that value for every
 * disposition. So when an execution widens an exact spec to "any model" (or an any-model binding
 * adopts a free-pool device), the device is correctly reused, but the result and the registry say
 * it is the newest iPhone the catalog lists rather than the model it really is. A launcher that
 * keys anything on `resolvedSpec.deviceType` (screenshot baselines, a display cutout class) is told
 * the wrong model, and `resolvedSpec.displayCutout` is derived from that wrong model too.
 */
const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IPHONE_15 = "com.apple.CoreSimulator.SimDeviceType.iPhone-15";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";

function deviceType(identifier: string, min: string) {
  return {
    identifier,
    name: identifier.split(".").at(-1)!,
    minRuntimeVersion: 0,
    maxRuntimeVersion: 0,
    minRuntimeVersionString: min,
    maxRuntimeVersionString: "65535.255.255",
    bundlePath: "",
    productFamily: "iPhone",
  };
}

/** simctl lists device types oldest first: "any model" creates an iPhone 16 on iOS 18. */
const CATALOG: ExactIosRuntimeCatalog = {
  getRuntimesChecked: async () => [
    {
      identifier: IOS_18,
      version: "18.0",
      isAvailable: true,
      bundlePath: "",
      buildversion: "",
      runtimeRoot: "",
      name: "iOS 18.0",
    },
  ],
  getDeviceTypesChecked: async () => [deviceType(IPHONE_15, "17.0"), deviceType(IPHONE_16, "18.0")],
};

const REGISTRIES: Array<[string, (timer: FakeTimer) => Promise<BindingRegistry>]> = [
  ["in-memory registry", async (timer) => new FakeBindingRegistry(timer, () => false)],
  [
    "SQLite registry",
    (timer) =>
      openSqliteBindingRegistry({ dbPath: ":memory:", timer, isExecOwnerLive: () => false }),
  ],
];

beforeAll(async () => {
  // Warm only SQLite initialization; every scenario still runs entirely inside its test.
  const registry = await openSqliteBindingRegistry({ dbPath: ":memory:", timer: new FakeTimer() });
  await registry.close();
});

describe.each(REGISTRIES)("a binding whose spec widens to any model (%s)", (_name, open) => {
  async function widen() {
    const timer = new FakeTimer();
    const registry = await open(timer);
    const inventory = new FakeInventory();
    const reconciler = new BindingReconciler({
      registry,
      inventory,
      // The real matcher: iOS matching reads the listed runtime and model.
      matcher: new DefaultManagedSpecMatcher({ readConfig: async () => null }),
      resolver: new DefaultManagedSpecResolver(CATALOG),
      provisioner: new FakeProvisioner(inventory),
      deleter: new FakeDeleter(inventory),
      claims: new FakeClaims(),
      capacity: new FakeCapacity(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => false,
    });
    const scope = await registry.ensureScope({
      managedHostScope: "host-a",
      runnerNamespace: "ns",
      runnerIncarnation: "inc-1",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    const acquire = async (requestedSpec: BindingRequestedSpec) => {
      const result: BindingReconcileResult = await reconciler.reconcile({
        key,
        role: "app",
        platform: "ios",
        requestedSpec,
        deadlineMs: timer.now() + 60_000,
      });
      if (result.outcome !== "ready") {
        throw new Error(`expected ready, got ${JSON.stringify(result.failure)}`);
      }
      return result;
    };
    // Execution 1 pins the model; execution 2 asks for "iOS 18, any model".
    const exact = await acquire({ runtime: IOS_18, deviceType: IPHONE_15 });
    const widened = await acquire({ runtime: IOS_18 });
    const repeated = await acquire({ runtime: IOS_18 });
    const listed = inventory.devices.find((device) => device.deviceId === widened.device.stableId);
    await registry.close();
    return { exact, widened, repeated, listed };
  }

  test("reuses the iPhone 15 and reports its actual model as the resolved spec", async () => {
    const { exact, widened, listed } = await widen();

    // Controls: the widened spec matched, so the same iPhone 15 is reused, not replaced.
    expect(exact.resolvedSpec.deviceType).toBe(IPHONE_15);
    expect(widened.disposition).toBe("reused");
    expect(widened.device.stableId).toBe(exact.device.stableId);
    expect(listed?.deviceType).toBe(IPHONE_15);
    expect(widened.requestedSpec).toEqual({ runtime: IOS_18 });

    // Bug: the result (initialize outcome, automobile:broker-bindings resource) names the creation
    // default, an iPhone 16 that does not exist in this binding.
    expect(widened.resolvedSpec.deviceType).toBe(IPHONE_15);
  });

  test("records the reused device's actual model on the assignment", async () => {
    const { widened } = await widen();

    expect(widened.assignment.resolvedSpec).toMatchObject({
      runtime: IOS_18,
      deviceType: IPHONE_15,
    });
  });

  test("a repeated widened spec retains the repaired configuration and generation", async () => {
    const { widened, repeated } = await widen();
    expect(repeated.disposition).toBe("reused");
    expect(repeated.resolvedSpec.deviceType).toBe(IPHONE_15);
    expect(repeated.assignment.resolvedSpec).toEqual(widened.assignment.resolvedSpec);
    expect(repeated.assignment.generation).toBe(widened.assignment.generation);
    expect(repeated.specFingerprint).toEqual(widened.specFingerprint);
  });
});
