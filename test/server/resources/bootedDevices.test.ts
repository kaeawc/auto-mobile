import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { createExecResult } from "../../../src/utils/execResult";
import { listBootedDevicesForResource } from "../../../src/server/resourceDeviceResolver";
import { FakeDeviceHealthMarkers } from "../../fakes/FakeDeviceHealthMarkers";
import { installHermeticServerFixture } from "../../helpers/hermeticServerFixture";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";
import { ResourceRegistry } from "../../../src/server/resourceRegistry";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import {
  setDeviceManager,
  setDeviceLockProbe,
  setIosLockStateProbe,
  setOrientationReaderFactory,
  notifyBootedDeviceResourcesUpdated,
  BootedDevicesResourceContent,
  DeviceLockStatesResourceContent,
  readinessFromServiceStatus,
  queryDeviceServiceStatus,
  configuredImagesForBootedPlatform,
  type AndroidServiceStatusLookup,
  type CtrlProxyVersionLookup,
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setBootCompletionAdbFactory,
  setInFlightAndroidColdBootReader,
} from "../../../src/server/bootedDeviceResources";
import {
  DeviceBootService,
  getInFlightAndroidColdBootReader,
} from "../../../src/devices/deviceBootService";
import { FakeDeviceMatcher } from "../../fakes/FakeDeviceMatcher";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../../src/devices/virtualDeviceLifecycleCoordinator";
import { BootedDevice, Platform } from "../../../src/models";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../../src/daemon/foreignDeviceOwnership";
import { RegistryManagedSlotExclusion } from "../../../src/daemon/managedSlots/managedSlotExclusion";
import { assignManagedSlotDevice } from "../../daemon/managedSlots/managedSlotFixtures";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { IOSCtrlProxyManager } from "../../../src/ctrlProxy/IOSCtrlProxyManager";
import { describeDevice, listDevicesEntrySchema } from "../../../src/server/deviceDescription";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { getAndroidAppMetadataViaAdb } from "../../../src/features/observe/GetAppMetadata";
import {
  androidTransportIdentityAdbFactory,
  defaultAdbClientFactory,
} from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { resolveApkChecksum, resolveIpaChecksum } from "../../../src/constants/release";
import { z } from "zod/v4";
import { FakeOrientationReader } from "../../fakes/FakeOrientationReader";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";
import { notifyDeviceImageResourcesUpdated } from "../../../src/server/deviceImageResources";
import type { IosLockStateProbe } from "../../../src/features/observe/ios/IosLockStateProbe";
import { logger } from "../../../src/utils/logger";
import {
  AdbClient,
  resetAdbClientCaches,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { PlatformDeviceManager } from "../../../src/devices/deviceUtils";

describe("MCP Booted Device Resources", () => {
  let fixture: McpTestFixture;
  let restoreHermeticServer: () => void;
  let fakeDeviceUtils: FakeDeviceUtils;

  // Mock device data
  const mockAndroidDevice1: BootedDevice = {
    name: "Pixel_7_API_34",
    platform: "android",
    deviceId: "emulator-5554",
    source: "local",
  };

  const mockAndroidDevice2: BootedDevice = {
    name: "Pixel_8_API_35",
    platform: "android",
    deviceId: "emulator-5556",
    source: "local",
  };

  const mockIosDevice1: BootedDevice = {
    name: "iPhone 15 Pro",
    platform: "ios",
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    source: "local",
  };

  const mockIosDevice2: BootedDevice = {
    name: "iPad Pro (12.9-inch)",
    platform: "ios",
    deviceId: "B2C3D4E5-F6A7-8901-BCDE-F12345678901",
    source: "local",
  };

  beforeAll(async () => {
    restoreHermeticServer = installHermeticServerFixture();
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  beforeEach(() => {
    AndroidAvdProvenanceCache.resetForTests();
    resetBootedDevicesResourceCache();
    // Set up fake device utils before each test
    fakeDeviceUtils = new FakeDeviceUtils();
    setDeviceManager(fakeDeviceUtils);
  });

  afterEach(() => {
    setBootCompletionAdbFactory(null);
    setInFlightAndroidColdBootReader(null);
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    // Restore the real (adb-backed) lock probe so a test's fake never leaks into the next.
    setDeviceLockProbe(null);
    setIosLockStateProbe(null);
    setOrientationReaderFactory(null);
    resetBootedDevicesResourceCache();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    // Reset to default device manager
    setDeviceManager(null);
    restoreHermeticServer();
  });

  test("booted listings fold aliases and keep the canonical after USB disappears", async () => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const usb: BootedDevice = { deviceId: "PHONE-USB", name: "Phone", platform: "android" };
    const alias = { ...usb, deviceId: "host-a:5555" };
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult(usb.deviceId, ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
    adb.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "resource-alias", {
        timer,
        deviceManager: fakeDeviceUtils,
        androidAdbFactory: new FakeAdbClientFactory(adb),
      }),
    );
    fakeDeviceUtils.setBootedDevices("android", [usb, alias]);
    await pool.refreshDevices();
    DaemonState.getInstance().initialize(sessions, pool);
    try {
      for (const rows of [[usb, alias], [alias]]) {
        fakeDeviceUtils.setBootedDevices("android", rows);
        resetBootedDevicesResourceCache();
        const result = await getBootedDevicesForPlatforms(["android"], timer);
        expect(result.devices.map((device) => device.runtime.deviceId)).toEqual([usb.deviceId]);
        expect(
          (await listBootedDevicesForResource("android", "alias-test")).map(
            (device) => device.deviceId,
          ),
        ).toEqual([usb.deviceId]);
      }
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      sessions.stopCleanupTimer();
      timer.reset();
    }
  });

  test("direct booted listings and lock states fold proven aliases", async () => {
    const usb: BootedDevice = { deviceId: "PHONE-USB", name: "Phone", platform: "android" };
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult(usb.deviceId, ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
    adb.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
    const factory = spyOn(androidTransportIdentityAdbFactory, "create").mockReturnValue(adb);
    fakeDeviceUtils.setBootedDevices("android", [usb, { ...usb, deviceId: "host-a:5555" }]);
    setDeviceLockProbe(async () => ({ locked: false, keyguardShowing: false }));
    try {
      const result = await getBootedDevicesForPlatforms(["android"], new FakeTimer());
      expect(result.devices.map((device) => device.runtime.deviceId)).toEqual([usb.deviceId]);
      expect(
        (await listBootedDevicesForResource("android", "alias-test")).map(
          (device) => device.deviceId,
        ),
      ).toEqual([usb.deviceId]);
      const { client } = fixture.getContext();
      const locks = await client.readResource({ uri: "automobile:devices/lockStates" });
      const content = locks.contents[0];
      if (!("text" in content)) {
        throw new Error("Expected JSON lock-state resource");
      }
      const data: DeviceLockStatesResourceContent = JSON.parse(content.text);
      expect(data.lockStates.map((device) => device.deviceId)).toEqual([usb.deviceId]);
    } finally {
      factory.mockRestore();
    }
  });

  test("booted resource surfaces health reason and excludes dirty idle devices from availability", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1234);
    const markers = new FakeDeviceHealthMarkers(timer);
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "health-resource", {
        timer,
        deviceManager: fakeDeviceUtils,
        deviceHealthMarkers: markers,
      }),
    );
    try {
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1, mockAndroidDevice2]);
      await pool.initializeWithDevices([mockAndroidDevice1, mockAndroidDevice2]);
      DaemonState.getInstance().initialize(manager, pool);
      markers.mark(
        mockAndroidDevice1.deviceId,
        pool.getDeviceIncarnation(mockAndroidDevice1.deviceId)!,
        "biometric-enrollment",
      );
      const result = await getBootedDevicesForPlatforms(["android"], timer);
      expect(result.devices[0].unhealthy).toEqual({ reason: "biometric-enrollment", since: 1234 });
      expect(result.devices[1]).not.toHaveProperty("unhealthy");
      expect(result.poolStatus?.idle).toBe(1);
      expect(listDevicesEntrySchema.shape.unhealthy.parse(result.devices[0].unhealthy)).toEqual({
        reason: "biometric-enrollment",
        since: 1234,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("coalesces and caches the full Android booted-device resource snapshot", async () => {
    const timer = new FakeTimer();
    fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);

    const concurrentResults = await Promise.all(
      Array.from({ length: 4 }, () => getBootedDevicesForPlatforms(["android"], timer)),
    );

    expect(concurrentResults).toHaveLength(4);
    expect(fakeDeviceUtils.getCallCount("getBootedDevices:android")).toBe(1);

    await getBootedDevicesForPlatforms(["android"], timer);
    expect(fakeDeviceUtils.getCallCount("getBootedDevices:android")).toBe(1);

    timer.advanceTime(2_501);
    await getBootedDevicesForPlatforms(["android"], timer);
    expect(fakeDeviceUtils.getCallCount("getBootedDevices:android")).toBe(2);

    resetBootedDevicesResourceCache();
    await getBootedDevicesForPlatforms(["android"], timer);
    expect(fakeDeviceUtils.getCallCount("getBootedDevices:android")).toBe(3);
  });

  test("cold-boot claim notifies both subscribers and yields one serial-less row until adb discovers it", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    setInFlightAndroidColdBootReader(getInFlightAndroidColdBootReader(coordinator));
    const avdName = mockAndroidDevice1.name;
    const image = {
      name: avdName,
      platform: "android" as const,
      isRunning: false,
      apiLevel: 34,
      screenWidth: 1080,
    };
    fakeDeviceUtils.setDeviceImages("android", [image]);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const start = fakeDeviceUtils.startDevice.bind(fakeDeviceUtils);
    fakeDeviceUtils.startDevice = async (...args) => {
      const handle = await start(...args);
      // FakeDeviceUtils normally lists the emulator immediately; preserve the pre-adb window.
      fakeDeviceUtils.setBootedDevices("android", []);
      resolveStarted();
      return handle;
    };
    const matcher = new FakeDeviceMatcher();
    matcher.setImageResult(image);
    let resolveReady!: (device: BootedDevice) => void;
    const ready = new Promise<BootedDevice>((resolve) => {
      resolveReady = resolve;
    });
    fakeDeviceUtils.waitForDeviceReady = async () => ready;
    const { client, server } = fixture.getContext();
    const uris = ["automobile:devices/booted", "automobile:devices/booted/android"];
    const sent: string[] = [];
    const notification = spyOn(server.server, "notification").mockImplementation(
      async (message) => {
        if (message.method === "notifications/resources/updated") {
          sent.push(message.params.uri);
        }
      },
    );
    let resolveClaim!: () => void;
    const claimed = new Promise<void>((resolve) => {
      resolveClaim = resolve;
    });
    const bootService = new DeviceBootService({
      deviceManager: fakeDeviceUtils,
      deviceMatcher: matcher,
      deviceCreationGate: { isCreationAllowed: () => false, describeSource: () => "test" },
      deviceProvisioner: {
        provision: async () => {
          throw new Error("unexpected provision");
        },
      },
      matchingStrategy: "LATEST",
      timer,
      lifecycleCoordinator: coordinator,
      onAndroidColdBootTrackingChanged: (_name, phase) => {
        void notifyBootedDeviceResourcesUpdated().then(() => {
          if (phase === "claimed") {
            resolveClaim();
          }
        });
      },
    });
    let boot: Promise<unknown> | undefined;
    try {
      for (const uri of uris) {
        await client.request({ method: "resources/subscribe", params: { uri } }, z.object({}));
      }
      boot = bootService.boot({ platform: "android" });
      await claimed;
      await started;
      expect(sent).toEqual(expect.arrayContaining(uris));
      const read = async (uri: string): Promise<BootedDevicesResourceContent> =>
        JSON.parse((await client.readResource({ uri })).contents[0].text!);
      for (const uri of uris) {
        const data = await read(uri);
        expect(data.totalCount).toBe(1);
        expect(data.androidCount).toBe(1);
        expect(data.virtualCount).toBe(1);
        expect(data.devices[0]).toMatchObject({
          name: avdName,
          platform: "android",
          source: "local",
          identity: { stableId: avdName },
          apiLevel: 34,
          display: { width: 1080 },
          runtime: { deviceId: null, lifecycle: { state: "booting", known: true } },
        });
        expect(data.devices[0]).not.toHaveProperty("recoveryEligibility");
        expect(data.devices[0]).not.toHaveProperty("identityUnresolved");
      }

      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell getprop sys.boot_completed", { stdout: "0", stderr: "" });
      setBootCompletionAdbFactory({ create: () => adb });
      resetBootedDevicesResourceCache();
      const preCompleted = await read(uris[1]);
      expect(preCompleted.devices).toHaveLength(1);
      expect(preCompleted.devices[0].runtime.deviceId).toBe(mockAndroidDevice1.deviceId);
      expect(preCompleted.devices[0].runtime.lifecycle.state).toBe("booting");

      adb.setCommandResponse("shell getprop sys.boot_completed", { stdout: "1", stderr: "" });
      resetBootedDevicesResourceCache();
      const completed = await read(uris[1]);
      expect(completed.devices).toHaveLength(1);
      expect(completed.devices[0].runtime.lifecycle.state).toBe("booted");
    } finally {
      resolveReady(mockAndroidDevice1);
      if (boot) {
        await boot;
      }
      for (const uri of uris) {
        await client.request({ method: "resources/unsubscribe", params: { uri } }, z.object({}));
      }
      notification.mockRestore();
    }
  });

  test.each([
    ["0", { state: "booting", known: true }],
    ["1", { state: "booted", known: true }],
  ] as const)("reports Android OS boot completion %s", async (property, lifecycle) => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell getprop sys.boot_completed", { stdout: property, stderr: "" });
    setBootCompletionAdbFactory({ create: () => adb });
    fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);

    const result = await getBootedDevicesForPlatforms(["android"], new FakeTimer());
    expect(result.devices[0].runtime.lifecycle).toEqual(lifecycle);
    expect(adb.getExecutedCommands()).toContain("shell getprop sys.boot_completed");
  });

  test("keeps an Android device with unknown lifecycle when boot completion fails", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("shell getprop sys.boot_completed", new Error("transport unavailable"));
    setBootCompletionAdbFactory({ create: () => adb });
    fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);

    const result = await getBootedDevicesForPlatforms(["android"], new FakeTimer());
    expect(result.devices[0].runtime.deviceId).toBe(mockAndroidDevice1.deviceId);
    expect(result.devices[0].runtime.lifecycle).toEqual({ state: "booted", known: false });
  });

  test("marks iOS physical discovery failure incomplete even when simctl succeeds", async () => {
    fakeDeviceUtils.failedSources.add("ios-physical");
    const { client } = fixture.getContext();
    const result = await client.request(
      {
        method: "resources/read",
        params: { uri: "automobile:devices/booted/ios" },
      },
      z.object({ contents: z.array(z.object({ text: z.string() })) }),
    );
    const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text);
    expect(data.observationComplete).toBe(false);
    expect(data.platformObservations.ios?.observationComplete).toBe(false);
    expect(data.platformObservations.ios?.discoveryError).toEqual({
      code: "failed",
      message: "devicectl could not list physical iOS devices (failed): fake",
    });
    expect(data.sourceObservations).toEqual({
      "ios-simulator": { observationComplete: true },
      "ios-physical": {
        observationComplete: false,
        discoveryError: {
          code: "failed",
          message: "devicectl could not list physical iOS devices (failed): fake",
        },
      },
    });
  });

  test("uses configured image facts when a booted Android device has no admitted pool image", async () => {
    fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);
    fakeDeviceUtils.setDeviceImages("android", [
      {
        name: mockAndroidDevice1.name,
        platform: "android",
        isRunning: true,
        apiLevel: 36,
        osVersion: "16",
        screenWidth: 1080,
        screenHeight: 2400,
        screenDensity: 420,
        formFactor: "phone",
      },
    ]);

    const { client } = fixture.getContext();
    const result = await client.readResource({ uri: "automobile:devices/booted/android" });
    const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);

    expect(data.devices).toEqual([
      expect.objectContaining({
        apiLevel: 36,
        osVersion: "16",
        display: { width: 1080, height: 2400, density: 420, units: "physical-pixels" },
        formFactor: "phone",
      }),
    ]);
  });

  test("attaches Android AVD provenance to configured booted-image lookups", async () => {
    fakeDeviceUtils.setDeviceImages("android", [
      {
        name: mockAndroidDevice1.name,
        platform: "android",
        isRunning: true,
        runtimeId: "system-images;android-36;google_apis;arm64-v8a",
      },
    ]);

    const configured = await configuredImagesForBootedPlatform(
      "android",
      fakeDeviceUtils,
      new FakeTimer(),
      {
        listDeviceImages: async () => [
          {
            name: mockAndroidDevice1.name,
            path: "/tmp/Pixel_7_API_34.avd",
            target: "Google APIs",
            basedOn: "Android 16 google_apis/arm64-v8a",
          },
        ],
      },
    );

    expect([...configured.values()][0]?.image).toEqual({
      path: "/tmp/Pixel_7_API_34.avd",
      target: "Google APIs",
      basedOn: "Android 16 google_apis/arm64-v8a",
    });
  });

  test("preserves physical iOS completeness when simulator discovery fails", async () => {
    fakeDeviceUtils.failedSources.add("ios-simulator");
    const { client } = fixture.getContext();
    const result = await client.request(
      {
        method: "resources/read",
        params: { uri: "automobile:devices/booted/ios" },
      },
      z.object({ contents: z.array(z.object({ text: z.string() })) }),
    );
    const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text);
    expect(data.observationComplete).toBe(false);
    expect(data.sourceObservations).toEqual({
      "ios-simulator": { observationComplete: false },
      "ios-physical": { observationComplete: true },
    });
  });

  test("bounds hung configured image fallback discovery", async () => {
    const timer = new FakeTimer();
    fakeDeviceUtils.setListDeviceImagesHangs("android", true);

    const configuredImages = configuredImagesForBootedPlatform("android", fakeDeviceUtils, timer);
    timer.advanceTime(2_000);

    expect(await configuredImages).toEqual(new Map());
    expect(fakeDeviceUtils.getGetDeviceImagesDetailedCalls()).toEqual([
      expect.objectContaining({
        platform: "android",
        options: expect.objectContaining({ signal: expect.any(AbortSignal) }),
      }),
    ]);
    expect(fakeDeviceUtils.getGetDeviceImagesDetailedCalls()[0]?.options.signal?.aborted).toBe(
      true,
    );
    fakeDeviceUtils.setListDeviceImagesHangs("android", false);
  });

  describe("Resource Listing", () => {
    test("should include booted devices resource in list", async function () {
      const { client } = fixture.getContext();

      const listResourcesResponseSchema = z.object({
        resources: z.array(
          z.object({
            uri: z.string(),
            name: z.string().optional(),
            description: z.string().optional(),
            mimeType: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/list",
          params: {},
        },
        listResourcesResponseSchema,
      );

      // Verify booted devices resource is present
      const bootedDevicesResource = result.resources.find(
        (r: any) => r.uri === "automobile:devices/booted",
      );
      expect(bootedDevicesResource).toBeDefined();
      expect(bootedDevicesResource?.name).toBe("Booted Devices");
      expect(bootedDevicesResource?.mimeType).toBe("application/json");
    });

    test("should include booted devices template in resource templates list", async function () {
      const { client } = fixture.getContext();

      const listResourceTemplatesResponseSchema = z.object({
        resourceTemplates: z.array(
          z.object({
            uriTemplate: z.string(),
            name: z.string().optional(),
            description: z.string().optional(),
            mimeType: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/templates/list",
          params: {},
        },
        listResourceTemplatesResponseSchema,
      );

      // Verify booted devices template is present
      const bootedDevicesTemplate = result.resourceTemplates.find(
        (t: any) => t.uriTemplate === "automobile:devices/booted/{platform}",
      );
      expect(bootedDevicesTemplate).toBeDefined();
      expect(bootedDevicesTemplate?.name).toBe("Platform-specific Booted Devices");
      expect(bootedDevicesTemplate?.mimeType).toBe("application/json");
    });
  });

  describe("Resource Reading with Mock Devices", () => {
    test("should return correct counts when there are multiple devices", async function () {
      // Set up mock devices
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1, mockAndroidDevice2]);
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1]);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted",
          },
        },
        readResourceResponseSchema,
      );

      // Verify response structure
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("automobile:devices/booted");
      expect(content.mimeType).toBe("application/json");
      expect(content.text).toBeDefined();

      // Parse and verify content
      const data: BootedDevicesResourceContent = JSON.parse(content.text!);
      expect(data.totalCount).toBe(3);
      expect(data.androidCount).toBe(2);
      expect(data.iosCount).toBe(1);
      expect(data.virtualCount).toBe(3);
      expect(data.physicalCount).toBe(0);
      expect(data.devices).toHaveLength(3);
      expect(data.poolStatus).toBeUndefined();
      expect(data.observationComplete).toBe(true);
      expect(data.platformObservations).toEqual({
        android: { observationComplete: true },
        ios: { observationComplete: true },
      });
      // No pool is wired in this fixture, so there is no incarnation to name
      // the epoch and `connectionId` falls back to the bare serial.
      expect(data.devices[0]).toMatchObject({
        identity: { stableId: "Pixel_7_API_34" },
        runtime: {
          connectionId: "emulator-5554",
          lifecycle: { state: "booted", known: false },
          readiness: { state: "unknown" },
          serviceStatus: null,
        },
      });
      expect("serviceStatus" in data.devices[0]).toBe(false);
      expect(data.devices[2]).toMatchObject({
        identity: { stableId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890" },
        runtime: {
          connectionId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
        },
      });

      // Verify lastUpdated is a valid ISO 8601 date
      expect(() => new Date(data.lastUpdated)).not.toThrow();
    });

    test("should return empty results when no devices are booted", async function () {
      // No devices set up - fakeDeviceUtils returns empty by default
      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted",
          },
        },
        readResourceResponseSchema,
      );

      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
      expect(data.totalCount).toBe(0);
      expect(data.androidCount).toBe(0);
      expect(data.iosCount).toBe(0);
      expect(data.virtualCount).toBe(0);
      expect(data.physicalCount).toBe(0);
      expect(data.devices).toHaveLength(0);
      expect(data.poolStatus).toBeUndefined();
    });

    test("should filter correctly for android platform", async function () {
      // Set up both Android and iOS devices
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1, mockAndroidDevice2]);
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1, mockIosDevice2]);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted/android",
          },
        },
        readResourceResponseSchema,
      );

      // Verify response structure
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("automobile:devices/booted/android");

      // Parse and verify content
      const data: BootedDevicesResourceContent = JSON.parse(content.text!);
      expect(data.totalCount).toBe(2);
      expect(data.androidCount).toBe(2);
      expect(data.iosCount).toBe(0);
      expect(data.virtualCount).toBe(2);
      expect(data.physicalCount).toBe(0);
      expect(data.devices).toHaveLength(2);

      // Verify all devices are Android
      for (const device of data.devices) {
        expect(device.platform).toBe("android");
      }
    });

    test("should filter correctly for ios platform", async function () {
      // Set up both Android and iOS devices
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1, mockIosDevice2]);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted/ios",
          },
        },
        readResourceResponseSchema,
      );

      // Verify response structure
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("automobile:devices/booted/ios");

      // Parse and verify content
      const data: BootedDevicesResourceContent = JSON.parse(content.text!);
      expect(data.totalCount).toBe(2);
      expect(data.androidCount).toBe(0);
      expect(data.iosCount).toBe(2);
      expect(data.virtualCount).toBe(2);
      expect(data.physicalCount).toBe(0);
      expect(data.devices).toHaveLength(2);

      // Verify all devices are iOS
      for (const device of data.devices) {
        expect(device.platform).toBe("ios");
      }
    });

    test("should include all device properties in response", async function () {
      // Set up a single device to check all properties
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted",
          },
        },
        readResourceResponseSchema,
      );

      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
      expect(data.devices).toHaveLength(1);

      const device = data.devices[0];
      expect(device.name).toBe("Pixel_7_API_34");
      expect(device.platform).toBe("android");
      expect(device.runtime.deviceId).toBe("emulator-5554");
      expect(device.source).toBe("local");
      expect(device.isVirtual).toBe(true);
      expect(device.runtime.poolStatus).toBeNull();
    });

    test("includes per-device lock state from the lock probe", async function () {
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1, mockAndroidDevice2]);
      // Only the first device is locked; the probe reports the rest unlocked.
      setDeviceLockProbe(async (device) => device.deviceId === mockAndroidDevice1.deviceId);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted",
          },
        },
        readResourceResponseSchema,
      );

      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
      const locked = data.devices.find(
        (device) => device.runtime.deviceId === mockAndroidDevice1.deviceId,
      );
      const unlocked = data.devices.find(
        (device) => device.runtime.deviceId === mockAndroidDevice2.deviceId,
      );
      expect(locked?.runtime.locked).toBe(true);
      expect(unlocked?.runtime.locked).toBe(false);
      expect(locked && "locked" in locked).toBe(false);
      expect(unlocked && "locked" in unlocked).toBe(false);
    });

    test("includes bounded orientation from the injected OrientationReader", async function () {
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);
      const orientationReader = new FakeOrientationReader();
      orientationReader.setResult("landscape");
      setOrientationReaderFactory(() => orientationReader);

      const { client } = fixture.getContext();
      const result = await client.request(
        { method: "resources/read", params: { uri: "automobile:devices/booted/android" } },
        z.object({ contents: z.array(z.object({ text: z.string() })) }),
      );
      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text);

      expect(data.devices[0].runtime.orientation).toBe("landscape");
    });

    test("omits lock state for a device the probe cannot read", async function () {
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1]);
      // iOS (and any unreadable device) yields undefined — the field is then omitted entirely.
      setDeviceLockProbe(async () => undefined);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted",
          },
        },
        readResourceResponseSchema,
      );

      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
      expect(data.devices[0].runtime.locked).toBeNull();
      expect("locked" in data.devices[0]).toBe(false);
    });

    for (const scenario of [
      { name: "locked simulator", deviceId: mockIosDevice1.deviceId, locked: true },
      { name: "unlocked simulator", deviceId: mockIosDevice1.deviceId, locked: false },
      { name: "unreadable simulator", deviceId: mockIosDevice1.deviceId },
      { name: "throwing simulator probe", deviceId: mockIosDevice1.deviceId, throws: true },
      { name: "physical iPhone", deviceId: "00008030-001C2D3E1234567A", physical: true },
      {
        name: "legacy physical iPhone",
        deviceId: "0123456789abcdef0123456789abcdef0123456789",
        physical: true,
      },
    ]) {
      test(`real iOS lock dispatch handles ${scenario.name} in both resources`, async () => {
        fakeDeviceUtils.setBootedDevices("ios", [
          { ...mockIosDevice1, deviceId: scenario.deviceId },
        ]);
        const probe: IosLockStateProbe = {
          read: async () => {
            if (scenario.throws) {
              throw new Error("fake iOS lock failure");
            }
            return scenario.locked === undefined
              ? undefined
              : { locked: scenario.locked, keyguardShowing: scenario.locked };
          },
        };
        const read = spyOn(probe, "read");
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        setIosLockStateProbe(probe);
        try {
          const { client } = fixture.getContext();
          const result = await client.readResource({ uri: "automobile:devices/lockStates" });
          const content = result.contents[0];
          if (!("text" in content)) {
            throw new Error("Expected JSON lock-state resource");
          }
          const data: DeviceLockStatesResourceContent = JSON.parse(content.text);
          expect(data.observationComplete).toBe(true);
          expect(data.lockStates).toHaveLength(1);
          expect(data.lockStates[0].locked).toBe(scenario.locked);

          const booted = await getBootedDevicesForPlatforms(["ios"], new FakeTimer());
          expect(booted.devices).toHaveLength(1);
          expect(booted.devices[0].runtime.locked).toBe(scenario.locked ?? null);
          if (scenario.physical) {
            expect(read).not.toHaveBeenCalled();
          } else {
            expect(read).toHaveBeenCalledTimes(2);
            expect(read.mock.calls[0][0]).toBe(scenario.deviceId);
            expect(read.mock.calls[1][1]).toBeInstanceOf(AbortSignal);
          }
          if (scenario.throws) {
            expect(warn).toHaveBeenCalledWith(
              expect.stringContaining(
                `Failed to query lock state for ${scenario.deviceId}: Error: fake iOS lock failure`,
              ),
            );
          } else {
            expect(warn).not.toHaveBeenCalled();
          }
        } finally {
          warn.mockRestore();
          read.mockRestore();
        }
      });
    }

    test("lock-states resource surfaces per-device lock from the probe", async function () {
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1, mockAndroidDevice2]);
      // Only the first device is locked; the probe reports the rest unlocked.
      setDeviceLockProbe(async (device) => device.deviceId === mockAndroidDevice1.deviceId);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/lockStates",
          },
        },
        readResourceResponseSchema,
      );

      const data: DeviceLockStatesResourceContent = JSON.parse(result.contents[0].text!);
      const locked = data.lockStates.find((s) => s.deviceId === mockAndroidDevice1.deviceId);
      const unlocked = data.lockStates.find((s) => s.deviceId === mockAndroidDevice2.deviceId);
      expect(locked?.locked).toBe(true);
      expect(unlocked?.locked).toBe(false);
      // lastUpdated is a canonical ISO 8601 timestamp: it round-trips through Date, proving it is a
      // real value rather than merely non-throwing (`new Date()` does not throw on garbage input).
      expect(data.lastUpdated).toBe(new Date(data.lastUpdated).toISOString());
    });

    test("lock-states resource marks a failed device discovery incomplete", async function () {
      fakeDeviceUtils.getBootedDevicesDetailed = async (platform) =>
        platform === "android"
          ? {
              devices: [],
              succeededPlatforms: new Set(),
              discoveryErrors: { android: { code: "failed", message: "adb devices failed" } },
            }
          : { devices: [], succeededPlatforms: new Set(["ios"]) };
      const { client } = fixture.getContext();
      const result = await client.request(
        { method: "resources/read", params: { uri: "automobile:devices/lockStates" } },
        z.object({ contents: z.array(z.object({ text: z.string() })) }),
      );

      const data: DeviceLockStatesResourceContent = JSON.parse(result.contents[0].text!);
      expect(data.observationComplete).toBe(false);
      expect(data.discoveryErrors).toEqual({
        android: { code: "failed", message: "adb devices failed" },
      });
    });

    test("lock-states resource marks an incomplete iOS physical sweep incomplete", async function () {
      fakeDeviceUtils.getBootedDevicesDetailed = async (platform) =>
        platform === "android"
          ? {
              devices: [],
              succeededPlatforms: new Set(["android"]),
              succeededSources: new Set(["android"]),
            }
          : {
              devices: [mockIosDevice1],
              succeededPlatforms: new Set(["ios"]),
              succeededSources: new Set(["ios-simulator"]),
              sourceErrors: {
                "ios-physical": { code: "failed", message: "devicectl sweep incomplete" },
              },
            };
      const { client } = fixture.getContext();
      const result = await client.request(
        { method: "resources/read", params: { uri: "automobile:devices/lockStates" } },
        z.object({ contents: z.array(z.object({ text: z.string() })) }),
      );

      const data: DeviceLockStatesResourceContent = JSON.parse(result.contents[0].text!);
      expect(data.observationComplete).toBe(false);
      expect(data.discoveryErrors.ios).toEqual({
        code: "failed",
        message: "devicectl sweep incomplete",
      });
    });

    test("lock-states resource folds its discovery into the pool before probing (#6923)", async function () {
      // The pool knows the serial by its AVD label; this poll's discovery reads
      // the placeholder, so the entry must be quarantined by the time any
      // device-addressed probe (or a later admission gate) consults the pool.
      const timer = new FakeTimer();
      const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);
      const pool = new DevicePool(
        createDevicePoolDependencies(sessions, "test-daemon", {
          timer: timer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: fakeDeviceUtils,
        }),
      );
      await pool.initializeWithDevices([mockAndroidDevice1]);
      DaemonState.getInstance().initialize(sessions, pool);
      fakeDeviceUtils.setBootedDevices("android", [
        { ...mockAndroidDevice1, name: `Unknown (${mockAndroidDevice1.deviceId})` },
      ]);
      const probed: string[] = [];
      setDeviceLockProbe(async (device) => {
        probed.push(`${device.deviceId}:${pool.isPooledIdentityUnresolved(device.deviceId)}`);
        return false;
      });

      const { client } = fixture.getContext();
      try {
        await client.request(
          { method: "resources/read", params: { uri: "automobile:devices/lockStates" } },
          z.object({ contents: z.array(z.object({ text: z.string() })) }),
        );
        expect(probed).toEqual([`${mockAndroidDevice1.deviceId}:true`]);
      } finally {
        sessions.stopCleanupTimer();
      }
    });

    test("lock-states resource omits lock for a device the probe cannot read", async function () {
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1]);
      setDeviceLockProbe(async () => undefined);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/lockStates",
          },
        },
        readResourceResponseSchema,
      );

      const data: DeviceLockStatesResourceContent = JSON.parse(result.contents[0].text!);
      expect(data.lockStates).toHaveLength(1);
      expect(data.lockStates[0].deviceId).toBe(mockIosDevice1.deviceId);
      expect(data.lockStates[0].locked).toBeUndefined();
    });

    test("resource-update notification fans out to the lock-states resource, not just booted", async function () {
      // A device start/kill changes both the full booted resource and this lightweight one, so
      // subscribers to either must be notified — regression guard for the notify set.
      const spy = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue(undefined);
      try {
        await notifyBootedDeviceResourcesUpdated();
        expect(spy).toHaveBeenCalledTimes(1);
        const uris = spy.mock.calls[0][0];
        expect(uris).toContain("automobile:devices/booted");
        expect(uris).toContain("automobile:devices/booted/android");
        expect(uris).toContain("automobile:devices/booted/ios");
        expect(uris).toContain("automobile:devices/lockStates");
      } finally {
        spy.mockRestore();
      }
    });

    test("notifies subscribed platform booted resources through the real registry", async () => {
      const { client, server } = fixture.getContext();
      const uris = [
        "automobile:devices/booted",
        "automobile:devices/booted/android",
        "automobile:devices/booted/ios",
        "automobile:devices/lockStates",
      ];
      const sent: string[] = [];
      const notification = spyOn(server.server, "notification").mockImplementation(
        async (message) => {
          if (message.method === "notifications/resources/updated") {
            sent.push(message.params.uri);
          }
        },
      );
      try {
        for (const uri of uris) {
          await client.request({ method: "resources/subscribe", params: { uri } }, z.object({}));
        }
        await notifyBootedDeviceResourcesUpdated();
        expect(sent.sort()).toEqual([...uris].sort());
      } finally {
        for (const uri of uris) {
          await client.request({ method: "resources/unsubscribe", params: { uri } }, z.object({}));
        }
        notification.mockRestore();
      }
    });

    test("notifies subscribed platform image resources through the real registry", async () => {
      const { client, server } = fixture.getContext();
      const uris = ["automobile:devices/images/android", "automobile:devices/images/ios"];
      const sent: string[] = [];
      const notification = spyOn(server.server, "notification").mockImplementation(
        async (message) => {
          if (message.method === "notifications/resources/updated") {
            sent.push(message.params.uri);
          }
        },
      );
      try {
        for (const uri of uris) {
          await client.request({ method: "resources/subscribe", params: { uri } }, z.object({}));
        }
        await notifyDeviceImageResourcesUpdated();
        expect(sent.sort()).toEqual([...uris].sort());
      } finally {
        for (const uri of uris) {
          await client.request({ method: "resources/unsubscribe", params: { uri } }, z.object({}));
        }
        notification.mockRestore();
      }
    });

    test("notification invalidates the cached booted inventory before subscribers re-read", async () => {
      const timer = new FakeTimer();
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1]);
      const before = await getBootedDevicesForPlatforms(["ios"], timer);
      expect(before.devices.map((device) => device.runtime.deviceId)).toEqual([
        mockIosDevice1.deviceId,
      ]);
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice2]);
      const notify = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockImplementation(
        async () => {
          const after = await getBootedDevicesForPlatforms(["ios"], timer);
          expect(after.devices.map((device) => device.runtime.deviceId)).toEqual([
            mockIosDevice2.deviceId,
          ]);
        },
      );
      try {
        await notifyBootedDeviceResourcesUpdated();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(fakeDeviceUtils.getCallCount("getBootedDevices:ios")).toBe(2);
      } finally {
        notify.mockRestore();
      }
    });

    test("preserves pool counts until every iOS discovery source completes", async () => {
      const physicalDevice = { ...mockIosDevice2, deviceId: "00008110-001234567890001E" };
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1, physicalDevice]);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const pool = new DevicePool(
        createDevicePoolDependencies(sessions, "test-daemon", {
          timer: timer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: fakeDeviceUtils,
        }),
      );
      await pool.initializeWithDevices([physicalDevice, mockIosDevice1]);
      await pool.assignDeviceToSession("physical-session", "ios");
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1]);
      fakeDeviceUtils.failedSources.add("ios-physical");
      DaemonState.getInstance().initialize(sessions, pool);
      const { client } = fixture.getContext();
      const read = async () => {
        const response = await client.request(
          { method: "resources/read", params: { uri: "automobile:devices/booted/ios" } },
          z.object({ contents: z.array(z.object({ text: z.string() })) }),
        );
        return JSON.parse(response.contents[0].text) as BootedDevicesResourceContent;
      };
      try {
        const partial = await read();
        expect(partial.observationComplete).toBe(false);
        expect(partial.devices.map((device) => device.runtime.deviceId)).toEqual([
          mockIosDevice1.deviceId,
        ]);
        expect(partial.poolStatus).toMatchObject({ total: 2, idle: 1, assigned: 1 });
        fakeDeviceUtils.failedSources.clear();
        resetBootedDevicesResourceCache();
        const complete = await read();
        expect(complete.observationComplete).toBe(true);
        expect(complete.poolStatus?.total).toBe(1);
      } finally {
        sessions.stopCleanupTimer();
      }
    });

    test("should include pool status when daemon is initialized", async function () {
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1, mockAndroidDevice2]);

      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const fakeAppsRepo = new FakeInstalledAppsRepository();
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: fakeAppsRepo,
          deviceManager: fakeDeviceUtils,
        }),
      );
      await devicePool.initializeWithDevices([mockAndroidDevice1, mockAndroidDevice2]);

      const sessionId = "session-123";
      await devicePool.assignDeviceToSession(sessionId);
      DaemonState.getInstance().initialize(sessionManager, devicePool);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted",
          },
        },
        readResourceResponseSchema,
      );

      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
      expect(data.poolStatus).toEqual({
        enabled: true,
        idle: 1,
        assigned: 1,
        error: 0,
        total: 2,
        recoveryPolicy: { onLoss: false, maxAttempts: 2 },
      });

      const assignedDevice = data.devices.find(
        (device) => device.runtime.session?.sessionUuid === sessionId,
      );
      expect(assignedDevice).toBeDefined();
      expect(assignedDevice?.runtime.poolStatus).toBe("assigned");
      expect(assignedDevice?.runtime.session?.ownership).toBe("owned");

      const idleDevice = data.devices.find(
        (device) => device.runtime.deviceId !== assignedDevice?.runtime.deviceId,
      );
      expect(idleDevice).toBeDefined();
      expect(idleDevice?.runtime.poolStatus).toBe("idle");

      // With a pool wired, `connectionId` names THIS connection epoch: a reused
      // serial alone cannot tell a consumer whether to flush its per-device
      // state, so the pool's incarnation is appended.
      const pooledIncarnation = devicePool.getDeviceIncarnation(assignedDevice!.runtime.deviceId!);
      expect(pooledIncarnation).toBeDefined();
      expect(assignedDevice?.runtime.connectionId).toBe(
        `${assignedDevice!.runtime.deviceId}#${pooledIncarnation}`,
      );

      // Clean up SessionManager timer to prevent process hang
      sessionManager.stopCleanupTimer();
    });

    describe("pool holds report assigned, as DevicePool.getStats() does (#11304, #11305)", () => {
      const makeHoldPool = async (
        extraFor: (
          timer: FakeTimer,
        ) => Partial<Parameters<typeof createDevicePoolDependencies>[2]> = () => ({}),
      ) => {
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
        const { FakeInstalledAppsRepository } =
          await import("../../fakes/FakeInstalledAppsRepository");
        const held: BootedDevice = { ...mockIosDevice1, deviceId: "SIM-HELD" };
        const free: BootedDevice = { ...mockIosDevice2, deviceId: "SIM-FREE" };
        fakeDeviceUtils.setBootedDevices("ios", [held, free]);
        const pool = new DevicePool(
          createDevicePoolDependencies(sessions, "hold-test", {
            timer,
            installedAppsRepository: new FakeInstalledAppsRepository(),
            deviceManager: fakeDeviceUtils,
            ...extraFor(timer),
          }),
        );
        await pool.initializeWithDevices([held, free]);
        DaemonState.getInstance().initialize(sessions, pool);
        return { pool, sessions, timer, held };
      };

      const readIos = async (timer: FakeTimer) => {
        resetBootedDevicesResourceCache();
        const result = await getBootedDevicesForPlatforms(["ios"], timer);
        const status = (deviceId: string) =>
          result.devices.find((device) => device.runtime.deviceId === deviceId)?.runtime;
        return { result, status };
      };

      test("a shutdown-reserved idle device is assigned and not counted idle", async () => {
        const { pool, sessions, timer } = await makeHoldPool();
        try {
          await pool.reserveDeviceForShutdown("SIM-HELD");
          const { result, status } = await readIos(timer);
          expect(status("SIM-HELD")?.poolStatus).toBe("assigned");
          expect(status("SIM-HELD")?.session).toBeNull();
          expect(status("SIM-FREE")?.poolStatus).toBe("idle");
          expect(result.poolStatus).toMatchObject({ idle: 1, assigned: 1 });
          expect(result.poolStatus?.idle).toBe(pool.getStats().idle);
        } finally {
          sessions.stopCleanupTimer();
        }
      });

      test("a readiness-reserved idle device is assigned and not counted idle", async () => {
        const { pool, sessions, timer, held } = await makeHoldPool();
        try {
          await pool.reserveDeviceForReadiness("SIM-HELD", held);
          const { result, status } = await readIos(timer);
          expect(status("SIM-HELD")?.poolStatus).toBe("assigned");
          expect(result.poolStatus).toMatchObject({ idle: 1, assigned: 1 });
          expect(result.poolStatus?.idle).toBe(pool.getStats().idle);
        } finally {
          sessions.stopCleanupTimer();
        }
      });

      test("a managed-slot device is assigned/held and not counted idle", async () => {
        const registry = new FakeSlotRegistry(new FakeTimer());
        await assignManagedSlotDevice(registry, "ios", "SIM-HELD");
        const { pool, sessions, timer } = await makeHoldPool((t) => ({
          managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, t),
        }));
        try {
          const { result, status } = await readIos(timer);
          expect(status("SIM-HELD")?.poolStatus).toBe("assigned");
          expect(status("SIM-HELD")?.heldBy).toBe("managed_slot");
          expect(result.poolStatus).toMatchObject({ idle: 1, assigned: 1 });
          expect(result.poolStatus?.idle).toBe(pool.getStats().idle);
          expect(pool.getAvailableDeviceCount()).toBe(1);
        } finally {
          sessions.stopCleanupTimer();
        }
      });

      test("a device another daemon drives is assigned/held and not counted idle", async () => {
        const ownership: ForeignDeviceOwnership = {
          async refresh() {},
          foreignOwnerPid: (id) => (id === "SIM-HELD" ? 4242 : undefined),
          claim: async () => true,
          release() {},
        };
        const { pool, sessions, timer } = await makeHoldPool(() => ({
          iosForeignDeviceOwnership: ownership,
        }));
        try {
          const { result, status } = await readIos(timer);
          expect(status("SIM-HELD")?.poolStatus).toBe("assigned");
          expect(status("SIM-HELD")?.heldBy).toBe("other_daemon");
          expect(result.poolStatus).toMatchObject({ idle: 1, assigned: 1 });
          expect(pool.getStats()).toMatchObject({ idle: 1, assigned: 1 });
        } finally {
          sessions.stopCleanupTimer();
        }
      });
    });

    // #11118: during the disconnect monitor's offline budget the daemon still holds the
    // session, so the listing must keep the session and pool status plus an explicit state.
    test("lists a held device adb reports offline with its session, pool status and connection", async function () {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      resetAdbClientCaches();
      // `adb devices -l` rows in the shape adb prints them; the held emulator is offline.
      const adb = new AdbClient(null, async (command: string) =>
        command.includes("adb devices")
          ? createExecResult(
              [
                "List of devices attached",
                "emulator-5554          offline transport_id:1",
                "emulator-5556          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2",
                "",
              ].join("\n"),
              "",
            )
          : createExecResult("", ""),
      );
      const emulator = new AndroidEmulatorClient(
        undefined,
        null,
        fakeTimer,
        new FakeAdbClientFactory(adb),
      );
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1, mockAndroidDevice2]);
      (fakeDeviceUtils as PlatformDeviceManager).getAndroidListedDeviceStates = (ids) =>
        emulator.getListedNonDeviceStatesAmong(ids);

      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          deviceManager: fakeDeviceUtils,
        }),
      );
      await devicePool.initializeWithDevices([mockAndroidDevice1]);
      await devicePool.assignDeviceToSession("session-held");
      expect(devicePool.getDevice(mockAndroidDevice1.deviceId)?.sessionId).toBe("session-held");
      // From here adb lists the held emulator offline, so discovery no longer returns it.
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice2]);
      DaemonState.getInstance().initialize(sessionManager, devicePool);

      const result = await getBootedDevicesForPlatforms(["android"], fakeTimer);

      const held = result.devices.find((d) => d.runtime.deviceId === "emulator-5554");
      expect(held?.runtime.session?.sessionUuid).toBe("session-held");
      expect(held?.runtime.poolStatus).toBe("assigned");
      expect(held?.runtime.connection).toEqual({ state: "offline", adbState: "offline" });
      expect(held?.runtime.readiness.state).toBe("not_ready");
      expect(listDevicesEntrySchema.shape.runtime.safeParse(held?.runtime).success).toBe(true);
      const online = result.devices.find((d) => d.runtime.deviceId === "emulator-5556");
      expect(online?.runtime.connection).toBeUndefined();
      expect(result.devices).toHaveLength(2);
      sessionManager.stopCleanupTimer();
    });

    // #11132: the held AVD re-cold-boots while adb still lists the old serial offline; the
    // listing must show it once, keeping the held row's session and pool status.
    test("does not list a held offline AVD twice while it is re-cold-booting", async function () {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      resetAdbClientCaches();
      const adb = new AdbClient(null, async (command: string) =>
        command.includes("adb devices")
          ? createExecResult(
              [
                "List of devices attached",
                "emulator-5554          offline transport_id:1",
                "",
              ].join("\n"),
              "",
            )
          : createExecResult("", ""),
      );
      const emulator = new AndroidEmulatorClient(
        undefined,
        null,
        fakeTimer,
        new FakeAdbClientFactory(adb),
      );
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);
      (fakeDeviceUtils as PlatformDeviceManager).getAndroidListedDeviceStates = (ids) =>
        emulator.getListedNonDeviceStatesAmong(ids);
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          deviceManager: fakeDeviceUtils,
        }),
      );
      await devicePool.initializeWithDevices([mockAndroidDevice1]);
      await devicePool.assignDeviceToSession("session-held");
      fakeDeviceUtils.setBootedDevices("android", []);
      DaemonState.getInstance().initialize(sessionManager, devicePool);
      setInFlightAndroidColdBootReader({
        listInFlightAndroidColdBootAvdNames: () => [mockAndroidDevice1.name],
      });

      const result = await getBootedDevicesForPlatforms(["android"], fakeTimer);

      expect(result.devices).toHaveLength(1);
      expect(result.devices[0]?.runtime.session?.sessionUuid).toBe("session-held");
      expect(result.devices[0]?.runtime.connection).toEqual({
        state: "offline",
        adbState: "offline",
      });
      sessionManager.stopCleanupTimer();
    });

    // The resource joins discovery to pool state by SERIAL. A different AVD can
    // take over a reused serial before the next pool refresh, and publishing the
    // old entry's epoch as the new runtime's `connectionId` would tell consumers
    // to KEEP state exactly when they must flush it (#6863 review).
    test("omits the pool epoch when the discovered runtime disagrees with the pooled entry", async function () {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: fakeDeviceUtils,
        }),
      );
      await devicePool.initializeWithDevices([mockAndroidDevice1, mockAndroidDevice2]);
      DaemonState.getInstance().initialize(sessionManager, devicePool);

      // emulator-5554 is now a DIFFERENT AVD; the pool has not refreshed yet.
      const replacement: BootedDevice = { ...mockAndroidDevice1, name: "Pixel_9_API_36" };
      fakeDeviceUtils.setBootedDevices("android", [replacement, mockAndroidDevice2]);

      const { client } = fixture.getContext();
      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });
      const result = await client.request(
        { method: "resources/read", params: { uri: "automobile:devices/booted" } },
        readResourceResponseSchema,
      );
      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);

      const reusedSerial = data.devices.find(
        (device) => device.runtime.deviceId === "emulator-5554",
      );
      expect(reusedSerial?.runtime.connectionId).toBe("emulator-5554");

      // The entry whose identity still agrees keeps its epoch.
      const agreeing = data.devices.find(
        (device) => device.runtime.deviceId === mockAndroidDevice2.deviceId,
      );
      expect(agreeing?.runtime.connectionId).toBe(
        `${mockAndroidDevice2.deviceId}#${devicePool.getDeviceIncarnation(mockAndroidDevice2.deviceId)}`,
      );

      sessionManager.stopCleanupTimer();
    });

    // Gating pool-derived fields one at a time leaves the ones resolved
    // SEPARATELY by serial -- the session and the registry's epoch UUID --
    // ungated, so the resource advertises the new runtime under the RETIRED
    // epoch's UUID and the desktop subscribes to streams with it. On a mismatch
    // the resource must attach no pool context at all
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    test("attaches no pool-derived context at all when the runtime disagrees", async function () {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: fakeDeviceUtils,
        }),
      );
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);
      await devicePool.initializeWithDevices([mockAndroidDevice1]);
      const sessionId = await devicePool.assignDeviceToSession("session-stale");
      expect(sessionId).toBe(mockAndroidDevice1.deviceId);
      const registry = new DeviceSessionRegistry(fakeTimer);
      registry.onDeviceConnected({
        deviceId: mockAndroidDevice1.deviceId,
        platform: "android",
        incarnation: 1,
      });
      DaemonState.getInstance().initialize(sessionManager, devicePool, registry);

      // A different AVD now holds the serial; the pool has not refreshed yet.
      fakeDeviceUtils.setBootedDevices("android", [
        { ...mockAndroidDevice1, name: "Pixel_9_API_36" },
      ]);

      try {
        const { client } = fixture.getContext();
        const result = await client.readResource({ uri: "automobile:devices/booted" });
        const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
        const entry = data.devices.find(
          (device) => device.runtime.deviceId === mockAndroidDevice1.deviceId,
        );

        expect(entry).toBeDefined();
        expect(entry?.runtime.session).toBeNull();
        expect(entry?.runtime.poolStatus).toBeNull();
        // Identity is built purely from discovery.
        expect(entry?.identity?.stableId).toBe("Pixel_9_API_36");
        expect(entry?.runtime.connectionId).toBe(mockAndroidDevice1.deviceId);
      } finally {
        sessionManager.stopCleanupTimer();
      }
    });

    // `Unknown (<serial>)` is the placeholder Android discovery emits when the
    // emulator console could not answer `avd name`. It asserts nothing, so it
    // is not agreement with the pooled entry: publishing that entry's epoch
    // would tell consumers to keep state across a possible serial reuse, and
    // publishing its AVD label as `stableId` would name a device that may no
    // longer be the one running (#6863 review).
    test("withholds the pool epoch and the pooled AVD name for an unresolved runtime name", async function () {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: fakeDeviceUtils,
        }),
      );
      // `addDevice` records the AVD this pool started, which is what would be
      // published as `stableId` for an emulator whose runtime name is unknown.
      await devicePool.addDevice(mockAndroidDevice1, {
        name: mockAndroidDevice1.name,
        platform: "android",
        isRunning: true,
        source: "local",
      });
      DaemonState.getInstance().initialize(sessionManager, devicePool);

      const unresolved: BootedDevice = {
        ...mockAndroidDevice1,
        name: `Unknown (${mockAndroidDevice1.deviceId})`,
      };
      fakeDeviceUtils.setBootedDevices("android", [unresolved]);

      const { client } = fixture.getContext();
      const result = await client.readResource({ uri: "automobile:devices/booted" });
      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
      const device = data.devices.find((entry) => entry.runtime.deviceId === unresolved.deviceId);

      expect(device?.runtime.connectionId).toBe(unresolved.deviceId);
      expect(device?.identity?.stableId).toBe(unresolved.name);

      sessionManager.stopCleanupTimer();
    });

    // Withholding this read's OWN output is not enough: the pool flag is what the
    // admission gate, the destructive-confirmation path and every stream resolver
    // consult, so a resource read that is the FIRST discovery to see the
    // placeholder has to fold its observation into the pool. Otherwise the bound
    // session keeps passing `assertSessionReadyForAutomation` until an unrelated
    // allocation or refresh happens to reconcile
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    test("quarantines the pooled entry when the resource read is the first to see the placeholder", async function () {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: fakeDeviceUtils,
        }),
      );
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);
      await devicePool.initializeWithDevices([mockAndroidDevice1]);
      const assigned = await devicePool.assignDeviceToSession("session-owner");
      expect(assigned).toBe(mockAndroidDevice1.deviceId);
      DaemonState.getInstance().initialize(sessionManager, devicePool);
      expect(() => devicePool.assertSessionReadyForAutomation("session-owner")).not.toThrow();

      // The emulator console has gone quiet; this read is the only discovery.
      fakeDeviceUtils.setBootedDevices("android", [
        { ...mockAndroidDevice1, name: `Unknown (${mockAndroidDevice1.deviceId})` },
      ]);

      try {
        const { client } = fixture.getContext();
        await client.readResource({ uri: "automobile:devices/booted" });

        expect(devicePool.isPooledIdentityUnresolved(mockAndroidDevice1.deviceId)).toBe(true);
        // The session survives, but its next tool call is refused.
        expect(() => devicePool.assertSessionReadyForAutomation("session-owner")).toThrow(
          /identity is unresolved/,
        );
      } finally {
        sessionManager.stopCleanupTimer();
      }
    });

    // Entering the quarantine is not the end of this request: the same read then
    // enriched every discovered entry, issuing package/service queries and
    // `adb dumpsys window policy` against whichever runtime now owns the serial.
    // A serial the pool can no longer identify is exactly the one not to probe,
    // so it is skipped and published with discovery-only identity plus an
    // explicit marker saying why
    // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    test("skips enrichment for a serial this read just quarantined", async function () {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: fakeDeviceUtils,
        }),
      );
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1, mockAndroidDevice2]);
      await devicePool.initializeWithDevices([mockAndroidDevice1, mockAndroidDevice2]);
      DaemonState.getInstance().initialize(sessionManager, devicePool);
      const lockProbes: string[] = [];
      setDeviceLockProbe(async (device) => {
        lockProbes.push(device.deviceId);
        return true;
      });

      // Only the first emulator's console has gone quiet.
      fakeDeviceUtils.setBootedDevices("android", [
        { ...mockAndroidDevice1, name: `Unknown (${mockAndroidDevice1.deviceId})` },
        mockAndroidDevice2,
      ]);

      try {
        const { client } = fixture.getContext();
        const result = await client.readResource({ uri: "automobile:devices/booted" });
        const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
        const quarantined = data.devices.find(
          (entry) => entry.runtime.deviceId === mockAndroidDevice1.deviceId,
        );
        const healthy = data.devices.find(
          (entry) => entry.runtime.deviceId === mockAndroidDevice2.deviceId,
        );

        expect(devicePool.isPooledIdentityUnresolved(mockAndroidDevice1.deviceId)).toBe(true);
        expect(lockProbes).toEqual([mockAndroidDevice2.deviceId]);
        expect(quarantined?.identityUnresolved).toBe(true);
        expect(quarantined?.runtime.locked).toBeNull();
        expect(healthy?.identityUnresolved).toBe(false);
        expect(healthy?.runtime.locked).toBe(true);
        expect(quarantined && "locked" in quarantined).toBe(false);
        expect(healthy && "locked" in healthy).toBe(false);
      } finally {
        sessionManager.stopCleanupTimer();
      }
    });

    test("exposes the registry routing key separately from the MCP session UUID", async function () {
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);

      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: fakeDeviceUtils,
        }),
      );
      await devicePool.initializeWithDevices([mockAndroidDevice1]);
      const registry = new DeviceSessionRegistry(fakeTimer);
      registry.onDeviceConnected({
        deviceId: mockAndroidDevice1.deviceId,
        platform: "android",
        incarnation: 1,
      });
      DaemonState.getInstance().initialize(sessionManager, devicePool, registry);

      try {
        const { client } = fixture.getContext();
        const result = await client.readResource({ uri: "automobile:devices/booted" });
        const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);

        expect(data.devices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runtime: expect.objectContaining({
                deviceId: mockAndroidDevice1.deviceId,
                lifecycle: { state: "booted", known: false },
                session: null,
                deviceSessionUuid: registry.getByDeviceId(mockAndroidDevice1.deviceId)
                  ?.deviceSessionUuid,
              }),
            }),
          ]),
        );
      } finally {
        sessionManager.stopCleanupTimer();
      }
    });

    test("should not include phantom pool devices in pool status", async function () {
      fakeDeviceUtils.setBootedDevices("android", []);

      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const fakeAppsRepo = new FakeInstalledAppsRepository();
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: fakeAppsRepo,
        }),
      );
      await devicePool.initializeWithDevices([mockAndroidDevice1]);
      DaemonState.getInstance().initialize(sessionManager, devicePool);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted",
          },
        },
        readResourceResponseSchema,
      );

      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
      expect(data.devices).toHaveLength(0);
      expect(data.poolStatus).toEqual({
        enabled: true,
        idle: 0,
        assigned: 0,
        error: 0,
        total: 0,
        recoveryPolicy: { onLoss: false, maxAttempts: 2 },
      });

      sessionManager.stopCleanupTimer();
    });

    test("preserves pool stats for a platform whose discovery fails", async function () {
      // Android discovery succeeds with zero booted devices; iOS discovery fails
      // after the iOS device has already been assigned.
      fakeDeviceUtils.setBootedDevices("android", []);
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1]);

      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      const { FakeInstalledAppsRepository } =
        await import("../../fakes/FakeInstalledAppsRepository");
      const fakeAppsRepo = new FakeInstalledAppsRepository();
      const devicePool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: fakeAppsRepo,
          deviceManager: fakeDeviceUtils,
        }),
      );
      // An idle Android phantom (no longer booted) plus an assigned iOS device.
      await devicePool.initializeWithDevices([mockAndroidDevice1, mockIosDevice1]);
      await devicePool.assignDeviceToSession("session-ios", "ios");
      fakeDeviceUtils.setBootedDevices("ios", []);
      fakeDeviceUtils.failedPlatforms = new Set<Platform>(["ios"]);
      DaemonState.getInstance().initialize(sessionManager, devicePool);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted",
          },
        },
        readResourceResponseSchema,
      );

      const data: BootedDevicesResourceContent = JSON.parse(result.contents[0].text!);
      // The Android phantom is dropped (android discovery succeeded, empty), but
      // the still-tracked iOS device is preserved because iOS discovery failed.
      expect(data.observationComplete).toBe(false);
      expect(data.platformObservations).toEqual({
        android: { observationComplete: true },
        ios: {
          observationComplete: false,
          discoveryError: {
            code: "unavailable",
            message: "iOS booted-device discovery is unavailable.",
          },
        },
      });
      expect(data.poolStatus).toEqual({
        enabled: true,
        idle: 0,
        assigned: 1,
        error: 0,
        total: 1,
        recoveryPolicy: { onLoss: false, maxAttempts: 2 },
      });

      sessionManager.stopCleanupTimer();
    });

    test("should return error for invalid platform", async function () {
      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      const result = await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted/invalid",
          },
        },
        readResourceResponseSchema,
      );

      // Verify error response
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      const data = JSON.parse(content.text!);
      expect(data).toHaveProperty("error");
      expect(data.error).toContain("Invalid platform");
    });
  });

  describe("Device Manager Integration", () => {
    test("should call getBootedDevices for android when filtering", async function () {
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted/android",
          },
        },
        readResourceResponseSchema,
      );

      // Verify getBootedDevices was called for android
      expect(fakeDeviceUtils.wasMethodCalled("getBootedDevices")).toBe(true);
      const operations = fakeDeviceUtils.getExecutedOperations();
      expect(operations).toContain("getBootedDevices:android");
    });

    test("should call getBootedDevices for both platforms when requesting all devices", async function () {
      fakeDeviceUtils.setBootedDevices("android", [mockAndroidDevice1]);
      fakeDeviceUtils.setBootedDevices("ios", [mockIosDevice1]);

      const { client } = fixture.getContext();

      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      });

      await client.request(
        {
          method: "resources/read",
          params: {
            uri: "automobile:devices/booted",
          },
        },
        readResourceResponseSchema,
      );

      // Verify getBootedDevices was called for both platforms
      const operations = fakeDeviceUtils.getExecutedOperations();
      expect(operations).toContain("getBootedDevices:android");
      expect(operations).toContain("getBootedDevices:ios");
    });
  });
});

describe("ResourceRegistry Template Matching", () => {
  beforeEach(() => {
    ResourceRegistry.clearResources();
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
  });

  test("should match simple template with single parameter", () => {
    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Test Item",
      "Test item description",
      "application/json",
      async (params) => ({
        uri: `test://items/${params.id}`,
        mimeType: "application/json",
        text: JSON.stringify({ id: params.id }),
      }),
    );

    const match = ResourceRegistry.matchTemplate("test://items/123");
    expect(match).toBeDefined();
    expect(match!.params).toEqual({ id: "123" });
    expect(match!.template.uriTemplate).toBe("test://items/{id}");
  });

  test("should match template with multiple parameters", () => {
    ResourceRegistry.registerTemplate(
      "test://users/{userId}/posts/{postId}",
      "User Post",
      "A user's post",
      "application/json",
      async (params) => ({
        uri: `test://users/${params.userId}/posts/${params.postId}`,
        mimeType: "application/json",
        text: JSON.stringify(params),
      }),
    );

    const match = ResourceRegistry.matchTemplate("test://users/user-123/posts/post-456");
    expect(match).toBeDefined();
    expect(match!.params).toEqual({ userId: "user-123", postId: "post-456" });
  });

  test("should not match non-matching URIs", () => {
    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Test Item",
      "Test item description",
      "application/json",
      async (params) => ({
        uri: `test://items/${params.id}`,
        mimeType: "application/json",
        text: "{}",
      }),
    );

    expect(ResourceRegistry.matchTemplate("test://other/123")).toBeUndefined();
    expect(ResourceRegistry.matchTemplate("test://items/")).toBeUndefined();
    expect(ResourceRegistry.matchTemplate("test://items")).toBeUndefined();
  });

  test("should prefer exact resource match over template", () => {
    // Register both exact resource and template
    ResourceRegistry.register(
      "test://items/special",
      "Special Item",
      "A special item",
      "application/json",
      async () => ({
        uri: "test://items/special",
        mimeType: "application/json",
        text: JSON.stringify({ type: "exact" }),
      }),
    );

    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Generic Item",
      "A generic item",
      "application/json",
      async (params) => ({
        uri: `test://items/${params.id}`,
        mimeType: "application/json",
        text: JSON.stringify({ type: "template", id: params.id }),
      }),
    );

    // Exact match should be found
    const exactResource = ResourceRegistry.getResource("test://items/special");
    expect(exactResource).toBeDefined();
    expect(exactResource!.name).toBe("Special Item");

    // Template should still match other URIs
    const templateMatch = ResourceRegistry.matchTemplate("test://items/other");
    expect(templateMatch).toBeDefined();
    expect(templateMatch!.params.id).toBe("other");
  });

  test("should return template definitions in correct format", () => {
    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Test Item",
      "Test item description",
      "application/json",
      async () => ({
        uri: "test://items/1",
        mimeType: "application/json",
        text: "{}",
      }),
    );

    const definitions = ResourceRegistry.getTemplateDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toEqual({
      uriTemplate: "test://items/{id}",
      name: "Test Item",
      description: "Test item description",
      mimeType: "application/json",
    });
  });

  test("precompiles the template regex once at registration and reuses it across reads (#3427)", () => {
    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Test Item",
      "Test item description",
      "application/json",
      async (params) => ({ uri: `test://items/${params.id}`, text: "{}" }),
    );

    const first = ResourceRegistry.matchTemplate("test://items/1");
    const second = ResourceRegistry.matchTemplate("test://items/2");
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // The compiled RegExp is stored on the template and the SAME instance is
    // returned on every read — proof it is not recompiled per request.
    const firstRegex = (first!.template as unknown as { regex: RegExp }).regex;
    const secondRegex = (second!.template as unknown as { regex: RegExp }).regex;
    expect(firstRegex).toBeInstanceOf(RegExp);
    expect(firstRegex).toBe(secondRegex);
  });

  test("does not construct a new RegExp during matchTemplate (#3427)", () => {
    ResourceRegistry.registerTemplate(
      "test://items/{id}",
      "Test Item",
      "Test item description",
      "application/json",
      async (params) => ({ uri: `test://items/${params.id}`, text: "{}" }),
    );

    // Count RegExp constructions while only reading, not registering.
    const OriginalRegExp = globalThis.RegExp;
    let constructions = 0;
    class CountingRegExp extends OriginalRegExp {
      constructor(...args: ConstructorParameters<typeof OriginalRegExp>) {
        super(...args);
        constructions++;
      }
    }
    (globalThis as { RegExp: typeof RegExp }).RegExp = CountingRegExp as typeof RegExp;
    try {
      ResourceRegistry.matchTemplate("test://items/1");
      ResourceRegistry.matchTemplate("test://items/2");
      ResourceRegistry.matchTemplate("test://items/3");
    } finally {
      (globalThis as { RegExp: typeof RegExp }).RegExp = OriginalRegExp;
    }

    expect(constructions).toBe(0);
  });

  test("matches a trailing {path} param greedily across slashes", () => {
    ResourceRegistry.registerTemplate(
      "test://files/{id}/{path}",
      "File",
      "A nested file",
      "application/json",
      async (params) => ({ uri: `test://files/${params.id}/${params.path}`, text: "{}" }),
    );

    const match = ResourceRegistry.matchTemplate("test://files/app1/dir/sub/file.txt");
    expect(match).toBeDefined();
    expect(match!.params).toEqual({ id: "app1", path: "dir/sub/file.txt" });
  });
});

describe("booted device readiness", () => {
  const compatibleService = {
    installed: true,
    enabled: true,
    running: true,
    installedSha256: "a".repeat(64),
    expectedSha256: "a".repeat(64),
    isCompatible: true,
  };

  test("reports a connected Android runner as ready and an unobserved runner as unknown", () => {
    expect(readinessFromServiceStatus("android", compatibleService)).toEqual({ state: "ready" });
    expect(readinessFromServiceStatus("android", { ...compatibleService, running: false })).toEqual(
      { state: "unknown" },
    );
  });

  test("reads Android connection transitions without creating a connection", async () => {
    const adbSpy = spyOn(defaultAdbClientFactory, "create");
    const connections = new Set(["emulator-5554"]);
    const lookup: AndroidServiceStatusLookup = {
      getManager: () => ({
        isInstalled: async () => true,
        isEnabled: async () => true,
        getInstalledApkSha256: async () => null,
      }),
      isConnected: (deviceId) => connections.has(deviceId),
    };
    const device = {
      name: "Pixel",
      platform: "android" as const,
      deviceId: "emulator-5554",
      source: "local" as const,
    };
    try {
      expect((await queryDeviceServiceStatus(device, lookup))?.running).toBe(true);
      connections.clear();
      expect((await queryDeviceServiceStatus(device, lookup))?.running).toBe(false);
      expect(
        (await queryDeviceServiceStatus({ ...device, deviceId: "unseen" }, lookup))?.running,
      ).toBe(false);
      expect(adbSpy).not.toHaveBeenCalled();
    } finally {
      adbSpy.mockRestore();
    }
  });

  test("reads Android package versions via ADB without constructing CtrlProxy", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell dumpsys package 'com.example.ctrlproxy'", {
      stdout: "versionCode=45\nversionName=1.2.3\ncodePath=/data/app/ctrlproxy",
      stderr: "",
    });
    const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance");
    try {
      const metadata = await getAndroidAppMetadataViaAdb(
        { name: "Pixel", platform: "android", deviceId: "emulator-5554", source: "local" },
        "com.example.ctrlproxy",
        { create: () => adb },
      );

      expect(metadata).toMatchObject({ versionName: "1.2.3", buildNumber: "45" });
      expect(getInstanceSpy).not.toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("adds Android CtrlProxy installed-artifact version without changing service compatibility", async () => {
    const lookup: AndroidServiceStatusLookup = {
      getManager: () => ({
        isInstalled: async () => true,
        isEnabled: async () => true,
        getInstalledApkSha256: async () => "a".repeat(64),
      }),
      isConnected: () => true,
    };
    const versionLookup: CtrlProxyVersionLookup = {
      getVersion: async () => ({
        versionName: "1.2.3",
        versionCode: "45",
        source: "android-package",
      }),
    };

    const device = {
      name: "Pixel",
      platform: "android" as const,
      deviceId: "emulator-5554",
      source: "local" as const,
    };
    const withoutVersion = await queryDeviceServiceStatus(device, lookup, {
      getVersion: async () => undefined,
    });

    const status = await queryDeviceServiceStatus(device, lookup, versionLookup);

    expect(status).toEqual({
      ...withoutVersion,
      version: "1.2.3",
      versionInfo: { versionName: "1.2.3", versionCode: "45", source: "android-package" },
    });
  });

  test("omits Android CtrlProxy version when the package is not installed", async () => {
    const lookup: AndroidServiceStatusLookup = {
      getManager: () => ({
        isInstalled: async () => false,
        isEnabled: async () => false,
        getInstalledApkSha256: async () => null,
      }),
      isConnected: () => false,
    };

    const status = await queryDeviceServiceStatus(
      { name: "Pixel", platform: "android", deviceId: "emulator-5554", source: "local" },
      lookup,
      {
        getVersion: async () => ({
          versionName: "1.2.3",
          versionCode: "45",
          source: "android-package",
        }),
      },
    );

    expect(status?.installed).toBe(false);
    expect(status?.version).toBeUndefined();
  });

  test("omits iOS CtrlProxy version unless that device's runner is running", async () => {
    const installedSpy = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(
      true,
    );
    const runningSpy = spyOn(
      IOSCtrlProxyManager.prototype,
      "checkRunningWithReason",
    ).mockResolvedValue({ ok: false, reason: "unhealthy" });
    const versionLookup: CtrlProxyVersionLookup = {
      getVersion: async () => ({
        versionName: "2.0.0",
        build: "200",
        source: "ios-runner-bundle",
      }),
    };
    try {
      const status = await queryDeviceServiceStatus(
        {
          name: "iPhone",
          platform: "ios",
          deviceId: "00000000-0000-0000-0000-000000000000",
          source: "local",
        },
        undefined,
        versionLookup,
      );

      expect(status?.version).toBeUndefined();
    } finally {
      installedSpy.mockRestore();
      runningSpy.mockRestore();
    }
  });

  test("reports exhausted iOS recovery in listDevices status and omits it after reset", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = {
      name: "iPhone",
      platform: "ios",
      deviceId: "00000000-0000-0000-0000-000000007676",
      source: "local",
    };
    const manager = IOSCtrlProxyManager.getInstance(device, timer);
    const budget = manager.getForcedRestartBudget();
    const installed = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(true);
    const running = spyOn(
      IOSCtrlProxyManager.prototype,
      "checkRunningWithReason",
    ).mockResolvedValue({ ok: false, reason: "unhealthy" });
    try {
      for (const delay of [30_000, 60_000, 0]) {
        const token = budget.tryBeginAttempt()!;
        budget.recordFailure("xcodebuild startup timeout", token);
        timer.advanceTime(delay);
      }
      const exhausted = await queryDeviceServiceStatus(
        device,
        undefined,
        { getVersion: async () => undefined },
        timer,
      );
      expect(exhausted?.recovery).toEqual({
        state: "exhausted",
        attempts: 3,
        reason: "CtrlProxy restart failed",
      });
      const description = describeDevice({ kind: "booted", device, serviceStatus: exhausted });
      expect(description.runtime.readiness.state).toBe("not_ready");
      expect(listDevicesEntrySchema.parse(description).runtime.serviceStatus?.recovery).toEqual(
        exhausted?.recovery,
      );

      budget.recordSuccess();
      const idle = await queryDeviceServiceStatus(
        device,
        undefined,
        { getVersion: async () => undefined },
        timer,
      );
      expect(idle?.recovery).toBeUndefined();
    } finally {
      installed.mockRestore();
      running.mockRestore();
      IOSCtrlProxyManager.resetInstances();
    }
  });

  test("reads iOS recovery after pending version lookup settles", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = {
      name: "iPhone",
      platform: "ios",
      deviceId: "00000000-0000-0000-0000-000000007735",
      source: "local",
    };
    const manager = IOSCtrlProxyManager.getInstance(device, timer);
    const budget = manager.getForcedRestartBudget();
    const installed = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(true);
    const running = spyOn(
      IOSCtrlProxyManager.prototype,
      "checkRunningWithReason",
    ).mockResolvedValue({ ok: false, reason: "unhealthy" });
    let releaseVersion!: () => void;
    let enteredVersion!: () => void;
    const versionEntered = new Promise<void>((resolve) => (enteredVersion = resolve));
    const pendingVersion = new Promise<undefined>((resolve) => {
      releaseVersion = () => resolve(undefined);
    });
    try {
      const statusPromise = queryDeviceServiceStatus(
        device,
        undefined,
        {
          getVersion: () => {
            enteredVersion();
            return pendingVersion;
          },
        },
        timer,
      );
      await versionEntered;
      budget.suspend("device disappeared from discovery");
      releaseVersion();
      expect((await statusPromise)?.recovery?.state).toBe("suspended");
    } finally {
      installed.mockRestore();
      running.mockRestore();
      IOSCtrlProxyManager.resetInstances();
    }
  });

  test("does not expose raw restart exception text in iOS device status", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = {
      name: "iPhone",
      platform: "ios",
      deviceId: "00000000-0000-0000-0000-000000007753",
      source: "local",
    };
    const manager = IOSCtrlProxyManager.getInstance(device, timer);
    const budget = manager.getForcedRestartBudget();
    const installed = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(true);
    const running = spyOn(
      IOSCtrlProxyManager.prototype,
      "checkRunningWithReason",
    ).mockResolvedValue({ ok: false, reason: "unhealthy" });
    try {
      const token = budget.tryBeginAttempt()!;
      budget.recordFailure(`/private/secret/path ${"s".repeat(1000)}`, token);
      const status = await queryDeviceServiceStatus(
        device,
        undefined,
        { getVersion: async () => undefined },
        timer,
      );
      expect(status?.recovery?.reason).toBe("CtrlProxy restart failed");
    } finally {
      installed.mockRestore();
      running.mockRestore();
      IOSCtrlProxyManager.resetInstances();
    }
  });

  test("adds iOS CtrlProxy version when that device's runner is running", async () => {
    const installedSpy = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(
      true,
    );
    const runningSpy = spyOn(
      IOSCtrlProxyManager.prototype,
      "checkRunningWithReason",
    ).mockResolvedValue({ ok: true });
    try {
      const status = await queryDeviceServiceStatus(
        {
          name: "iPhone",
          platform: "ios",
          deviceId: "00000000-0000-0000-0000-000000000000",
          source: "local",
        },
        undefined,
        { getVersion: async () => ({ build: "200", source: "ios-runner-bundle" }) },
      );

      expect(status?.version).toBe("200");
      expect(status?.versionInfo).toEqual({ build: "200", source: "ios-runner-bundle" });
    } finally {
      installedSpy.mockRestore();
      runningSpy.mockRestore();
    }
  });

  test("omits iOS CtrlProxy version when it is not installed on that device", async () => {
    const installedSpy = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(
      false,
    );
    const runningSpy = spyOn(
      IOSCtrlProxyManager.prototype,
      "checkRunningWithReason",
    ).mockResolvedValue({ ok: false, reason: "unhealthy" });
    try {
      const status = await queryDeviceServiceStatus(
        {
          name: "iPhone",
          platform: "ios",
          deviceId: "00000000-0000-0000-0000-000000000000",
          source: "local",
        },
        undefined,
        { getVersion: async () => ({ build: "other-device", source: "ios-runner-bundle" }) },
      );

      expect(status?.installed).toBe(false);
      expect(status?.version).toBeUndefined();
      expect("version" in (status ?? {})).toBe(false);
    } finally {
      installedSpy.mockRestore();
      runningSpy.mockRestore();
    }
  });

  test("keeps Android service status when CtrlProxy version lookup is unavailable", async () => {
    const lookup: AndroidServiceStatusLookup = {
      getManager: () => ({
        isInstalled: async () => true,
        isEnabled: async () => true,
        getInstalledApkSha256: async () => "a".repeat(64),
      }),
      isConnected: () => true,
    };
    const versionLookup: CtrlProxyVersionLookup = {
      getVersion: async () => Promise.reject(new Error("metadata unavailable")),
    };

    const status = await queryDeviceServiceStatus(
      {
        name: "Pixel",
        platform: "android",
        deviceId: "emulator-5554",
        source: "local",
      },
      lookup,
      versionLookup,
    );

    expect(status).toMatchObject({
      installed: true,
      enabled: true,
      running: true,
      isCompatible: false,
    });
    expect(status?.version).toBeUndefined();
  });

  test("keeps Android service status when CtrlProxy version lookup times out", async () => {
    const timer = new FakeTimer();
    const lookup: AndroidServiceStatusLookup = {
      getManager: () => ({
        isInstalled: async () => true,
        isEnabled: async () => true,
        getInstalledApkSha256: async () => "a".repeat(64),
      }),
      isConnected: () => true,
    };
    const statusPromise = queryDeviceServiceStatus(
      {
        name: "Pixel",
        platform: "android",
        deviceId: "emulator-5554",
        source: "local",
      },
      lookup,
      { getVersion: async () => new Promise(() => {}) },
      timer,
    );

    await Promise.resolve();
    timer.advanceTime(2000);

    const status = await statusPromise;
    expect(status?.installed).toBe(true);
    expect(status?.enabled).toBe(true);
    expect(status?.running).toBe(true);
    expect(status?.installedSha256).toBe("a".repeat(64));
    expect(status?.expectedSha256).toBe(resolveApkChecksum());
    expect(status?.isCompatible).toBe(false);
    expect(status?.version).toBeUndefined();
  });

  test("keeps iOS service status when CtrlProxy version lookup times out", async () => {
    const timer = new FakeTimer();
    const installedSpy = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(
      true,
    );
    const runningSpy = spyOn(
      IOSCtrlProxyManager.prototype,
      "checkRunningWithReason",
    ).mockResolvedValue({ ok: false, reason: "unhealthy" });
    try {
      const statusPromise = queryDeviceServiceStatus(
        {
          name: "iPhone",
          platform: "ios",
          deviceId: "00000000-0000-0000-0000-000000000000",
          source: "local",
        },
        undefined,
        { getVersion: async () => new Promise(() => {}) },
        timer,
      );

      await Promise.resolve();
      timer.advanceTime(2000);

      const status = await statusPromise;
      expect(status?.installed).toBe(true);
      expect(status?.enabled).toBe(false);
      expect(status?.running).toBe(false);
      expect(status?.installedSha256).toBeNull();
      expect(status?.expectedSha256).toBe(resolveIpaChecksum());
      expect(status?.isCompatible).toBe(false);
      expect(status?.supportedCommandsComplete).toBeNull();
      expect(status?.supportedFeaturesComplete).toBeNull();
      expect(status?.version).toBeUndefined();
    } finally {
      installedSpy.mockRestore();
      runningSpy.mockRestore();
    }
  });

  test("uses persisted iOS runner bundle identity instead of the host app plist version", async () => {
    const installedSpy = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(
      true,
    );
    const runningSpy = spyOn(
      IOSCtrlProxyManager.prototype,
      "checkRunningWithReason",
    ).mockResolvedValue({ ok: true });
    const versionSpy = spyOn(
      IOSCtrlProxyManager.prototype,
      "getInstalledVersionIdentity",
    ).mockResolvedValue("2026.9.13");
    try {
      const status = await queryDeviceServiceStatus({
        name: "iPhone",
        platform: "ios",
        deviceId: "00000000-0000-0000-0000-000000000000",
        source: "local",
      });

      expect(status?.version).toBe("2026.9.13");
      expect(status?.versionInfo).toEqual({
        build: "2026.9.13",
        source: "ios-runner-bundle",
      });
    } finally {
      installedSpy.mockRestore();
      runningSpy.mockRestore();
      versionSpy.mockRestore();
    }
  });

  test("omits iOS version when no persisted runner bundle metadata exists", async () => {
    const installedSpy = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(
      true,
    );
    const runningSpy = spyOn(
      IOSCtrlProxyManager.prototype,
      "checkRunningWithReason",
    ).mockResolvedValue({ ok: false, reason: "unhealthy" });
    const versionSpy = spyOn(
      IOSCtrlProxyManager.prototype,
      "getInstalledVersionIdentity",
    ).mockResolvedValue(null);
    try {
      const status = await queryDeviceServiceStatus({
        name: "iPhone",
        platform: "ios",
        deviceId: "00000000-0000-0000-0000-000000000000",
        source: "local",
      });

      expect(status?.version).toBeUndefined();
    } finally {
      installedSpy.mockRestore();
      runningSpy.mockRestore();
      versionSpy.mockRestore();
    }
  });

  test("reports an unavailable Android service as not ready", () => {
    expect(
      readinessFromServiceStatus("android", {
        ...compatibleService,
        enabled: false,
        running: false,
      }),
    ).toEqual({ state: "not_ready" });
  });

  test("reports a verified iOS runner as ready", () => {
    expect(readinessFromServiceStatus("ios", compatibleService)).toEqual({ state: "ready" });
  });
});
