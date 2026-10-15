import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  computeManagedSpecFingerprint,
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
  BindingReconciler,
  type DefaultManagedSpecResolverOptions,
  type BindingRequestedSpec,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import type { BindingPlatform } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { ExactIosRuntimeCatalog } from "../../../../src/devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../../src/models/index";
import type { AvdConfig } from "../../../../src/utils/android-cmdline-tools/AvdConfigReader";
import type { AppleDeviceType } from "../../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { classifyDisplayCutout } from "../../../../src/utils/displayCutout";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { assignBindingDevice } from "./bindingFixtures";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

const IOS = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const ANDROID = "system-images;android-36;google_apis;x86_64";
const IPHONE_15 = "com.apple.CoreSimulator.SimDeviceType.iPhone-15";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const IPAD_OLD = "com.apple.CoreSimulator.SimDeviceType.iPad-Air";
const IPAD_NEW = "com.apple.CoreSimulator.SimDeviceType.iPad-Pro";
const FAMILIES = ["phone", "tablet", "foldable"] as const;

function model(identifier: string, min = "17.0", max = "65535.255.255"): AppleDeviceType {
  return {
    identifier,
    name: identifier,
    productFamily: identifier.includes("iPad") ? "iPad" : "iPhone",
    minRuntimeVersion: 0,
    maxRuntimeVersion: 0,
    minRuntimeVersionString: min,
    maxRuntimeVersionString: max,
    bundlePath: "",
  };
}

function catalog(
  types = [model(IPHONE_15), model(IPAD_OLD), model(IPHONE_16), model(IPAD_NEW)],
): ExactIosRuntimeCatalog {
  return {
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
    getDeviceTypesChecked: async () => types,
  };
}

function iosDevice(deviceType: string, id = deviceType): DeviceInfo {
  return { name: id, deviceId: id, deviceType, runtime: IOS, platform: "ios", isRunning: false };
}

function androidConfig(deviceName = "pixel_8", geometry: Partial<AvdConfig> = {}): AvdConfig {
  return {
    deviceName,
    apiLevel: 36,
    tag: "google_apis",
    architecture: "x86_64",
    systemImagePackage: ANDROID,
    screenWidth: 1080,
    screenHeight: 2400,
    screenDensity: 420,
    ...geometry,
  };
}

const ANDROID_DEVICE: DeviceInfo = {
  name: "existing-avd",
  platform: "android",
  runtime: ANDROID,
  deviceType: "pixel_8",
  isRunning: false,
};

async function harness(
  platform: BindingPlatform,
  options: {
    assigned?: DeviceInfo;
    config?: AvdConfig;
    iosCatalog?: ExactIosRuntimeCatalog;
    resolverOptions?: DefaultManagedSpecResolverOptions;
  } = {},
) {
  const timer = new FakeTimer();
  const registry = new FakeBindingRegistry(timer, () => false);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  const deleter = new FakeDeleter(inventory);
  const resolver = new DefaultManagedSpecResolver(
    options.iosCatalog ?? catalog(),
    options.resolverOptions,
  );
  const reconciler = new BindingReconciler({
    registry,
    inventory,
    provisioner,
    deleter,
    resolver,
    matcher: new DefaultManagedSpecMatcher({
      readConfig: async () => options.config ?? androidConfig(),
    }),
    claims: new FakeClaims(),
    timer,
    idGenerator: new FakeIdGenerator(),
    isExecOwnerLive: () => false,
  });
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace: "current",
    runnerIncarnation: "boot-1",
  });
  if (scope.kind !== "ready") {
    throw new Error("scope setup failed");
  }
  const key = options.assigned
    ? await assignBindingDevice(
        registry,
        platform,
        options.assigned.deviceId ?? options.assigned.name,
        "current",
      )
    : { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
  if (options.assigned) {
    inventory.devices.push(options.assigned);
  }
  const acquire = (requestedSpec: BindingRequestedSpec) =>
    reconciler.reconcile({
      key,
      role: "primary",
      platform,
      requestedSpec,
      deadlineMs: timer.now() + 60_000,
    });
  const seedFree = async (device: DeviceInfo) => {
    const oldKey = await assignBindingDevice(
      registry,
      platform,
      device.deviceId ?? device.name,
      device.name,
    );
    inventory.devices.push(device);
    await registry.beginScopeInvalidation(oldKey.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(oldKey.scopeKey);
  };
  return { registry, inventory, provisioner, deleter, key, acquire, seedFree };
}

function expectNoMutation(h: Awaited<ReturnType<typeof harness>>) {
  expect(h.provisioner.calls).toEqual([]);
  expect(h.deleter.calls).toEqual([]);
}

describe("binding iOS family constraints", () => {
  test("phone reuses an assigned non-default iPhone and reports the original constraints", async () => {
    const h = await harness("ios", { assigned: iosDevice(IPHONE_15) });
    const spec: BindingRequestedSpec = { runtime: IOS, deviceFamily: "phone" };
    const result = await h.acquire(spec);
    expect(result).toMatchObject({
      outcome: "ready",
      disposition: "reused",
      requestedSpec: spec,
      resolvedSpec: { deviceType: IPHONE_15 },
    });
    expect(result.resolvedSpec).not.toHaveProperty("deviceFamily");
    expect(result.assignment?.requestedSpec).toEqual(spec);
    expect(h.provisioner.calls[0]?.spec).toEqual({ runtime: IOS });
    expect(h.deleter.calls).toEqual([]);
  });

  test("phone replaces an assigned iPad with the default iPhone", async () => {
    const h = await harness("ios", { assigned: iosDevice(IPAD_OLD) });
    expect(await h.acquire({ runtime: IOS, deviceFamily: "phone" })).toMatchObject({
      outcome: "ready",
      disposition: "replaced",
      resolvedSpec: { deviceType: IPHONE_16 },
    });
    expect(h.deleter.stableIds()).toEqual([IPAD_OLD]);
    expect(h.provisioner.created()[0]?.spec).not.toHaveProperty("deviceFamily");
  });

  test("phone adopts an eligible non-default iPhone, skipping an eligible iPad", async () => {
    const h = await harness("ios");
    await h.seedFree(iosDevice(IPAD_OLD, "a-ipad"));
    await h.seedFree(iosDevice(IPHONE_15, "b-iphone"));
    const result = await h.acquire({ runtime: IOS, deviceFamily: "phone" });
    expect(result).toMatchObject({
      outcome: "ready",
      disposition: "adopted",
      device: { stableId: "b-iphone" },
      requestedSpec: { deviceFamily: "phone" },
      resolvedSpec: { deviceType: IPHONE_15 },
    });
    expect(result.resolvedSpec).not.toHaveProperty("deviceFamily");
    expect(h.provisioner.calls[0]?.spec).toEqual({ runtime: IOS });
    expect(h.deleter.calls).toEqual([]);
  });

  test("phone creates when only an eligible free-pool iPad exists", async () => {
    const h = await harness("ios");
    await h.seedFree(iosDevice(IPAD_OLD));
    expect(await h.acquire({ runtime: IOS, deviceFamily: "phone" })).toMatchObject({
      disposition: "created",
      resolvedSpec: { deviceType: IPHONE_16 },
    });
    expect(h.inventory.has(IPAD_OLD)).toBe(true);
    expect(h.deleter.calls).toEqual([]);
  });

  test("omitting family still reuses an assigned iPad", async () => {
    const h = await harness("ios", { assigned: iosDevice(IPAD_OLD) });
    expect(await h.acquire({ runtime: IOS })).toMatchObject({
      disposition: "reused",
      resolvedSpec: { deviceType: IPAD_OLD },
    });
    expect(h.deleter.calls).toEqual([]);
  });

  test("tablet creates the newest supported iPad, ahead of newer unknown or incompatible types", async () => {
    const unknown = model("com.apple.CoreSimulator.SimDeviceType.iPad-Unknown");
    unknown.minRuntimeVersionString = undefined;
    unknown.maxRuntimeVersionString = undefined;
    const h = await harness("ios", {
      iosCatalog: catalog([
        model(IPAD_OLD),
        model(IPAD_NEW),
        unknown,
        model("com.apple.CoreSimulator.SimDeviceType.iPad-Future", "19.0"),
      ]),
    });
    expect(await h.acquire({ runtime: IOS, deviceFamily: "tablet" })).toMatchObject({
      disposition: "created",
      resolvedSpec: { deviceType: IPAD_NEW },
    });
  });

  test("tablet falls back to the newest unknown iPad when none is known supported", async () => {
    const types = [model(IPAD_OLD), model(IPAD_NEW)].map((entry) => ({
      ...entry,
      minRuntimeVersionString: undefined,
      maxRuntimeVersionString: undefined,
    }));
    const h = await harness("ios", { iosCatalog: catalog(types) });
    expect(await h.acquire({ runtime: IOS, deviceFamily: "tablet" })).toMatchObject({
      disposition: "created",
      resolvedSpec: { deviceType: IPAD_NEW },
    });
  });

  test.each(["tablet", "foldable"] as const)(
    "no compatible %s model refuses creation",
    async (deviceFamily) => {
      const h = await harness("ios", {
        iosCatalog: catalog([model(IPHONE_16), model(IPAD_OLD, "19.0")]),
      });
      const result = await h.acquire({ runtime: IOS, deviceFamily });
      expect(result.failure?.code).toBe("runtime_incompatible");
      expect(result.failure?.message).toContain(deviceFamily);
      expect(result.failure?.message).toContain(IOS);
      expectNoMutation(h);
    },
  );

  test("a newer creation-default iPhone does not replace an assigned family match", async () => {
    const newer = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
    const h = await harness("ios", {
      assigned: iosDevice(IPHONE_15),
      iosCatalog: catalog([model(IPHONE_16), model(newer)]),
    });
    expect(await h.acquire({ runtime: IOS, deviceFamily: "phone" })).toMatchObject({
      disposition: "reused",
      resolvedSpec: { deviceType: IPHONE_15 },
    });
    expect(h.deleter.calls).toEqual([]);
  });
});

describe("binding Android family constraints", () => {
  afterEach(() => mock.restore());

  for (const field of ["screenWidth", "screenHeight", "screenDensity"] as const) {
    test.each(FAMILIES)(
      `refuses ${field} override with %s before mutation`,
      async (deviceFamily) => {
        const h = await harness("android");
        const journal = spyOn(h.registry, "openBindingJournal");
        const result = await h.acquire({
          runtime: ANDROID,
          deviceFamily,
          configuration: { [field]: 240 },
        });
        expect(result).toMatchObject({
          outcome: "failed",
          failure: { code: "spec_unsupported", retryable: false },
        });
        expect(result.failure?.message).toContain("classified from screen geometry");
        expect(result.failure?.message).toContain("cannot be verified before creation");
        expect(result.failure?.message).toContain("deviceFamily without screen overrides");
        expect(result.failure?.message).toContain("deviceType without deviceFamily");
        expectNoMutation(h);
        expect(journal).not.toHaveBeenCalled();
        expect(await h.registry.getAssignment(h.key)).toBeNull();
      },
    );
  }

  test("phone with only memory configuration creates pixel_8 then reuses its real geometry", async () => {
    const h = await harness("android", {
      config: androidConfig("pixel_8", { ramSizeMb: 4096 }),
    });
    const spec: BindingRequestedSpec = {
      runtime: ANDROID,
      deviceFamily: "phone",
      configuration: { memoryMb: 4096 },
    };
    const first = await h.acquire(spec);
    expect(first).toMatchObject({
      outcome: "ready",
      disposition: "created",
      resolvedSpec: { deviceType: "pixel_8", configuration: { memoryMb: 4096 } },
    });
    if (first.outcome !== "ready") {
      throw new Error("initial creation failed");
    }
    expect(await h.acquire(spec)).toMatchObject({
      outcome: "ready",
      disposition: "reused",
      device: first.device,
    });
    expect(h.provisioner.created()).toHaveLength(1);
    expect(h.deleter.calls).toEqual([]);
  });

  test.each(["screenWidth", "screenHeight", "screenDensity"] as const)(
    "%s override without family still resolves unchanged",
    async (field) => {
      const resolver = new DefaultManagedSpecResolver();
      expect(
        await resolver.resolve(
          "android",
          {
            runtime: ANDROID,
            configuration: { [field]: 240 },
          },
          {},
        ),
      ).toMatchObject({
        kind: "resolved",
        resolvedSpec: { deviceType: "pixel_8", configuration: { [field]: 240 } },
      });
    },
  );

  const cases = [
    { name: "phone geometry", config: androidConfig(), family: "phone" },
    { name: "tablet profile", config: androidConfig("pixel_tablet"), family: "tablet" },
    {
      name: "tablet geometry",
      config: androidConfig("custom", {
        screenWidth: 1600,
        screenHeight: 2560,
        screenDensity: 320,
      }),
      family: "tablet",
    },
    { name: "foldable profile", config: androidConfig("pixel_fold"), family: "foldable" },
  ] as const;
  for (const entry of cases) {
    test.each(FAMILIES)(`${entry.name} against %s`, async (deviceFamily) => {
      const matcher = new DefaultManagedSpecMatcher({ readConfig: async () => entry.config });
      expect(await matcher.matches(ANDROID_DEVICE, { runtime: ANDROID, deviceFamily })).toBe(
        deviceFamily === entry.family ? "match" : "mismatch",
      );
    });
  }

  test("unreadable geometry is unknown and never deletes the assigned device", async () => {
    const config = androidConfig("pixel_8", { screenDensity: undefined });
    const matcher = new DefaultManagedSpecMatcher({ readConfig: async () => config });
    expect(await matcher.matches(ANDROID_DEVICE, { runtime: ANDROID, deviceFamily: "phone" })).toBe(
      "unknown",
    );
    expect(await matcher.matches(ANDROID_DEVICE, { runtime: ANDROID })).toBe("match");
    const h = await harness("android", { assigned: { ...ANDROID_DEVICE }, config });
    const before = await h.registry.getAssignment(h.key);
    expect((await h.acquire({ runtime: ANDROID, deviceFamily: "phone" })).failure?.code).toBe(
      "discovery_incomplete",
    );
    expectNoMutation(h);
    expect(await h.registry.getAssignment(h.key)).toEqual(before);
  });

  test.each([
    ["phone", "pixel_8"],
    ["tablet", "pixel_tablet"],
    ["foldable", "pixel_fold"],
  ] as const)(
    "%s creates %s and strips the provision constraint",
    async (deviceFamily, deviceType) => {
      const h = await harness("android");
      const spec: BindingRequestedSpec = { runtime: ANDROID, deviceFamily };
      const result = await h.acquire(spec);
      expect(result).toMatchObject({
        outcome: "ready",
        disposition: "created",
        requestedSpec: spec,
        resolvedSpec: { deviceType },
      });
      expect(result.resolvedSpec).not.toHaveProperty("deviceFamily");
      expect(result.assignment?.requestedSpec).toEqual(spec);
      expect(h.provisioner.calls[0]?.spec).toEqual({ runtime: ANDROID, deviceType });
    },
  );

  test.each(["reused", "adopted"] as const)(
    "Android %s keeps family in reporting and strips it from provision",
    async (disposition) => {
      const h = await harness(
        "android",
        disposition === "reused" ? { assigned: { ...ANDROID_DEVICE } } : {},
      );
      if (disposition === "adopted") {
        await h.seedFree({ ...ANDROID_DEVICE });
      }
      const result = await h.acquire({ runtime: ANDROID, deviceFamily: "phone" });
      expect(result).toMatchObject({
        disposition,
        requestedSpec: { deviceFamily: "phone" },
        resolvedSpec: { deviceType: "pixel_8" },
      });
      expect(result.resolvedSpec).not.toHaveProperty("deviceFamily");
      expect(h.provisioner.calls[0]?.spec).toEqual({ runtime: ANDROID });
    },
  );

  test.each([
    { androidDefaultDeviceType: "pixel_9" },
    { androidDefaultDeviceTypesByFamily: { phone: "pixel_9" } },
  ])(
    "changing a phone creation default never replaces a family match (%p)",
    async (resolverOptions) => {
      const h = await harness("android", { assigned: { ...ANDROID_DEVICE }, resolverOptions });
      expect(await h.acquire({ runtime: ANDROID, deviceFamily: "phone" })).toMatchObject({
        disposition: "reused",
        resolvedSpec: { deviceType: "pixel_8" },
      });
      expect(h.provisioner.created()).toEqual([]);
      expect(h.deleter.calls).toEqual([]);
    },
  );

  test("per-family overrides choose the creation profile", async () => {
    const resolverOptions = { androidDefaultDeviceTypesByFamily: { tablet: "custom_tablet" } };
    const h = await harness("android", { resolverOptions });
    expect(await h.acquire({ runtime: ANDROID, deviceFamily: "tablet" })).toMatchObject({
      disposition: "created",
      resolvedSpec: { deviceType: "custom_tablet" },
    });
  });

  test("missing tablet creation profile is refused before creation or deletion", async () => {
    const h = await harness("android", {
      resolverOptions: { androidProfileCatalog: { listProfileIds: async () => ["pixel_8"] } },
    });
    const result = await h.acquire({ runtime: ANDROID, deviceFamily: "tablet" });
    expect(result.failure?.code).toBe("spec_unsupported");
    expect(result.failure?.message).toContain("pixel_tablet");
    expectNoMutation(h);
    expect(await h.registry.listOpenBindingJournal(h.key)).toEqual([]);
  });
});

describe("managed family/model validation and fingerprint compatibility", () => {
  test.each([
    {
      platform: "ios",
      runtime: IOS,
      deviceType: IPAD_OLD,
      deviceFamily: "phone",
      message: "conflicts",
    },
    {
      platform: "android",
      runtime: ANDROID,
      deviceType: "pixel_fold",
      deviceFamily: "phone",
      message: "conflicts",
    },
    {
      platform: "android",
      runtime: ANDROID,
      deviceType: "pixel_8",
      deviceFamily: "phone",
      message: "cannot be verified before creation",
    },
    {
      platform: "ios",
      runtime: IOS,
      deviceType: "com.apple.CoreSimulator.SimDeviceType.Apple-TV",
      deviceFamily: "phone",
      message: "cannot be verified before creation",
    },
  ] as const)(
    "refuses $platform $deviceType with $deviceFamily before mutation",
    async ({ platform, runtime, deviceType, deviceFamily, message }) => {
      const h = await harness(platform, {
        iosCatalog: catalog([model(IPHONE_16), model(deviceType)]),
      });
      const result = await h.acquire({ runtime, deviceType, deviceFamily });
      expect(result.failure?.code).toBe("spec_unsupported");
      expect(result.failure?.message).toContain(deviceType);
      expect(result.failure?.message).toContain(deviceFamily);
      expect(result.failure?.message).toContain(message);
      if (message.startsWith("cannot")) {
        expect(result.failure?.message).toContain("not both");
      }
      expectNoMutation(h);
      expect(await h.registry.getAssignment(h.key)).toBeNull();
    },
  );

  test.each([
    { platform: "android", runtime: ANDROID, deviceType: "pixel_fold", deviceFamily: "foldable" },
    { platform: "android", runtime: ANDROID, deviceType: "pixel_tablet", deviceFamily: "tablet" },
    { platform: "ios", runtime: IOS, deviceType: IPHONE_15, deviceFamily: "phone" },
    { platform: "ios", runtime: IOS, deviceType: IPAD_OLD, deviceFamily: "tablet" },
  ] as const)(
    "accepts consistent $deviceType with $deviceFamily",
    async ({ platform, runtime, deviceType, deviceFamily }) => {
      const resolver = new DefaultManagedSpecResolver(catalog());
      const result = await resolver.resolve(platform, { runtime, deviceType, deviceFamily }, {});
      expect(result).toMatchObject({ kind: "resolved", resolvedSpec: { runtime, deviceType } });
      if (result.kind === "resolved") {
        expect(result.resolvedSpec).not.toHaveProperty("deviceFamily");
      }
    },
  );

  test.each(["android", "ios"] as const)(
    "%s cutout without model stays refused with family",
    async (platform) => {
      const h = await harness(platform);
      const result = await h.acquire({
        runtime: platform === "android" ? ANDROID : IOS,
        deviceFamily: "phone",
        displayCutout: "none",
      });
      expect(result.failure?.code).toBe("spec_unsupported");
      expect(result.failure?.message).toContain("explicit deviceType");
      expectNoMutation(h);
    },
  );

  test("Android phone family and omitted family resolve identically with the original V1 fingerprint", async () => {
    const resolver = new DefaultManagedSpecResolver();
    const plain = await resolver.resolve("android", { runtime: ANDROID }, {});
    const phone = await resolver.resolve(
      "android",
      { runtime: ANDROID, deviceFamily: "phone" },
      {},
    );
    const resolvedSpec = {
      runtime: ANDROID,
      deviceType: "pixel_8",
      displayCutout: classifyDisplayCutout("android", "pixel_8"),
    };
    expect(plain).toEqual({
      kind: "resolved",
      resolvedSpec,
      fingerprint: computeManagedSpecFingerprint("android", resolvedSpec),
    });
    expect(phone).toEqual(plain);
  });
});
