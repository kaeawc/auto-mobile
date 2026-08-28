import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DeviceInfo } from "../../src/models";
import {
  DefaultExactDeviceProvisioner,
  FileAndroidAvdConfigWriter,
  ProvisionDeviceError,
  type AndroidAvdConfigWriter,
  type ExactAndroidAvdClient,
  type ExactIosSimulatorClient,
} from "../../src/utils/exactDeviceProvisioning";

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

describe("DefaultExactDeviceProvisioner", () => {
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

  test("reconciles requested Android memory on a retry after partial provisioning", async () => {
    let ramSizeMb = 2048;
    const writes: number[] = [];
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

    const result = await provisioner.provision({
      platform: "android",
      name: "phone-api-36-a",
      spec: ANDROID_SPEC,
      reconcileExistingConfiguration: true,
    });

    expect(writes).toEqual([4096]);
    expect(result).toEqual({
      created: false,
      device: androidImage("phone-api-36-a"),
      resolvedSpec: { ...ANDROID_SPEC, displayCutout: "hole_punch" },
    });
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
