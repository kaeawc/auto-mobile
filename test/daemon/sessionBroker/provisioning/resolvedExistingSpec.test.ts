import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
  BindingReconciler,
  deviceStableId,
  encodeManagedSpecFingerprint,
  type BindingRequestedSpec,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { ToolBindingProvisioner } from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import type { BindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { openSqliteBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { ExactIosRuntimeCatalog } from "../../../../src/devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../../src/models/index";
import type { AvdConfig } from "../../../../src/utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../../../../src/utils/android-cmdline-tools/AndroidSystemImageRuntime";
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

const IOS = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const ANDROID = "system-images;android-35;google_apis;arm64-v8a";
const OLD_MODEL = "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation";
const DEFAULT_MODEL = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const catalog: ExactIosRuntimeCatalog = {
  getRuntimesChecked: async () => [
    {
      identifier: IOS,
      version: "18.0",
      isAvailable: true,
      bundlePath: "",
      buildversion: "",
      runtimeRoot: "",
      name: "iOS 18",
    },
  ],
  getDeviceTypesChecked: async () =>
    [OLD_MODEL, DEFAULT_MODEL].map((identifier) => ({
      identifier,
      name: identifier,
      minRuntimeVersion: 0,
      maxRuntimeVersion: 0,
      minRuntimeVersionString: "17.0",
      maxRuntimeVersionString: "65535.255.255",
      bundlePath: "",
      productFamily: "iPhone",
    })),
};
const factories: Array<[string, (timer: FakeTimer) => Promise<BindingRegistry>]> = [
  ["fake", async (timer) => new FakeBindingRegistry(timer, () => false)],
  [
    "SQLite",
    (timer) =>
      openSqliteBindingRegistry({ dbPath: ":memory:", timer, isExecOwnerLive: () => false }),
  ],
];

beforeAll(async () => {
  const registry = await openSqliteBindingRegistry({ dbPath: ":memory:", timer: new FakeTimer() });
  await registry.close();
});

describe.each(factories)("existing configuration (%s)", (_name, open) => {
  let registry: BindingRegistry | undefined;
  afterEach(async () => {
    await registry?.close();
  });

  async function setup(platform: "ios" | "android", config?: AvdConfig | Error | null) {
    const timer = new FakeTimer();
    const store = await open(timer);
    registry = store;
    const inventory = new FakeInventory();
    const provisioner = new FakeProvisioner(inventory);
    const configReader = {
      readConfig: async () => {
        if (config instanceof Error) {
          throw config;
        }
        return config ?? null;
      },
    };
    const reader = new ToolBindingProvisioner({
      invokeTool: async () => {
        throw new Error("reader must not invoke tools");
      },
      deviceManager: { listDeviceImages: async () => inventory.devices },
      androidConfigReader: configReader,
      timer,
      releaseSession: async () => {},
    });
    const resolver = new DefaultManagedSpecResolver(catalog);
    const reconciler = new BindingReconciler({
      registry: store,
      inventory,
      resolver,
      matcher: new DefaultManagedSpecMatcher(configReader),
      provisioner: {
        readExistingSpec: (device) => reader.readExistingSpec(device),
        provision: (request) => provisioner.provision(request),
        releaseSession: (uuid) => provisioner.releaseSession(uuid),
      },
      deleter: new FakeDeleter(inventory),
      claims: new FakeClaims(),
      capacity: new FakeCapacity(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => false,
    });
    const scope = await store.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "ns",
      runnerIncarnation: "inc",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    const requestedSpec = { runtime: platform === "ios" ? IOS : ANDROID };
    async function acquire(spec: BindingRequestedSpec = requestedSpec) {
      return reconciler.reconcile({
        key,
        role: "app",
        platform,
        requestedSpec: spec,
        deadlineMs: timer.now() + 60_000,
      });
    }
    async function seed(device: DeviceInfo, spec: BindingRequestedSpec = requestedSpec) {
      inventory.devices.push(device);
      const resolution = await resolver.resolve(platform, spec, {});
      if (resolution.kind !== "resolved") {
        throw new Error("resolution setup failed");
      }
      await store.initBinding(key, { role: "app", platform, requestedSpec: spec });
      const binding = await store.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: deviceStableId(device)!,
          deviceName: device.name,
          requestedSpec: spec,
          resolvedSpec: resolution.resolvedSpec,
          specFingerprint: encodeManagedSpecFingerprint(resolution.fingerprint),
          state: "ready",
        },
      );
      if (binding.kind !== "committed") {
        throw new Error("binding setup failed");
      }
      return binding.assignment;
    }
    return { store, inventory, provisioner, reader, key, seed, acquire };
  }

  function simulator(deviceType: string | undefined = OLD_MODEL): DeviceInfo {
    return {
      name: "existing",
      platform: "ios",
      deviceId: "UDID",
      isRunning: false,
      runtime: IOS,
      deviceType,
    };
  }
  const avd: DeviceInfo = { name: "existing-avd", platform: "android", isRunning: false };
  const avdConfig: AvdConfig = {
    systemImagePackage: ANDROID,
    apiLevel: 35,
    tag: "google_apis",
    architecture: parseAndroidSystemImageRuntime(ANDROID)!.architecture,
    deviceName: "pixel_tablet",
    ramSizeMb: 3072,
    screenWidth: 2560,
    screenHeight: 1600,
    screenDensity: 276,
    hardware: { cpuCores: 2, audioInput: false },
  };

  test("repairs stale iOS metadata once and preserves the default fingerprint on repeated reuse", async () => {
    const h = await setup("ios");
    const old = await h.seed(simulator());
    const first = await h.acquire();
    expect(first.outcome).toBe("ready");
    if (first.outcome !== "ready") {
      throw new Error("expected ready");
    }
    expect(first.resolvedSpec).toEqual({
      runtime: IOS,
      deviceType: OLD_MODEL,
      displayCutout: "none",
    });
    expect(first.assignment.resolvedSpec).toEqual(first.resolvedSpec);
    expect(first.assignment.specFingerprint).toBe(old.specFingerprint);
    expect(first.assignment.generation).toBe(old.generation + 1);
    const repeated = await h.acquire();
    expect(repeated.outcome).toBe("ready");
    if (repeated.outcome !== "ready") {
      throw new Error("expected ready");
    }
    expect(repeated.assignment.generation).toBe(first.assignment.generation);
    expect(repeated.resolvedSpec).toEqual(first.resolvedSpec);
    expect(await h.store.getAssignment(h.key)).toEqual(repeated.assignment);
    expect(h.provisioner.created()).toHaveLength(0);
  });

  test("widens Android to any model and reports the AVD's own hardware", async () => {
    const h = await setup("android", avdConfig);
    await h.seed(avd, { runtime: ANDROID, deviceType: "pixel_tablet" });
    const result = await h.acquire();
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.disposition).toBe("reused");
    expect(result.resolvedSpec).toEqual({
      runtime: ANDROID,
      deviceType: "pixel_tablet",
      displayCutout: "none",
      configuration: {
        cpuCores: 2,
        audioInput: false,
        memoryMb: 3072,
        screenWidth: 2560,
        screenHeight: 1600,
        screenDensity: 276,
      },
    });
    expect((await h.store.getAssignment(h.key))?.resolvedSpec).toEqual(result.resolvedSpec);
    const repeated = await h.acquire();
    if (repeated.outcome !== "ready") {
      throw new Error("expected ready");
    }
    expect(repeated.assignment.generation).toBe(result.assignment.generation);
    expect(repeated.specFingerprint).toEqual(result.specFingerprint);
  });

  test.each(["ios", "android"] as const)("creation still uses the %s default", async (platform) => {
    const h = await setup(platform);
    const result = await h.acquire();
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.disposition).toBe("created");
    expect(result.resolvedSpec.deviceType).toBe(platform === "ios" ? DEFAULT_MODEL : "pixel_8");
    expect(result.assignment.resolvedSpec).toEqual(result.resolvedSpec);
    expect(h.provisioner.created()[0]?.spec.deviceType).toBe(result.resolvedSpec.deviceType);
  });

  test.each(["created", "existing"] as const)(
    "identical Android requests retain generation 1 after %s binding despite full config reads",
    async (source) => {
      const h = await setup("android", avdConfig);
      const spec = { runtime: ANDROID, deviceType: "pixel_tablet" };
      if (source === "existing") {
        expect((await h.seed(avd, spec)).generation).toBe(1);
      }
      const first = await h.acquire(spec);
      const second = await h.acquire(spec);
      const third = await h.acquire(spec);
      for (const result of [first, second, third]) {
        if (result.outcome !== "ready") {
          throw new Error(`expected ready, got ${JSON.stringify(result.failure)}`);
        }
        expect(result.assignment.generation).toBe(1);
        expect(result.device.stableId).toBe(first.outcome === "ready" && first.device.stableId);
      }
      expect(first).toMatchObject({ disposition: source === "created" ? "created" : "reused" });
      for (const result of [second, third]) {
        expect(result).toMatchObject({
          disposition: "reused",
          resolvedSpec: {
            runtime: ANDROID,
            deviceType: "pixel_tablet",
            displayCutout: "none",
            configuration: { memoryMb: 3072, cpuCores: 2, screenWidth: 2560 },
          },
        });
      }
      expect((await h.store.getAssignment(h.key))?.generation).toBe(1);
      expect(h.provisioner.created()).toHaveLength(source === "created" ? 1 : 0);
    },
  );

  test("a listed iOS runtime with an unreadable model refuses without fabricating metadata", async () => {
    const h = await setup("ios");
    const device = simulator();
    delete device.deviceType;
    const before = await h.seed(device);
    const result = await h.acquire();
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "discovery_incomplete", retryable: true },
    });
    expect(await h.store.getAssignment(h.key)).toEqual(before);
    expect(h.provisioner.calls).toEqual([]);
  });

  test.each([null, new Error("EACCES")])(
    "unreadable Android config is unknown (%j)",
    async (config) => {
      const h = await setup("android", config);
      expect(await h.reader.readExistingSpec(avd)).toBeNull();
      const before = await h.seed(avd);
      const result = await h.acquire();
      expect(result).toMatchObject({
        outcome: "failed",
        failure: { code: "discovery_incomplete", retryable: true },
      });
      expect(await h.store.getAssignment(h.key)).toEqual(before);
      expect(h.provisioner.calls).toEqual([]);
    },
  );
});
