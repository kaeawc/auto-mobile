import { tvConfigReader } from "../fixtures/android-tv-avd";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { parseAvdConfig } from "../../src/utils/android-cmdline-tools/AvdConfigReader";
import { ActionableError, type DeviceInfo } from "../../src/models";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { assignBindingDevice } from "../daemon/sessionBroker/provisioning/bindingFixtures";
import {
  bindingRefusal,
  RegistryBindingExclusion,
} from "../../src/daemon/sessionBroker/provisioning/exclusion";
import {
  DefaultExactDeviceProvisioner,
  FileAndroidAvdConfigWriter,
  ProvisionDeviceError,
  DEFAULT_PROVISION_DEVICE_RETRYABILITY,
  type AndroidAvdConfigWriter,
  type ExactAndroidAvdClient,
  type ExactIosRuntimeCatalog,
  type ExactIosSimulatorClient,
} from "../../src/devices/exactDeviceProvisioning";

const ANDROID_SPEC = {
  runtime: "system-images;android-36;google_apis;x86_64",
  deviceType: "pixel_9",
  configuration: { memoryMb: 4096 },
} as const;

function androidImage(name: string): DeviceInfo {
  return {
    name,
    platform: "android",
    isRunning: false,
  };
}

describe("ProvisionDeviceError retryability", () => {
  test("uses deliberate defaults for every provisioning failure code", () => {
    expect(DEFAULT_PROVISION_DEVICE_RETRYABILITY).toEqual({
      cleanup_failed: false,
      creation_not_allowed: false,
      device_lost: true,
      device_owned_by_other_session: true,
      device_owned_by_other_daemon: true,
      device_cleanup_in_progress: true,
      session_creation_timeout: true,
      device_shutting_down: true,
      device_assigned_to_binding: false,
      device_offline: true,
      discovery_incomplete: true,
      capacity_exhausted: true,
      identity_conflict: false,
      timeout: true,
      unsupported: false,
      platform_command_failed: false,
      resource_profile_unproven: false,
      unsafe_device_resource_combination: false,
      runtime_incompatible: false,
      requires_real_device: false,
    });
  });

  test.each([
    ["timeout", true],
    ["identity_conflict", false],
  ] as const)("defaults %s to retryable=%s", (code, retryable) => {
    expect(new ProvisionDeviceError(code, "failure").retryable).toBe(retryable);
  });

  test("allows an explicit retryability value to override the default", () => {
    expect(new ProvisionDeviceError("timeout", "failure", false).retryable).toBe(false);
    expect(new ProvisionDeviceError("identity_conflict", "failure", true).retryable).toBe(true);
  });
});

describe("DefaultExactDeviceProvisioner", () => {
  test("refuses to adopt an existing device a binding holds, before reading its config (#11174)", async () => {
    const timer = new FakeTimer();
    const registry = new FakeBindingRegistry(timer);
    const binding = await assignBindingDevice(registry, "android", "slot-avd");
    const exclusion = new RegistryBindingExclusion(async () => registry, timer);
    const configReads: string[] = [];
    const guarded: string[] = [];
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("slot-avd")],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: {
        readConfig: async (name: string) => {
          configReads.push(name);
          return null;
        },
      },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {} as ExactIosSimulatorClient,
      assertAdoptable: async (device) => {
        guarded.push(`${device.platform}:${device.stableId}`);
        await exclusion.refresh();
        const refusal = bindingRefusal(exclusion, {
          action: "provisionDevice",
          deviceId: device.stableId,
          device: { platform: device.platform, stableIds: [device.stableId] },
        });
        if (refusal) {
          throw refusal;
        }
      },
    });

    const error = await provisioner
      .provision({ platform: "android", name: "slot-avd", spec: ANDROID_SPEC })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProvisionDeviceError);
    expect(error).toMatchObject({
      code: "device_assigned_to_binding",
      retryable: false,
      diagnostics: {
        deviceId: "slot-avd",
        binding: { scopeKey: binding.scopeKey, declaredBinding: 0, stableId: "slot-avd" },
      },
    });
    expect(guarded).toEqual(["android:slot-avd"]);
    expect(configReads).toEqual([]);
  });

  test("invalidates cached Android AVD provenance after exact creation", async () => {
    AndroidAvdProvenanceCache.resetForTests();
    try {
      const cache = AndroidAvdProvenanceCache.getInstance();
      const avdManager = new FakeAvdManager();
      const timer = new FakeTimer();
      avdManager.setListDeviceImagesResponse([]);
      await cache.getByName(avdManager, timer);
      expect(cache.getCachedByName()).toBeDefined();
      const provisioner = new DefaultExactDeviceProvisioner({
        listDeviceImages: async () => [],
        isCreationAllowed: () => true,
        avdManager: {
          listInstalledSystemImages: async () => [],
          createAvd: async (params) => ({
            success: true,
            message: "created",
            avdName: params.name,
          }),
        },
        androidConfigReader: { readConfig: async () => null },
        androidConfigWriter: {} as AndroidAvdConfigWriter,
        iosSimulator: {} as ExactIosSimulatorClient,
      });

      await provisioner.provision({
        platform: "android",
        name: "phone-api-36-a",
        spec: { ...ANDROID_SPEC, configuration: {} },
        onBeforeCreate: () => {},
      });
      expect(cache.getCachedByName()).toBeUndefined();
    } finally {
      AndroidAvdProvenanceCache.resetForTests();
    }
  });

  test("writes and reads independent hardware options without changing other AVD properties", async () => {
    let content = "hw.cpu.ncore = 4\nhw.ramSize=2048\nuntouched=yes\n";
    const writer = new FileAndroidAvdConfigWriter({
      readFile: async () => content,
      writeFile: async (_path, updated) => {
        content = updated;
      },
      environment: { ANDROID_AVD_HOME: "/avds" },
      homeDirectory: () => "/home/test",
    });
    const configuration = {
      cpuCores: 2,
      gpuMode: "host",
      screenWidth: 720,
      screenHeight: 1280,
      screenDensity: 280,
      cameraFront: "none",
      audioInput: false,
      audioOutput: true,
    } as const;
    await writer.setConfiguration("phone", configuration);
    expect(parseAvdConfig(content).hardware).toMatchObject(configuration);
    expect(content).toContain("untouched=yes");
    expect(content).toContain("hw.ramSize=2048");
    expect(content).toContain("hw.gpu.enabled=yes");
    expect(content).not.toContain("hw.cpu.ncore = 4");
    const before = content;
    await expect(writer.setConfiguration("phone", { cpuCores: 0 })).rejects.toThrow();
    expect(content).toBe(before);
  });
  test("updates only hw.ramSize in the conventional AVD config", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const writer = new FileAndroidAvdConfigWriter({
      readFile: async () => "avd.ini.displayname=phone-api-36-a\nhw.ramSize=2048\n",
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      environment: { ANDROID_AVD_HOME: "/avds" },
      homeDirectory: () => "/home/test",
    });

    await writer.setMemoryMb("phone-api-36-a", 4096);

    expect(writes).toEqual([
      {
        path: join("/avds", "phone-api-36-a.avd", "config.ini"),
        content: "avd.ini.displayname=phone-api-36-a\nhw.ramSize=4096\n",
      },
    ]);
  });

  test("cancellation while reading prevents a later config write", async () => {
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<string>();
    const writes: string[] = [];
    const writer = new FileAndroidAvdConfigWriter({
      readFile: async () => {
        readStarted.resolve();
        return await releaseRead.promise;
      },
      writeFile: async (_path, content) => {
        writes.push(content);
      },
      environment: { ANDROID_AVD_HOME: "/avds" },
      homeDirectory: () => "/home/test",
    });
    const controller = new AbortController();

    const update = writer.setConfiguration(
      "phone-api-36-a",
      { memoryMb: 4096 },
      { signal: controller.signal },
    );
    await readStarted.promise;
    controller.abort();
    await expect(update).rejects.toThrow("Operation cancelled");

    releaseRead.resolve("hw.ramSize=2048\n");
    await Promise.resolve();
    expect(writes).toEqual([]);
  });

  test("uses the same non-empty Android AVD home fallback as the config reader", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const writer = new FileAndroidAvdConfigWriter({
      readFile: async () => "hw.ramSize=2048\n",
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      environment: {
        ANDROID_AVD_HOME: "",
        ANDROID_EMULATOR_HOME: "",
        ANDROID_USER_HOME: "",
        ANDROID_SDK_HOME: "/sdk-home",
      },
      homeDirectory: () => "/home/test",
    });

    await writer.setMemoryMb("phone-api-36-a", 4096);

    expect(writes).toEqual([
      {
        path: join("/sdk-home", ".android", "avd", "phone-api-36-a.avd", "config.ini"),
        content: "hw.ramSize=4096\n",
      },
    ]);
  });

  test("creates an uninstalled non-TV Android runtime without checking installed images", async () => {
    const calls: unknown[] = [];
    const avdManager: ExactAndroidAvdClient = {
      listInstalledSystemImages: async () => {
        throw new Error("Non-TV creation must not list installed images");
      },
      createAvd: async (params) => {
        calls.push(params);
        return { success: true, message: "created", avdName: params.name };
      },
    };
    const configWriter: AndroidAvdConfigWriter = {
      setMemoryMb: async (name, memoryMb) => {
        calls.push({ name, memoryMb });
      },
    };
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [],
      isCreationAllowed: () => true,
      avdManager,
      androidConfigReader: { readConfig: async () => null },
      androidConfigWriter: configWriter,
      iosSimulator: {} as ExactIosSimulatorClient,
    });

    let creationStarted = false;
    const result = await provisioner.provision({
      platform: "android",
      name: "phone-api-36-a",
      spec: ANDROID_SPEC,
      onBeforeCreate: () => {
        creationStarted = true;
      },
    });

    expect(creationStarted).toBe(true);
    expect(result).toEqual({
      created: true,
      device: {
        ...androidImage("phone-api-36-a"),
        deviceType: ANDROID_SPEC.deviceType,
        runtimeId: ANDROID_SPEC.runtime,
      },
      resolvedSpec: { ...ANDROID_SPEC, displayCutout: "hole_punch" },
    });
    expect(calls).toEqual([
      {
        name: "phone-api-36-a",
        package: "system-images;android-36;google_apis;x86_64",
        device: "pixel_9",
      },
      { name: "phone-api-36-a", memoryMb: 4096 },
    ]);
  });

  test.each(["android-tv", "google-tv", "google-tv-ps16k"])(
    "rejects an uninstalled exact %s image with installation guidance",
    async (tag) => {
      const runtime = `system-images;android-37;${tag};arm64-v8a`;
      const calls: unknown[] = [];
      const signal = new AbortController().signal;
      const provisioner = new DefaultExactDeviceProvisioner({
        listDeviceImages: async () => [],
        isCreationAllowed: () => true,
        avdManager: {
          listInstalledSystemImages: async (receivedSignal) => {
            expect(receivedSignal).toBeInstanceOf(AbortSignal);
            return [
              {
                packageName: `system-images;android-36;${tag};arm64-v8a`,
                apiIdentifier: "36",
                apiLevel: 36,
                tag,
                abi: "arm64-v8a",
                versionInfo: "",
              },
            ];
          },
          createAvd: async (params) => {
            calls.push(params);
            return { success: true, message: "created" };
          },
        },
        androidConfigReader: { readConfig: async () => null },
        androidConfigWriter: { setMemoryMb: async () => {} },
        iosSimulator: {} as ExactIosSimulatorClient,
      });
      const result = provisioner.provision({
        platform: "android",
        name: "tv-37",
        signal,
        spec: { runtime, deviceType: "tv_1080p" },
      });
      await expect(result).rejects.toBeInstanceOf(ActionableError);
      await expect(result).rejects.toThrow(`sdkmanager "${runtime}"`);
      expect(calls).toEqual([]);
    },
  );

  test.each([
    { deviceType: "tv_1080p", tag: "android-tv" },
    { deviceType: "tv_4k", tag: "google-tv" },
    { deviceType: "tv_720p", tag: "google-tv-ps16k" },
  ])(
    "creates an installed explicit $tag spec with the requested $deviceType profile (#15881)",
    async ({ deviceType, tag }) => {
      const runtime = `system-images;android-34;${tag};x86_64`;
      const calls: unknown[] = [];
      const provisioner = new DefaultExactDeviceProvisioner({
        listDeviceImages: async () => [],
        isCreationAllowed: () => true,
        avdManager: {
          listInstalledSystemImages: async () => [
            {
              packageName: runtime,
              apiIdentifier: "34",
              apiLevel: 34,
              tag,
              abi: "x86_64",
              versionInfo: "",
            },
          ],
          createAvd: async (params) => {
            calls.push(params);
            return { success: true, message: "created", avdName: params.name };
          },
        },
        androidConfigReader: { readConfig: async () => null },
        androidConfigWriter: { setMemoryMb: async () => {} },
        iosSimulator: {} as ExactIosSimulatorClient,
      });

      const result = await provisioner.provision({
        platform: "android",
        name: "tv-34",
        spec: { runtime: runtime, deviceType },
      });

      expect(result.created).toBe(true);
      expect(calls).toEqual([
        {
          name: "tv-34",
          package: runtime,
          device: deviceType,
        },
      ]);
    },
  );

  test("creates an automotive AVD from an explicit car image and car profile (#15879)", async () => {
    const calls: unknown[] = [];
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async (params) => {
          calls.push(params);
          return { success: true, message: "created", avdName: params.name };
        },
      },
      androidConfigReader: { readConfig: async () => null },
      androidConfigWriter: { setMemoryMb: async () => undefined },
      iosSimulator: {} as ExactIosSimulatorClient,
    });
    const spec = {
      runtime: "system-images;android-34;android-automotive;x86_64",
      deviceType: "automotive_1024p_landscape",
    };

    const result = await provisioner.provision({ platform: "android", name: "car-34", spec });

    expect(result).toMatchObject({ created: true, device: androidImage("car-34") });
    expect(calls).toEqual([
      { name: "car-34", package: spec.runtime, device: "automotive_1024p_landscape" },
    ]);
  });

  test("adopts an existing iOS simulator only when its exact runtime and device type match", async () => {
    let created = false;
    const iosSimulator: ExactIosSimulatorClient = {
      createSimulator: async () => {
        created = true;
        return "new-udid";
      },
    };
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [
        {
          name: "phone-api-36-a",
          platform: "ios",
          deviceId: "existing-udid",
          isRunning: false,
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
      ],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: { readConfig: async () => null },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator,
    });

    const result = await provisioner.provision({
      platform: "ios",
      name: "phone-api-36-a",
      spec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        displayCutout: "dynamic_island",
      },
    });

    expect(created).toBe(false);
    expect(result).toEqual({
      created: false,
      device: {
        name: "phone-api-36-a",
        platform: "ios",
        deviceId: "existing-udid",
        isRunning: false,
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
      resolvedSpec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        displayCutout: "dynamic_island",
      },
    });
  });

  test("selects a later same-name iOS simulator when it is the exact available match", async () => {
    let created = false;
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [
        {
          name: "phone-api-36-a",
          platform: "ios",
          deviceId: "wrong-udid",
          isRunning: false,
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-25-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
        {
          name: "phone-api-36-a",
          platform: "ios",
          deviceId: "exact-udid",
          isRunning: false,
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
      ],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: { readConfig: async () => null },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {
        createSimulator: async () => {
          created = true;
          return "new-udid";
        },
      },
    });

    const result = await provisioner.provision({
      platform: "ios",
      name: "phone-api-36-a",
      spec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
    });

    expect(created).toBe(false);
    expect(result.device.deviceId).toBe("exact-udid");
  });

  test("uses the requested iOS UDID instead of a same-named sibling", async () => {
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [
        {
          name: "phone-api-36-a",
          platform: "ios",
          deviceId: "non-owned-udid",
          isRunning: false,
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
        {
          name: "phone-api-36-a",
          platform: "ios",
          deviceId: "owned-udid",
          isRunning: false,
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
      ],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: { readConfig: async () => null },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {
        createSimulator: async () => {
          throw new Error("must not create a same-named simulator");
        },
      },
    });

    const result = await provisioner.provision({
      platform: "ios",
      name: "phone-api-36-a",
      deviceId: "owned-udid",
      spec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
    });

    expect(result.device.deviceId).toBe("owned-udid");
  });

  test("rejects an unavailable exact iOS simulator instead of adopting it", async () => {
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [
        {
          name: "phone-api-36-a",
          platform: "ios",
          deviceId: "unavailable-udid",
          isRunning: false,
          isAvailable: false,
          availabilityError: "runtime is unavailable",
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
      ],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: { readConfig: async () => null },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {
        createSimulator: async () => {
          throw new Error("must not create a duplicate named simulator");
        },
      },
    });

    await expect(
      provisioner.provision({
        platform: "ios",
        name: "phone-api-36-a",
        spec: {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
      }),
    ).rejects.toMatchObject({
      code: "identity_conflict",
      message: expect.stringContaining("unavailable"),
    });
  });

  test("serializes same-name creation before recording retry provenance", async () => {
    let images: DeviceInfo[] = [];
    let createCalls = 0;
    let allowCreate!: () => void;
    const creationStarted = new Promise<void>((resolve) => {
      allowCreate = resolve;
    });
    let signalCreateStarted!: () => void;
    const createHasStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => images,
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async (params) => {
          createCalls++;
          signalCreateStarted();
          await creationStarted;
          images = [androidImage(params.name)];
          return { success: true, message: "created", avdName: params.name };
        },
      },
      androidConfigReader: {
        readConfig: async () => ({
          apiLevel: 36,
          systemImagePackage: ANDROID_SPEC.runtime,
          tag: "google_apis",
          architecture: "x86_64",
          deviceName: "pixel_9",
          ramSizeMb: 4096,
        }),
      },
      androidConfigWriter: {
        setMemoryMb: async () => {},
      },
      iosSimulator: {} as ExactIosSimulatorClient,
    });
    const request = {
      platform: "android" as const,
      name: "phone-api-36-a",
      spec: ANDROID_SPEC,
      onBeforeCreate: () => {},
    };

    const first = provisioner.provision(request);
    await createHasStarted;
    const second = provisioner.provision(request);
    allowCreate();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(createCalls).toBe(1);
    expect(firstResult.created).toBe(true);
    expect(secondResult).toMatchObject({
      created: false,
      device: androidImage("phone-api-36-a"),
    });
  });

  test("cancels a waiting same-name request before it enters the provisioning lock", async () => {
    let images: DeviceInfo[] = [];
    let createCalls = 0;
    let allowCreate!: () => void;
    const creationStarted = new Promise<void>((resolve) => {
      allowCreate = resolve;
    });
    let signalCreateStarted!: () => void;
    const createHasStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => images,
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async (params) => {
          createCalls++;
          signalCreateStarted();
          await creationStarted;
          images = [androidImage(params.name)];
          return { success: true, message: "created", avdName: params.name };
        },
      },
      androidConfigReader: {
        readConfig: async () => ({
          apiLevel: 36,
          tag: "google_apis",
          architecture: "x86_64",
          deviceName: "pixel_9",
          ramSizeMb: 4096,
        }),
      },
      androidConfigWriter: { setMemoryMb: async () => {} },
      iosSimulator: {} as ExactIosSimulatorClient,
    });
    const request = {
      platform: "android" as const,
      name: "phone-api-36-a",
      spec: ANDROID_SPEC,
    };

    const first = provisioner.provision(request);
    await createHasStarted;
    const controller = new AbortController();
    const second = provisioner.provision({ ...request, signal: controller.signal });
    controller.abort();

    await expect(second).rejects.toThrow(/cancelled/i);
    allowCreate();
    await first;
    expect(createCalls).toBe(1);
  });

  test("normalizes supported Android ABI aliases before matching an existing AVD", async () => {
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("phone-api-36-a")],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => {
          throw new Error("must not create a replacement");
        },
      },
      androidConfigReader: {
        readConfig: async () => ({
          apiLevel: 36,
          systemImagePackage: "system-images;android-36;google_apis;armeabi-v7a",
          tag: "google_apis",
          architecture: "arm",
          deviceName: "pixel_9",
          ramSizeMb: 4096,
        }),
      },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {} as ExactIosSimulatorClient,
    });

    const result = await provisioner.provision({
      platform: "android",
      name: "phone-api-36-a",
      spec: {
        ...ANDROID_SPEC,
        runtime: "system-images;android-36;google_apis;armeabi-v7a",
      },
    });

    expect(result).toMatchObject({ created: false, device: androidImage("phone-api-36-a") });
  });

  test("adopts an existing Android AVD with a matching minor runtime", async () => {
    const config = parseAvdConfig(
      [
        "image.sysdir.1=system-images/android-36.1/google_apis/arm64-v8a/",
        "hw.device.name=pixel_9",
        "tag.id=google_apis",
        "abi.type=arm64-v8a",
      ].join("\n"),
    );
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("minor-runtime")],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: { readConfig: async () => config },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {} as ExactIosSimulatorClient,
    });

    const result = await provisioner.provision({
      platform: "android",
      name: "minor-runtime",
      spec: {
        runtime: "system-images;android-36.1;google_apis;arm64-v8a",
        deviceType: "pixel_9",
      },
    });

    expect(result).toMatchObject({ created: false, device: androidImage("minor-runtime") });
  });

  test("rejects an existing Android AVD with a different minor runtime", async () => {
    const config = parseAvdConfig(
      [
        "image.sysdir.1=system-images/android-36.1/google_apis/arm64-v8a/",
        "hw.device.name=pixel_9",
        "tag.id=google_apis",
        "abi.type=arm64-v8a",
      ].join("\n"),
    );
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("minor-runtime")],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: { readConfig: async () => config },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {} as ExactIosSimulatorClient,
    });

    await expect(
      provisioner.provision({
        platform: "android",
        name: "minor-runtime",
        spec: {
          runtime: "system-images;android-36;google_apis;arm64-v8a",
          deviceType: "pixel_9",
        },
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
  });

  test("does not adopt an existing Android AVD when its resolved specification conflicts", async () => {
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("phone-api-36-a")],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => {
          throw new Error("must not create a replacement");
        },
      },
      androidConfigReader: {
        readConfig: async () => ({
          apiLevel: 35,
          systemImagePackage: ANDROID_SPEC.runtime,
          tag: "google_apis",
          architecture: "x86_64",
          deviceName: "pixel_9",
          ramSizeMb: 4096,
        }),
      },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {} as ExactIosSimulatorClient,
    });

    try {
      await provisioner.provision({
        platform: "android",
        name: "phone-api-36-a",
        spec: ANDROID_SPEC,
      });
      throw new Error("expected provision to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisionDeviceError);
      expect((error as ProvisionDeviceError).code).toBe("identity_conflict");
    }
  });

  test("adopts an existing Android AVD when matching GPU mode is enabled", async () => {
    let writes = 0;
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("phone-api-36-a")],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: {
        readConfig: async () => ({
          apiLevel: 36,
          systemImagePackage: ANDROID_SPEC.runtime,
          tag: "google_apis",
          architecture: "x86_64",
          deviceName: "pixel_9",
          hardware: { gpuMode: "host" },
          gpuEnabled: true,
        }),
      },
      androidConfigWriter: {
        setMemoryMb: async () => {},
        setConfiguration: async () => {
          writes++;
        },
      },
      iosSimulator: {} as ExactIosSimulatorClient,
    });

    const result = await provisioner.provision({
      platform: "android",
      name: "phone-api-36-a",
      spec: {
        ...ANDROID_SPEC,
        configuration: { gpuMode: "host" },
      },
    });

    expect(writes).toBe(0);
    expect(result.created).toBe(false);
  });

  // #11065: an existing AVD whose configuration differs is never rewritten; a
  // mismatch is an identity conflict.
  test("rejects an existing Android AVD whose configuration differs without rewriting it", async () => {
    const writes: number[] = [];
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("phone-api-36-a")],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: {
        readConfig: async () => ({
          apiLevel: 36,
          systemImagePackage: ANDROID_SPEC.runtime,
          tag: "google_apis",
          architecture: "x86_64",
          deviceName: "pixel_9",
          ramSizeMb: 2048,
        }),
      },
      androidConfigWriter: {
        setMemoryMb: async (_name, memoryMb) => {
          writes.push(memoryMb);
        },
      },
      iosSimulator: {} as ExactIosSimulatorClient,
    });

    await expect(
      provisioner.provision({
        platform: "android",
        name: "phone-api-36-a",
        spec: ANDROID_SPEC,
      }),
    ).rejects.toMatchObject({
      code: "identity_conflict",
    });

    expect(writes).toEqual([]);
  });

  test("rejects an existing Android AVD whose exact type conflicts with the requested cutout", async () => {
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("phone-api-36-a")],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: {
        readConfig: async () => ({
          apiLevel: 36,
          tag: "google_apis",
          architecture: "x86_64",
          deviceName: "pixel_9",
          ramSizeMb: 4096,
        }),
      },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {} as ExactIosSimulatorClient,
    });

    await expect(
      provisioner.provision({
        platform: "android",
        name: "phone-api-36-a",
        spec: { ...ANDROID_SPEC, displayCutout: "none" },
      }),
    ).rejects.toMatchObject({
      code: "identity_conflict",
      message: expect.stringContaining("hole_punch"),
    });
  });

  test("rejects a cutout preference when the exact device type cannot be classified", async () => {
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: { readConfig: async () => null },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {} as ExactIosSimulatorClient,
    });

    await expect(
      provisioner.provision({
        platform: "android",
        name: "phone-api-36-a",
        spec: {
          runtime: ANDROID_SPEC.runtime,
          deviceType: "unclassified_profile",
          displayCutout: "notch",
        },
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("unknown"),
    });
  });
});

describe("exact iOS provisioning runtime compatibility", () => {
  const fixtures = join(import.meta.dir, "../fixtures/ios-simctl");
  const runtimes = (
    JSON.parse(readFileSync(join(fixtures, "list-runtimes.json"), "utf8")) as {
      runtimes: AppleDeviceRuntime[];
    }
  ).runtimes;
  const deviceTypes = (
    JSON.parse(readFileSync(join(fixtures, "list-devicetypes.json"), "utf8")) as {
      devicetypes: AppleDeviceType[];
    }
  ).devicetypes;
  const RUNTIME = (version: string) =>
    `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(".", "-")}`;
  const IPHONE_17_PRO = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
  const IPHONE_8 = "com.apple.CoreSimulator.SimDeviceType.iPhone-8";

  function harness(catalog?: Partial<ExactIosRuntimeCatalog>) {
    const events: string[] = [];
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: { readConfig: async () => null },
      androidConfigWriter: {} as AndroidAvdConfigWriter,
      iosSimulator: {
        createSimulator: async () => {
          events.push("create");
          return "new-udid";
        },
      },
      iosRuntimeCatalog: {
        getRuntimesChecked: async () => runtimes,
        getDeviceTypesChecked: async () => deviceTypes,
        ...catalog,
      },
    });
    const provision = (deviceType: string, runtime: string, signal?: AbortSignal) =>
      provisioner.provision({
        platform: "ios",
        name: "phone-a",
        signal,
        spec: { runtime, deviceType },
        onBeforeCreate: () => {
          events.push("before-create");
        },
      });
    return { events, provision };
  }

  test("rejects a proven-incompatible pair before the hook or creator run", async () => {
    const { events, provision } = harness();
    const error = await provision(IPHONE_17_PRO, RUNTIME("18.6")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisionDeviceError);
    const failure = error as ProvisionDeviceError;
    expect(failure.code).toBe("runtime_incompatible");
    expect(failure.retryable).toBe(false);
    expect(failure.diagnostics.runtimeCompatibility).toEqual({
      requestedRuntime: RUNTIME("18.6"),
      requestedDeviceType: IPHONE_17_PRO,
      bounds: { minVersion: "26.0.0", maxVersion: null },
      compatibleRuntimes: [
        { id: RUNTIME("26.2"), version: "26.2" },
        { id: RUNTIME("26.5"), version: "26.5" },
        { id: RUNTIME("27.0"), version: "27.0" },
        { id: RUNTIME("27.1"), version: "27.1" },
      ],
    });
    expect(failure.message).toContain(RUNTIME("26.5"));
    expect(events).toEqual([]);
  });

  test("rejects a model whose maximum is below the runtime", async () => {
    const { events, provision } = harness();
    const error = (await provision(IPHONE_8, RUNTIME("17.5")).catch(
      (e: unknown) => e,
    )) as ProvisionDeviceError;
    expect(error.code).toBe("runtime_incompatible");
    expect(error.diagnostics.runtimeCompatibility?.bounds).toEqual({
      minVersion: "11.0.0",
      maxVersion: "16.9.0",
    });
    expect(error.diagnostics.runtimeCompatibility?.compatibleRuntimes).toEqual([
      { id: RUNTIME("16.4"), version: "16.4" },
    ]);
    expect(events).toEqual([]);
  });

  test("creates the exact requested pair when it is supported, including an endpoint", async () => {
    const { events, provision } = harness();
    const result = await provision(IPHONE_17_PRO, RUNTIME("26.2"));
    expect(result.created).toBe(true);
    expect(result.device.runtime).toBe(RUNTIME("26.2"));
    expect(events).toEqual(["before-create", "create"]);
  });

  test("rejects an unavailable runtime without creating", async () => {
    const unavailable = runtimes.map((runtime) =>
      runtime.version === "26.5"
        ? { ...runtime, isAvailable: false, availabilityError: "runtime image missing" }
        : runtime,
    );
    const { events, provision } = harness({ getRuntimesChecked: async () => unavailable });
    const error = (await provision(IPHONE_17_PRO, RUNTIME("26.5")).catch(
      (e: unknown) => e,
    )) as ProvisionDeviceError;
    expect(error.code).toBe("runtime_incompatible");
    expect(error.message).toContain("runtime image missing");
    expect(
      error.diagnostics.runtimeCompatibility?.compatibleRuntimes.map((r) => r.id),
    ).not.toContain(RUNTIME("26.5"));
    expect(events).toEqual([]);
  });

  test("unknown evidence does not block creation: malformed bounds, unlisted pair, failed discovery", async () => {
    const malformed = deviceTypes.map((deviceType) =>
      deviceType.identifier === IPHONE_17_PRO
        ? { ...deviceType, minRuntimeVersionString: "garbage" }
        : deviceType,
    );
    for (const catalog of [
      { getDeviceTypesChecked: async () => malformed },
      { getDeviceTypesChecked: async () => [] },
      {
        getRuntimesChecked: async (): Promise<AppleDeviceRuntime[]> => {
          throw new Error("simctl timed out");
        },
      },
    ]) {
      const { events, provision } = harness(catalog);
      await provision(IPHONE_17_PRO, RUNTIME("18.6"));
      expect(events).toEqual(["before-create", "create"]);
    }
  });

  test("an aborted discovery propagates cancellation instead of being treated as unknown", async () => {
    const controller = new AbortController();
    const { events, provision } = harness({
      getRuntimesChecked: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    });
    await expect(provision(IPHONE_17_PRO, RUNTIME("18.6"), controller.signal)).rejects.toThrow();
    expect(events).toEqual([]);
  });
});

test.each([false, true])(
  "preboot resources run after exact iOS creation; failure=%s is best effort",
  async (failure) => {
    const calls: string[] = [];
    const provisioner = new DefaultExactDeviceProvisioner({
      timer: new FakeTimer(),
      lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
      listDeviceImages: async () => [],
      isCreationAllowed: () => true,
      avdManager: {
        listInstalledSystemImages: async () => [],
        createAvd: async () => ({ success: true, message: "" }),
      },
      androidConfigReader: { readConfig: async () => null },
      androidConfigWriter: { setMemoryMb: async () => {} },
      iosSimulator: {
        createSimulator: async () => {
          calls.push("create");
          return "NEW-UDID";
        },
      },
      prebootProfile: {
        apply: async (udid, options) => {
          expect(udid).toBe("NEW-UDID");
          expect(options.resources).toEqual({ widgets: "disabled" });
          expect(calls).toEqual(["create"]);
          calls.push("apply");
          return {
            applied: !failure,
            resources: failure ? [] : ["widgets" as const],
            labels: [],
            ...(failure ? { reason: "denied" } : {}),
          };
        },
      },
    });
    const result = await provisioner.provision({
      platform: "ios",
      name: "new",
      spec: { runtime: "iOS-26", deviceType: "iPhone-17" },
      resources: { widgets: "disabled" },
    });
    expect(result.created).toBe(true);
    expect(result.prebootDisabledResources).toEqual(failure ? undefined : ["widgets"]);
    expect(calls).toEqual(["create", "apply"]);
  },
);

test("exact creation with default none and no resources has no host effects", async () => {
  const { SimulatorPrebootProfile } =
    await import("../../src/utils/ios-cmdline-tools/SimulatorPrebootProfile");
  const { FakeSimulatorHostState } = await import("../fakes/FakeSimulatorHostState");
  const host = new FakeSimulatorHostState();
  const provisioner = new DefaultExactDeviceProvisioner({
    timer: new FakeTimer(),
    lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
    listDeviceImages: async () => [],
    isCreationAllowed: () => true,
    avdManager: {
      listInstalledSystemImages: async () => [],
      createAvd: async () => ({ success: true, message: "" }),
    },
    androidConfigReader: { readConfig: async () => null },
    androidConfigWriter: { setMemoryMb: async () => {} },
    iosSimulator: { createSimulator: async () => "12345678-1234-ABCD-9876-123456789ABC" },
    prebootProfile: new SimulatorPrebootProfile(host, () => "none"),
  });
  expect(
    (
      await provisioner.provision({
        platform: "ios",
        name: "new",
        spec: { runtime: "iOS-26", deviceType: "iPhone-17" },
      })
    ).created,
  ).toBe(true);
  expect(host.calls).toEqual([]);
});

test("exact Android creation returns configured metadata without booting", async () => {
  const { reader, reads } = tvConfigReader();
  const provisioner = new DefaultExactDeviceProvisioner({
    listDeviceImages: async () => [],
    isCreationAllowed: () => true,
    avdManager: {
      listInstalledSystemImages: async () => [
        {
          packageName: "system-images;android-36;android-tv;arm64-v8a",
          apiIdentifier: "36",
          apiLevel: 36,
          tag: "android-tv",
          abi: "arm64-v8a",
          versionInfo: "",
        },
      ],
      createAvd: async () => ({ success: true, message: "created" }),
    },
    androidConfigReader: reader,
    androidConfigWriter: { setMemoryMb: async () => {} },
    iosSimulator: {} as ExactIosSimulatorClient,
  });
  const result = await provisioner.provision({
    platform: "android",
    name: "tv",
    spec: { runtime: "system-images;android-36;android-tv;arm64-v8a", deviceType: "tv_1080p" },
  });
  expect(result.device).toMatchObject({
    deviceType: "tv_1080p",
    apiLevel: 36,
    osVersion: "16",
    screenWidth: 1920,
    screenHeight: 1080,
    screenDensity: 320,
    isRunning: false,
  });
  expect(reads).toContain(
    join(
      "/fixture/sdk",
      "system-images",
      "android-36",
      "android-tv",
      "arm64-v8a",
      "source.properties",
    ),
  );
});
