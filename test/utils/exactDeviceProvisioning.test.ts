import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { parseAvdConfig } from "../../src/utils/android-cmdline-tools/AvdConfigReader";
import type { DeviceInfo } from "../../src/models";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { FakeTimer } from "../fakes/FakeTimer";
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
      device_offline: true,
      discovery_incomplete: true,
      identity_conflict: false,
      timeout: true,
      unsupported: false,
      platform_command_failed: false,
      resource_profile_unproven: false,
      runtime_incompatible: false,
      result_persistence_failed: true,
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
        onBeforeCreate: async () => {},
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

  test("creates the requested Android AVD without selecting a substitute", async () => {
    const calls: unknown[] = [];
    const avdManager: ExactAndroidAvdClient = {
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
      onBeforeCreate: async () => {
        creationStarted = true;
      },
    });

    expect(creationStarted).toBe(true);
    expect(result).toEqual({
      created: true,
      device: androidImage("phone-api-36-a"),
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
      avdManager: {} as ExactAndroidAvdClient,
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
      avdManager: {} as ExactAndroidAvdClient,
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
      avdManager: {} as ExactAndroidAvdClient,
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
      avdManager: {} as ExactAndroidAvdClient,
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
      onBeforeCreate: async () => {},
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
      avdManager: {} as ExactAndroidAvdClient,
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
      avdManager: {} as ExactAndroidAvdClient,
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

  test("reconciles a matching GPU mode when the existing AVD has GPU disabled", async () => {
    let gpuEnabled = false;
    let writes = 0;
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("phone-api-36-a")],
      isCreationAllowed: () => true,
      avdManager: {} as ExactAndroidAvdClient,
      androidConfigReader: {
        readConfig: async () => ({
          apiLevel: 36,
          systemImagePackage: ANDROID_SPEC.runtime,
          tag: "google_apis",
          architecture: "x86_64",
          deviceName: "pixel_9",
          hardware: { gpuMode: "host" },
          gpuEnabled,
        }),
      },
      androidConfigWriter: {
        setMemoryMb: async () => {},
        setConfiguration: async (_name, configuration) => {
          writes++;
          gpuEnabled = configuration.gpuMode !== undefined;
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
      reconcileExistingConfiguration: true,
    });

    expect(writes).toBe(1);
    expect(result.created).toBe(false);
  });

  test("adopts an existing Android AVD when matching GPU mode is enabled", async () => {
    let writes = 0;
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("phone-api-36-a")],
      isCreationAllowed: () => true,
      avdManager: {} as ExactAndroidAvdClient,
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
      reconcileExistingConfiguration: true,
    });

    expect(writes).toBe(0);
    expect(result.created).toBe(false);
  });

  test.each([false, true])(
    "reconciles memory only on a stopped AVD (running=%s)",
    async (isRunning) => {
      let ramSizeMb = 2048;
      const writes: number[] = [];
      const provisioner = new DefaultExactDeviceProvisioner({
        listDeviceImages: async () => [{ ...androidImage("phone-api-36-a"), isRunning }],
        isCreationAllowed: () => true,
        avdManager: {} as ExactAndroidAvdClient,
        androidConfigReader: {
          readConfig: async () => ({
            apiLevel: 36,
            systemImagePackage: ANDROID_SPEC.runtime,
            tag: "google_apis",
            architecture: "x86_64",
            deviceName: "pixel_9",
            ramSizeMb,
          }),
        },
        androidConfigWriter: {
          setMemoryMb: async (_name, memoryMb) => {
            writes.push(memoryMb);
            ramSizeMb = memoryMb;
          },
        },
        iosSimulator: {} as ExactIosSimulatorClient,
      });

      const operation = provisioner.provision({
        platform: "android",
        name: "phone-api-36-a",
        spec: ANDROID_SPEC,
        reconcileExistingConfiguration: true,
      });

      if (isRunning) {
        await expect(operation).rejects.toMatchObject({ code: "identity_conflict" });
        expect(writes).toEqual([]);
        return;
      }
      const result = await operation;

      expect(writes).toEqual([4096]);
      expect(result).toEqual({
        created: false,
        device: androidImage("phone-api-36-a"),
        resolvedSpec: { ...ANDROID_SPEC, displayCutout: "hole_punch" },
      });
    },
  );

  test("does not reconcile an AVD whose stopped state is unknown after an ADB overlay failure", async () => {
    const writes: number[] = [];
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [
        {
          ...androidImage("phone-api-36-a"),
          // `listDeviceImages` preserves configured AVDs when its ADB overlay
          // fails, but must not let that inventory result authorize a config write.
          isRunningStateKnown: false,
        },
      ],
      isCreationAllowed: () => true,
      avdManager: {} as ExactAndroidAvdClient,
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
        reconcileExistingConfiguration: true,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });

    expect(writes).toEqual([]);
  });

  test("does not reconcile a pre-existing Android AVD without creation provenance", async () => {
    const writes: number[] = [];
    const provisioner = new DefaultExactDeviceProvisioner({
      listDeviceImages: async () => [androidImage("phone-api-36-a")],
      isCreationAllowed: () => true,
      avdManager: {} as ExactAndroidAvdClient,
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
        reconcileExistingConfiguration: false,
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
      avdManager: {} as ExactAndroidAvdClient,
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
      avdManager: {} as ExactAndroidAvdClient,
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
      avdManager: {} as ExactAndroidAvdClient,
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
        onBeforeCreate: async () => {
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
