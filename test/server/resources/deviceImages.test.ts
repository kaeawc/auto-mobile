import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  createDeviceImageResourcesHandler,
  DeviceImagesResourceContent,
  resetAndroidDeviceImageResourceCache,
} from "../../../src/server/deviceImageResources";
import { DeviceInfo } from "../../../src/models";
import { AvdInfo } from "../../../src/utils/android-cmdline-tools/avdmanager";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { AvdManager } from "../../../src/utils/android-cmdline-tools/interfaces/AvdManager";
import type { DeviceImageDiscovery, PlatformDeviceManager } from "../../../src/utils/deviceUtils";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";

describe("Device Image Resources with Fakes", () => {
  let fakeDeviceUtils: FakeDeviceUtils;
  let fakeAvdManager: FakeAvdManager;
  let fakeSimCtl: FakeSimCtlClient;

  beforeEach(() => {
    AndroidAvdProvenanceCache.resetForTests();
    resetAndroidDeviceImageResourceCache();
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeAvdManager = new FakeAvdManager();
    fakeSimCtl = new FakeSimCtlClient();
  });

  afterEach(() => {
    resetAndroidDeviceImageResourceCache();
  });

  test("coalesces and caches the full Android device-image resource snapshot", async () => {
    const timer = new FakeTimer();
    fakeDeviceUtils.setDeviceImages("android", []);
    const handler = createDeviceImageResourcesHandler({
      deviceManager: fakeDeviceUtils,
      avdManager: fakeAvdManager,
      timer,
    });

    const concurrentResults = await Promise.all(
      Array.from({ length: 4 }, () => handler.getDeviceImagesForPlatforms(["android"])),
    );

    expect(concurrentResults).toHaveLength(4);
    expect(fakeDeviceUtils.getGetDeviceImagesDetailedCalls()).toHaveLength(1);

    await handler.getDeviceImagesForPlatforms(["android"]);
    expect(fakeDeviceUtils.getGetDeviceImagesDetailedCalls()).toHaveLength(1);

    timer.advanceTime(2_501);
    await handler.getDeviceImagesForPlatforms(["android"]);
    expect(fakeDeviceUtils.getGetDeviceImagesDetailedCalls()).toHaveLength(2);

    resetAndroidDeviceImageResourceCache();
    await handler.getDeviceImagesForPlatforms(["android"]);
    expect(fakeDeviceUtils.getGetDeviceImagesDetailedCalls()).toHaveLength(3);
  });

  describe("createDeviceImageResourcesHandler", () => {
    test("returns a normalized provisioning catalog for Android and iOS", async () => {
      fakeDeviceUtils.setDeviceImages("android", []);
      fakeDeviceUtils.setDeviceImages("ios", []);
      fakeAvdManager.setListInstalledSystemImagesResponse([
        {
          packageName: "system-images;android-35.1;google_apis;x86_64",
          apiIdentifier: "35.1",
          apiLevel: 35,
          tag: "google_apis",
          abi: "x86_64",
          versionInfo: "Google APIs Intel x86_64 Atom System Image",
        },
      ]);
      fakeAvdManager.setListDevicesResponse([
        {
          id: "pixel_9",
          name: "Pixel 9",
          oem: "Google",
        },
      ]);
      const runtimes: AppleDeviceRuntime[] = [
        {
          bundlePath: "/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.0.simruntime",
          buildversion: "22A3354",
          runtimeRoot:
            "/Library/Developer/CoreSimulator/Volumes/iOS_22A3354/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.0.simruntime/Contents/Resources/RuntimeRoot",
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
          version: "18.0",
          isAvailable: true,
          name: "iOS 18.0",
        },
        {
          bundlePath: "/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 16.0.simruntime",
          buildversion: "20A362",
          runtimeRoot:
            "/Library/Developer/CoreSimulator/Volumes/iOS_20A362/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 16.0.simruntime/Contents/Resources/RuntimeRoot",
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-16-0",
          version: "16.0",
          isAvailable: false,
          availabilityError: "The runtime bundle was not found.",
          name: "iOS 16.0",
        },
      ];
      const deviceTypes: AppleDeviceType[] = [
        {
          minRuntimeVersion: 1114112,
          minRuntimeVersionString: "17.0",
          bundlePath:
            "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 16.simdevicetype",
          // simctl uses 0xFFFFFFFF for an unbounded maximum.
          maxRuntimeVersion: 4294967295,
          name: "iPhone 16",
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          productFamily: "iPhone",
        },
        {
          minRuntimeVersion: 786432,
          minRuntimeVersionString: "12.0",
          bundlePath:
            "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 8.simdevicetype",
          maxRuntimeVersion: 1049600,
          maxRuntimeVersionString: "16.4",
          name: "iPhone 8",
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-8",
          productFamily: "iPhone",
        },
      ];
      fakeSimCtl.setRuntimes(runtimes);
      fakeSimCtl.setDeviceTypes(deviceTypes);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        simctl: fakeSimCtl,
      });

      const result = await handler.getDeviceImagesForPlatforms(["android", "ios"]);

      expect(result.catalogComplete).toBe(true);
      expect(result.provisioningCatalog).toEqual({
        runtimes: expect.arrayContaining([
          expect.objectContaining({
            platform: "android",
            id: "system-images;android-35.1;google_apis;x86_64",
            version: "35.1",
            availability: { available: true },
          }),
          expect.objectContaining({
            platform: "ios",
            id: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
            version: "18.0",
            availability: { available: true },
          }),
          expect.objectContaining({
            platform: "ios",
            id: "com.apple.CoreSimulator.SimRuntime.iOS-16-0",
            availability: {
              available: false,
              reason: "runtime-unavailable: The runtime bundle was not found.",
            },
          }),
        ]),
        deviceTypes: expect.arrayContaining([
          expect.objectContaining({
            platform: "android",
            id: "pixel_9",
            name: "Pixel 9",
            availability: { available: true },
          }),
          expect.objectContaining({
            platform: "ios",
            id: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
            name: "iPhone 16",
            availability: { available: true },
          }),
          expect.objectContaining({
            platform: "ios",
            id: "com.apple.CoreSimulator.SimDeviceType.iPhone-8",
            availability: {
              available: false,
              reason: "runtime-not-installed: iOS 16.0",
            },
          }),
        ]),
        systemImages: [
          {
            platform: "android",
            id: "system-images;android-35.1;google_apis;x86_64",
            name: "Google APIs Intel x86_64 Atom System Image",
            apiLevel: 35,
            tag: "google_apis",
            abi: "x86_64",
            version: "35.1",
          },
        ],
        profiles: [
          {
            platform: "android",
            id: "pixel_9",
            name: "Pixel 9",
            manufacturer: "Google",
          },
        ],
      });
    });

    test("returns a pre-session capability inventory for each virtual device", async () => {
      fakeDeviceUtils.setDeviceImages("android", [
        {
          name: "Pixel 9",
          platform: "android",
          isRunning: false,
          capabilityInventory: {
            schemaVersion: 1,
            capabilities: [
              { id: "android.hardware.nfc", state: "unavailable", source: "avd_config" },
            ],
          },
        },
      ]);
      fakeDeviceUtils.setDeviceImages("ios", [
        {
          name: "iPhone 16",
          platform: "ios",
          deviceId: "iphone-16-udid",
          isRunning: false,
        },
      ]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        simctl: fakeSimCtl,
      });

      const result = await handler.getDeviceImagesForPlatforms(["android", "ios"]);

      expect(
        result.images.find((image) => image.platform === "android")?.capabilityInventory,
      ).toEqual({
        schemaVersion: 1,
        capabilities: [
          {
            id: "android.hardware.nfc",
            state: "unsupported",
            source: "avd_config",
            reason: null,
          },
        ],
      });
      expect(result.images.find((image) => image.platform === "ios")?.capabilityInventory).toEqual({
        schemaVersion: 1,
        capabilities: expect.arrayContaining([
          {
            id: "ios.simulator.biometric",
            state: "supported",
            source: "platform",
            reason: null,
          },
          {
            id: "ios.simulator.nfc",
            state: "unsupported",
            source: "platform",
            reason: "iOS Simulator cannot emulate NFC hardware.",
          },
          {
            id: "ios.simulator.doNotDisturb",
            state: "unsupported",
            source: "platform",
            reason: "Do Not Disturb cannot be read or set on an iOS simulator.",
          },
          {
            id: "ios.simulator.networkCondition",
            state: "unsupported",
            source: "platform",
            reason: "Network-condition simulation is unavailable on iOS Simulator.",
          },
          {
            id: "ios.simulator.connectivity",
            state: "unsupported",
            source: "platform",
            reason:
              "iOS Simulator shares the host network stack and has no connectivity read verb.",
          },
        ]),
      });
    });

    test("marks iOS Simulator capabilities unavailable when its runtime is unavailable", async () => {
      fakeDeviceUtils.setDeviceImages("ios", [
        {
          name: "Unavailable iPhone",
          platform: "ios",
          deviceId: "unavailable-iphone-udid",
          isRunning: false,
          isAvailable: false,
          availabilityError: "iOS 18.0 runtime is not installed",
        },
      ]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        simctl: fakeSimCtl,
      });
      const result = await handler.getDeviceImagesForPlatforms(["ios"]);

      expect(result.images[0]?.capabilityInventory).toEqual({
        schemaVersion: 1,
        capabilities: [
          {
            id: "ios.simulator.biometric",
            state: "unsupported",
            source: "platform",
            reason: "iOS 18.0 runtime is not installed",
          },
          {
            id: "ios.simulator.nfc",
            state: "unsupported",
            source: "platform",
            reason: "iOS Simulator cannot emulate NFC hardware.",
          },
          {
            id: "ios.simulator.doNotDisturb",
            state: "unsupported",
            source: "platform",
            reason: "Do Not Disturb cannot be read or set on an iOS simulator.",
          },
          {
            id: "ios.simulator.networkCondition",
            state: "unsupported",
            source: "platform",
            reason: "Network-condition simulation is unavailable on iOS Simulator.",
          },
          {
            id: "ios.simulator.connectivity",
            state: "unsupported",
            source: "platform",
            reason:
              "iOS Simulator shares the host network stack and has no connectivity read verb.",
          },
        ],
      });
    });

    test("preserves Android AVD discovery errors in image resource descriptions", async () => {
      fakeDeviceUtils.setDeviceImages("android", [
        { name: "Pixel_9", platform: "android", isRunning: false },
      ]);
      fakeAvdManager.setListDeviceImagesResponse([
        { name: "Pixel_9", error: "AVD configuration is unreadable" },
      ]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        simctl: fakeSimCtl,
      });
      const result = await handler.getDeviceImagesForPlatforms(["android"]);

      expect(result.images[0]?.availabilityError).toBe("AVD configuration is unreadable");
    });

    test("merges installed-only Android system images into the complete catalog", async () => {
      fakeDeviceUtils.setDeviceImages("android", []);
      const availableImage = {
        packageName: "system-images;android-35;google_apis;x86_64",
        apiLevel: 35,
        tag: "google_apis",
        abi: "x86_64",
        versionInfo: "Google APIs Intel x86_64 Atom System Image",
      };
      const installedOnlyImage = {
        packageName: "system-images;android-34;google_apis;arm64-v8a",
        apiLevel: 34,
        tag: "google_apis",
        abi: "arm64-v8a",
        versionInfo: "Google APIs ARM 64 v8a System Image",
      };
      fakeAvdManager.setListSystemImagesResponse([availableImage]);
      fakeAvdManager.setListInstalledSystemImagesResponse([availableImage, installedOnlyImage]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });
      const result = await handler.getDeviceImagesForPlatforms(["android"]);

      expect(result.catalogComplete).toBe(true);
      expect(result.provisioningCatalog.systemImages.map((image) => image.id)).toEqual([
        availableImage.packageName,
        installedOnlyImage.packageName,
      ]);
      expect(fakeAvdManager.getListInstalledSystemImagesCalls()).toHaveLength(1);
    });

    test("excludes an available-but-not-installed system image from the catalog", async () => {
      fakeDeviceUtils.setDeviceImages("android", []);
      const installedImage = {
        packageName: "system-images;android-34;google_apis;arm64-v8a",
        apiLevel: 34,
        tag: "google_apis",
        abi: "arm64-v8a",
        versionInfo: "Google APIs ARM 64 v8a System Image",
      };
      const availableOnlyImage = {
        packageName: "system-images;android-35;google_apis_playstore;arm64-v8a",
        apiLevel: 35,
        tag: "google_apis_playstore",
        abi: "arm64-v8a",
        versionInfo: "Google Play ARM 64 v8a System Image",
      };
      // sdkmanager offers the playstore image to download, but only the api-34
      // image is installed and therefore accepted by AVD creation.
      fakeAvdManager.setListSystemImagesResponse([installedImage, availableOnlyImage]);
      fakeAvdManager.setListInstalledSystemImagesResponse([installedImage]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });
      const result = await handler.getDeviceImagesForPlatforms(["android"]);

      expect(result.catalogComplete).toBe(true);
      const ids = result.provisioningCatalog.systemImages.map((image) => image.id);
      expect(ids).toEqual([installedImage.packageName]);
      expect(ids).not.toContain(availableOnlyImage.packageName);
      // The catalog must never surface a runtime the available-only package minted.
      expect(result.provisioningCatalog.runtimes.map((runtime) => runtime.id)).not.toContain(
        availableOnlyImage.packageName,
      );
    });

    test("every catalog system image id is one the creation-accept source accepts", async () => {
      fakeDeviceUtils.setDeviceImages("android", []);
      const accepted = [
        {
          packageName: "system-images;android-34;google_apis;arm64-v8a",
          apiLevel: 34,
          tag: "google_apis",
          abi: "arm64-v8a",
          versionInfo: "Google APIs ARM 64 v8a System Image",
        },
        {
          packageName: "system-images;android-33;google_apis;x86_64",
          apiLevel: 33,
          tag: "google_apis",
          abi: "x86_64",
          versionInfo: "Google APIs Intel x86_64 Atom System Image",
        },
      ];
      // A wider available-to-download set that must not leak into the catalog.
      fakeAvdManager.setListSystemImagesResponse([
        ...accepted,
        {
          packageName: "system-images;android-35;android-tv;arm64-v8a",
          apiLevel: 35,
          tag: "android-tv",
          abi: "arm64-v8a",
          versionInfo: "Android TV ARM 64 v8a System Image",
        },
      ]);
      fakeAvdManager.setListInstalledSystemImagesResponse(accepted);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });
      const result = await handler.getDeviceImagesForPlatforms(["android"]);

      const acceptedIds = new Set(accepted.map((image) => image.packageName));
      for (const image of result.provisioningCatalog.systemImages) {
        expect(acceptedIds.has(image.id)).toBe(true);
      }
      expect(result.provisioningCatalog.systemImages).toHaveLength(acceptedIds.size);
    });

    test("preserves completed configured inventory when later catalog enumeration times out", async () => {
      const timer = new FakeTimer();
      fakeDeviceUtils.setDeviceImages("android", [
        {
          name: "Pixel_9_API_35",
          platform: "android",
          deviceId: "Pixel_9_API_35",
          isRunning: false,
        },
      ]);
      fakeAvdManager.setListInstalledSystemImagesHangs(true);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        timer,
        androidCatalogBudgetMs: 5_000,
      });

      const pending = handler.getDeviceImagesForPlatforms(["android"]);
      // Let appendAndroidImages settle and the bounded enumeration schedule its
      // deadline timer before we push time past the budget.
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      timer.advanceTime(5_001);
      const result = await pending;

      expect(result.catalogComplete).toBe(false);
      expect(result.catalogObservations.android).toMatchObject({
        catalogComplete: false,
        error: {
          code: "timeout",
          message: expect.stringContaining("5000"),
        },
      });
      expect(result.configuredInventory).toEqual({
        schemaVersion: 1,
        complete: true,
        observations: {
          android: {
            complete: true,
          },
        },
      });
      expect(result.androidCount).toBe(1);
      expect(result.images).toEqual([
        expect.objectContaining({
          identity: expect.objectContaining({ stableId: "Pixel_9_API_35" }),
          name: "Pixel_9_API_35",
          platform: "android",
        }),
      ]);
      expect(result.provisioningCatalog).toEqual({
        runtimes: [],
        deviceTypes: [],
        systemImages: [],
        profiles: [],
      });
      // The hung enumeration must have been cancelled, not left running.
      const calls = fakeAvdManager.getListInstalledSystemImagesCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].signal?.aborted).toBe(true);
    });

    test("bounds the preceding device-image listing under the same deadline", async () => {
      const timer = new FakeTimer();
      fakeDeviceUtils.setDeviceImages("android", []);
      // The device-image listing (appendAndroidImages -> readAvdInfo) hangs,
      // BEFORE the provisioning-catalog enumeration is ever reached. The whole
      // Android path must still be bounded by the single deadline.
      fakeAvdManager.setListDeviceImagesHangs(true);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        timer,
        androidCatalogBudgetMs: 5_000,
      });

      const pending = handler.getDeviceImagesForPlatforms(["android"]);
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      timer.advanceTime(5_001);
      const result = await pending;

      expect(result.catalogComplete).toBe(false);
      expect(result.catalogObservations.android).toMatchObject({
        catalogComplete: false,
        error: {
          code: "timeout",
          message: expect.stringContaining("5000"),
        },
      });
      // The hung listing child must have been aborted, not left running to its
      // own independent 60s avdmanager timeout.
      const calls = fakeAvdManager.getListDeviceImagesCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].signal?.aborted).toBe(true);
    });

    test("bounds and cancels the primary Android discovery under the same deadline", async () => {
      const timer = new FakeTimer();
      // The primary discovery path (deviceManager.listDeviceImages("android") ->
      // emulator -list-avds) hangs. It must be bounded by the single deadline and
      // its child cancelled, not left running to accumulate across reads.
      fakeDeviceUtils.setDeviceImages("android", [
        { name: "Pixel_9", platform: "android", deviceId: "avd-late", source: "local" },
      ]);
      fakeDeviceUtils.setListDeviceImagesHangs("android", true);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        timer,
        androidCatalogBudgetMs: 5_000,
      });

      const pending = handler.getDeviceImagesForPlatforms(["android"]);
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      timer.advanceTime(5_001);
      const result = await pending;

      expect(result.catalogComplete).toBe(false);
      expect(result.catalogObservations.android).toMatchObject({
        catalogComplete: false,
        error: {
          code: "timeout",
          message: expect.stringContaining("5000"),
        },
      });
      expect(result.configuredInventory).toEqual({
        schemaVersion: 1,
        complete: false,
        observations: {
          android: {
            complete: false,
            error: {
              code: "timeout",
              message: expect.stringContaining("5000"),
            },
          },
        },
      });
      // androidCount stays finalized as incomplete and no images were appended
      // after the timeout, even though a device was configured for the listing.
      expect(result.androidCount).toBe(0);
      expect(result.images).toHaveLength(0);
      // The hung primary discovery child must have been passed the deadline's
      // signal and cancelled, not left running.
      const calls = fakeDeviceUtils.getListDeviceImagesCalls();
      const androidCall = calls.find((call) => call.platform === "android");
      expect(androidCall).toBeDefined();
      expect(androidCall?.signal?.aborted).toBe(true);
    });

    test("does not publish a configured device that resolves after the deadline", async () => {
      const timer = new FakeTimer();
      const lateDiscovery = Promise.withResolvers<DeviceImageDiscovery>();
      const deviceManager = {
        getDeviceImagesDetailed: async () => await lateDiscovery.promise,
      } as unknown as PlatformDeviceManager;
      const handler = createDeviceImageResourcesHandler({
        deviceManager,
        avdManager: fakeAvdManager,
        timer,
        androidCatalogBudgetMs: 5_000,
      });

      const pending = handler.getDeviceImagesForPlatforms(["android"]);
      await Promise.resolve();
      timer.advanceTime(5_001);
      const result = await pending;
      const returnedSnapshot = JSON.stringify(result);

      expect(result.totalCount).toBe(result.androidCount);
      expect(result.androidCount).toBe(result.images.length);
      expect(result.configuredInventory.observations.android).toMatchObject({
        complete: false,
        error: { code: "timeout" },
      });

      lateDiscovery.resolve({
        devices: [
          {
            name: "Pixel_9_Late",
            platform: "android",
            deviceId: "late-avd",
            isRunning: false,
          },
        ],
        succeededPlatforms: new Set(["android"]),
      });
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(JSON.stringify(result)).toBe(returnedSnapshot);
      expect(result.totalCount).toBe(0);
      expect(result.androidCount).toBe(0);
      expect(result.images).toEqual([]);
    });

    test("does not publish images or metadata that resolve after the deadline", async () => {
      const timer = new FakeTimer();
      const lateMetadata = Promise.withResolvers<AvdInfo[]>();
      let metadataSignal: AbortSignal | undefined;
      fakeDeviceUtils.setDeviceImages("android", [
        {
          name: "Pixel_9_Late_Metadata",
          platform: "android",
          deviceId: "late-metadata-avd",
          isRunning: false,
        },
      ]);
      const avdManager = {
        listDeviceImages: async (signal?: AbortSignal) => {
          metadataSignal = signal;
          return await lateMetadata.promise;
        },
        listInstalledSystemImages: async () => [],
        listDevices: async () => [],
      } as unknown as AvdManager;
      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager,
        timer,
        androidCatalogBudgetMs: 5_000,
      });

      const pending = handler.getDeviceImagesForPlatforms(["android"]);
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
      timer.advanceTime(5_001);
      const result = await pending;
      const returnedSnapshot = JSON.stringify(result);

      expect(metadataSignal?.aborted).toBe(true);
      expect(result.totalCount).toBe(result.androidCount);
      expect(result.androidCount).toBe(result.images.length);
      expect(result.configuredInventory.observations.android).toMatchObject({
        complete: false,
        error: { code: "timeout" },
      });

      lateMetadata.resolve([
        {
          name: "Pixel_9_Late_Metadata",
          path: "/late/Pixel_9_Late_Metadata.avd",
        },
      ]);
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(JSON.stringify(result)).toBe(returnedSnapshot);
      expect(result.totalCount).toBe(0);
      expect(result.androidCount).toBe(0);
      expect(result.images).toEqual([]);
    });

    test("aborts profile enumeration too when the deadline wins", async () => {
      const timer = new FakeTimer();
      fakeDeviceUtils.setDeviceImages("android", []);
      // listInstalledSystemImages would resolve, but the concurrently-raced
      // profile enumeration hangs. The timeout must abort BOTH, so a stalled
      // `avdmanager list device` child cannot run on to its own 60s timeout.
      fakeAvdManager.setListInstalledSystemImagesResponse([]);
      fakeAvdManager.setListDevicesHangs(true);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        timer,
        androidCatalogBudgetMs: 5_000,
      });

      const pending = handler.getDeviceImagesForPlatforms(["android"]);
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      timer.advanceTime(5_001);
      const result = await pending;

      expect(result.catalogComplete).toBe(false);
      expect(result.catalogObservations.android).toMatchObject({
        catalogComplete: false,
        error: { code: "timeout" },
      });
      const profileCalls = fakeAvdManager.getListDevicesCalls();
      expect(profileCalls).toHaveLength(1);
      expect(profileCalls[0].signal?.aborted).toBe(true);
    });

    test("reports iOS catalog failure when strict simulator discovery fails", async () => {
      fakeDeviceUtils.setDeviceImages("ios", []);
      fakeSimCtl.setRuntimesError(new Error("malformed simctl runtimes JSON"));

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        simctl: fakeSimCtl,
      });
      const result = await handler.getDeviceImagesForPlatforms(["ios"]);

      expect(result.catalogComplete).toBe(false);
      expect(result.catalogObservations.ios).toMatchObject({
        catalogComplete: false,
        error: {
          code: "failed",
          message: expect.stringContaining("malformed simctl runtimes JSON"),
        },
      });
      expect(result.configuredInventory).toEqual({
        schemaVersion: 1,
        complete: true,
        observations: { ios: { complete: true } },
      });
    });

    test("should return correct image counts when there are images", async () => {
      // Set up mock Android devices
      const androidDevices: DeviceInfo[] = [
        { name: "Pixel_6_API_33", platform: "android", deviceId: "avd-1", source: "local" },
        { name: "Pixel_7_API_34", platform: "android", deviceId: "avd-2", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("android", androidDevices);

      // Set up mock iOS devices
      const iosDevices: DeviceInfo[] = [
        { name: "iPhone 14", platform: "ios", deviceId: "sim-1", source: "local" },
        { name: "iPhone 15 Pro", platform: "ios", deviceId: "sim-2", source: "local" },
        { name: "iPad Pro", platform: "ios", deviceId: "sim-3", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("ios", iosDevices);

      // Set up mock AVD info (no extended info for simplicity)
      fakeAvdManager.setListDeviceImagesResponse([]);

      // Create handler with fakes
      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      // Get all device images
      const result = await handler.getDeviceImagesForPlatforms(["android", "ios"]);

      // Verify counts
      expect(result.totalCount).toBe(5);
      expect(result.androidCount).toBe(2);
      expect(result.iosCount).toBe(3);
      expect(result.images).toHaveLength(5);

      // Verify lastUpdated is a valid ISO date
      expect(() => new Date(result.lastUpdated)).not.toThrow();
      expect(new Date(result.lastUpdated).toISOString()).toBe(result.lastUpdated);
    });

    test("should return empty counts when there are no images", async () => {
      // Set up empty device lists
      fakeDeviceUtils.setDeviceImages("android", []);
      fakeDeviceUtils.setDeviceImages("ios", []);
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesForPlatforms(["android", "ios"]);

      expect(result.totalCount).toBe(0);
      expect(result.androidCount).toBe(0);
      expect(result.iosCount).toBe(0);
      expect(result.images).toHaveLength(0);
      expect(result.configuredInventory).toEqual({
        schemaVersion: 1,
        complete: true,
        observations: {
          android: { complete: true },
          ios: { complete: true },
        },
      });
      expect(fakeDeviceUtils.getGetDeviceImagesDetailedCalls()).toEqual([
        {
          platform: "android",
          options: { signal: expect.any(AbortSignal) },
        },
        {
          platform: "ios",
          options: { bypassIosDeviceListCache: true },
        },
      ]);
    });

    test("reports complete-empty Android inventory", async () => {
      fakeDeviceUtils.setDeviceImages("android", []);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });
      const result = await handler.getDeviceImagesForPlatforms(["android"]);

      expect(result.images).toEqual([]);
      expect(result.configuredInventory).toEqual({
        schemaVersion: 1,
        complete: true,
        observations: { android: { complete: true } },
      });
      expect(result.catalogComplete).toBe(true);
    });

    test("reports complete-empty iOS inventory and bypasses simulator caches", async () => {
      fakeDeviceUtils.setDeviceImages("ios", []);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        simctl: fakeSimCtl,
      });
      const result = await handler.getDeviceImagesForPlatforms(["ios"]);

      expect(result.images).toEqual([]);
      expect(result.configuredInventory).toEqual({
        schemaVersion: 1,
        complete: true,
        observations: { ios: { complete: true } },
      });
      expect(fakeDeviceUtils.getGetDeviceImagesDetailedCalls()).toEqual([
        {
          platform: "ios",
          options: { bypassIosDeviceListCache: true },
        },
      ]);
    });

    test("uses exact Android AVD names and iOS UDIDs as stable IDs", async () => {
      fakeDeviceUtils.setDeviceImages("android", [
        {
          name: "Pixel_9_API_35",
          platform: "android",
          deviceId: "compat-android-id",
          isRunning: false,
        },
      ]);
      fakeDeviceUtils.setDeviceImages("ios", [
        {
          name: "iPhone 17 Pro",
          platform: "ios",
          deviceId: "AAAA-BBBB-CCCC-DDDD",
          isRunning: false,
        },
      ]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        simctl: fakeSimCtl,
      });
      const result = await handler.getDeviceImagesForPlatforms(["android", "ios"]);

      expect(result.images).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            platform: "android",
            identity: { stableId: "Pixel_9_API_35" },
            name: "Pixel_9_API_35",
          }),
          expect.objectContaining({
            platform: "ios",
            identity: { stableId: "AAAA-BBBB-CCCC-DDDD" },
            name: "iPhone 17 Pro",
          }),
        ]),
      );
    });

    test("marks failed and mixed-platform configured inventories incomplete", async () => {
      fakeDeviceUtils.setDeviceImages("android", []);
      fakeDeviceUtils.setDeviceImages("ios", []);
      fakeDeviceUtils.failedPlatforms.add("ios");

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
        simctl: fakeSimCtl,
      });
      const result = await handler.getDeviceImagesForPlatforms(["android", "ios"]);

      expect(result.configuredInventory).toEqual({
        schemaVersion: 1,
        complete: false,
        observations: {
          android: { complete: true },
          ios: {
            complete: false,
            error: {
              code: "unavailable",
              message: "iOS device inventory is unavailable.",
            },
          },
        },
      });
      expect(result.catalogComplete).toBe(true);
    });

    test("should filter to android platform only", async () => {
      // Set up mock devices for both platforms
      const androidDevices: DeviceInfo[] = [
        { name: "Pixel_6_API_33", platform: "android", deviceId: "avd-1", source: "local" },
      ];
      const iosDevices: DeviceInfo[] = [
        { name: "iPhone 14", platform: "ios", deviceId: "sim-1", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("android", androidDevices);
      fakeDeviceUtils.setDeviceImages("ios", iosDevices);
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      // Request only Android
      const result = await handler.getDeviceImagesForPlatforms(["android"]);

      expect(result.totalCount).toBe(1);
      expect(result.androidCount).toBe(1);
      expect(result.iosCount).toBe(0);
      expect(result.images).toHaveLength(1);
      expect(result.images[0].platform).toBe("android");
      expect(result.images[0].name).toBe("Pixel_6_API_33");
    });

    test("should filter to ios platform only", async () => {
      // Set up mock devices for both platforms
      const androidDevices: DeviceInfo[] = [
        { name: "Pixel_6_API_33", platform: "android", deviceId: "avd-1", source: "local" },
      ];
      const iosDevices: DeviceInfo[] = [
        { name: "iPhone 14", platform: "ios", deviceId: "sim-1", source: "local" },
        { name: "iPhone 15", platform: "ios", deviceId: "sim-2", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("android", androidDevices);
      fakeDeviceUtils.setDeviceImages("ios", iosDevices);
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      // Request only iOS
      const result = await handler.getDeviceImagesForPlatforms(["ios"]);

      expect(result.totalCount).toBe(2);
      expect(result.androidCount).toBe(0);
      expect(result.iosCount).toBe(2);
      expect(result.images).toHaveLength(2);
      for (const image of result.images) {
        expect(image.platform).toBe("ios");
      }
    });

    test("should pass through iOS simulator metadata", async () => {
      const iosDevices: DeviceInfo[] = [
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          deviceId: "sim-15-pro",
          source: "local",
          state: "Booted",
          isAvailable: true,
          iosVersion: "17.4",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-4",
          model: "iPhone15,3",
          architecture: "arm64",
          availabilityError: undefined,
        },
      ];
      fakeDeviceUtils.setDeviceImages("ios", iosDevices);
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesForPlatforms(["ios"]);
      expect(result.totalCount).toBe(1);
      expect(result.images[0]).not.toHaveProperty("state");
      expect(result.images[0].runtime.lifecycle).toEqual({ state: "booted", known: true });
      expect(result.images[0].osVersion).toBe("17.4");
      expect(result.images[0].deviceType).toBe(
        "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
      );
      expect(result.images[0].runtimeId).toBe("com.apple.CoreSimulator.SimRuntime.iOS-17-4");
      expect(result.images[0].model).toBe("iPhone15,3");
      expect(result.images[0].architecture).toBe("arm64");
    });

    test("normalizes a stopped iOS simulator's lifecycle", async () => {
      fakeDeviceUtils.setDeviceImages("ios", [
        {
          name: "iPhone 15",
          platform: "ios",
          deviceId: "sim-15",
          isRunning: false,
          state: "Shutdown",
        },
      ]);
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesForPlatforms(["ios"]);

      expect(result.images[0]).not.toHaveProperty("state");
      expect(result.images[0].runtime.lifecycle).toEqual({ state: "configured", known: true });
    });

    test("should include extended AVD metadata for Android images", async () => {
      // Set up mock Android devices
      const androidDevices: DeviceInfo[] = [
        { name: "Pixel_6_API_33", platform: "android", deviceId: "avd-1", source: "local" },
        { name: "Pixel_7_API_34", platform: "android", deviceId: "avd-2", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("android", androidDevices);

      // Set up extended AVD info
      const avdInfoList: AvdInfo[] = [
        {
          name: "Pixel_6_API_33",
          path: "/Users/test/.android/avd/Pixel_6_API_33.avd",
          target: "Google APIs (Google Inc.)",
          basedOn: "Android 13.0 (API 33)",
        },
        {
          name: "Pixel_7_API_34",
          path: "/Users/test/.android/avd/Pixel_7_API_34.avd",
          target: "Google Play (Google Inc.)",
          basedOn: "Android 14 (API 34)",
          error: undefined,
        },
      ];
      fakeAvdManager.setListDeviceImagesResponse(avdInfoList);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesForPlatforms(["android"]);

      expect(result.totalCount).toBe(2);
      expect(result.androidCount).toBe(2);

      // Verify extended metadata for first device
      const pixel6 = result.images.find((img) => img.name === "Pixel_6_API_33");
      expect(pixel6).toBeDefined();
      expect(pixel6?.image.path).toBe("/Users/test/.android/avd/Pixel_6_API_33.avd");
      expect(pixel6?.image.target).toBe("Google APIs (Google Inc.)");
      expect(pixel6?.image.basedOn).toBe("Android 13.0 (API 33)");

      // Verify extended metadata for second device
      const pixel7 = result.images.find((img) => img.name === "Pixel_7_API_34");
      expect(pixel7).toBeDefined();
      expect(pixel7?.image.path).toBe("/Users/test/.android/avd/Pixel_7_API_34.avd");
      expect(pixel7?.image.target).toBe("Google Play (Google Inc.)");
      expect(pixel7?.image.basedOn).toBe("Android 14 (API 34)");
    });

    test("should handle AVD info with errors", async () => {
      // Set up mock Android device
      const androidDevices: DeviceInfo[] = [
        { name: "Corrupted_AVD", platform: "android", deviceId: "avd-err", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("android", androidDevices);

      // Set up AVD info with an error
      const avdInfoList: AvdInfo[] = [
        {
          name: "Corrupted_AVD",
          path: "/Users/test/.android/avd/Corrupted_AVD.avd",
          error: "Error: config.ini is missing",
        },
      ];
      fakeAvdManager.setListDeviceImagesResponse(avdInfoList);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesForPlatforms(["android"]);

      expect(result.totalCount).toBe(1);
      const corruptedAvd = result.images[0];
      expect(corruptedAvd.name).toBe("Corrupted_AVD");
      expect(corruptedAvd.availabilityError).toBe("Error: config.ini is missing");
    });

    test("should handle missing AVD info gracefully", async () => {
      // Set up mock Android devices
      const androidDevices: DeviceInfo[] = [
        {
          name: "Device_Without_AVD_Info",
          platform: "android",
          deviceId: "avd-1",
          source: "local",
        },
      ];
      fakeDeviceUtils.setDeviceImages("android", androidDevices);

      // No matching AVD info
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesForPlatforms(["android"]);

      expect(result.totalCount).toBe(1);
      const device = result.images[0];
      expect(device.name).toBe("Device_Without_AVD_Info");
      expect(device.platform).toBe("android");
      expect(device.image).toEqual({ path: null, target: null, basedOn: null });
      expect(device.availabilityError).toBeNull();
    });

    test("should not include extended AVD metadata for iOS images", async () => {
      // Set up mock iOS devices
      const iosDevices: DeviceInfo[] = [
        { name: "iPhone 14", platform: "ios", deviceId: "sim-1", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("ios", iosDevices);

      // AVD info should not be used for iOS
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesForPlatforms(["ios"]);

      expect(result.totalCount).toBe(1);
      const iosDevice = result.images[0];
      expect(iosDevice.platform).toBe("ios");
      expect(iosDevice.image).toEqual({ path: null, target: null, basedOn: null });
    });
  });

  describe("getAllDeviceImages", () => {
    test("should return ResourceContent with all device images", async () => {
      const androidDevices: DeviceInfo[] = [
        { name: "Pixel_6", platform: "android", deviceId: "avd-1", source: "local" },
      ];
      const iosDevices: DeviceInfo[] = [
        { name: "iPhone 14", platform: "ios", deviceId: "sim-1", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("android", androidDevices);
      fakeDeviceUtils.setDeviceImages("ios", iosDevices);
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getAllDeviceImages();

      expect(result.uri).toBe("automobile:devices/images");
      expect(result.mimeType).toBe("application/json");
      expect(result.text).toBeDefined();

      const data: DeviceImagesResourceContent = JSON.parse(result.text!);
      expect(data.totalCount).toBe(2);
      expect(data.androidCount).toBe(1);
      expect(data.iosCount).toBe(1);
    });
  });

  describe("getDeviceImagesByPlatform", () => {
    test("should return android-specific images via platform param", async () => {
      const androidDevices: DeviceInfo[] = [
        { name: "Pixel_6", platform: "android", deviceId: "avd-1", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("android", androidDevices);
      fakeDeviceUtils.setDeviceImages("ios", []);
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesByPlatform({ platform: "android" });

      expect(result.uri).toBe("automobile:devices/images/android");
      expect(result.mimeType).toBe("application/json");

      const data: DeviceImagesResourceContent = JSON.parse(result.text!);
      expect(data.androidCount).toBe(1);
      expect(data.iosCount).toBe(0);
    });

    test("should return ios-specific images via platform param", async () => {
      const iosDevices: DeviceInfo[] = [
        { name: "iPhone 14", platform: "ios", deviceId: "sim-1", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("android", []);
      fakeDeviceUtils.setDeviceImages("ios", iosDevices);
      fakeAvdManager.setListDeviceImagesResponse([]);

      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesByPlatform({ platform: "ios" });

      expect(result.uri).toBe("automobile:devices/images/ios");
      expect(result.mimeType).toBe("application/json");

      const data: DeviceImagesResourceContent = JSON.parse(result.text!);
      expect(data.androidCount).toBe(0);
      expect(data.iosCount).toBe(1);
    });

    test("should return error for invalid platform", async () => {
      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
        avdManager: fakeAvdManager,
      });

      const result = await handler.getDeviceImagesByPlatform({ platform: "windows" });

      expect(result.uri).toBe("automobile:devices/images/windows");
      expect(result.mimeType).toBe("application/json");

      const data = JSON.parse(result.text!);
      expect(data.error).toBeDefined();
      expect(data.error).toContain("Invalid platform");
      expect(data.error).toContain("windows");
    });
  });

  describe("Partial dependency injection", () => {
    test("should allow providing only deviceManager", async () => {
      const iosDevices: DeviceInfo[] = [
        { name: "Test iPhone", platform: "ios", deviceId: "sim-test", source: "local" },
      ];
      fakeDeviceUtils.setDeviceImages("ios", iosDevices);

      // Only provide deviceManager. Use the iOS path so the default Android AVD
      // manager is not touched by this unit test.
      const handler = createDeviceImageResourcesHandler({
        deviceManager: fakeDeviceUtils,
      });

      const result = await handler.getDeviceImagesForPlatforms(["ios"]);

      expect(result.totalCount).toBe(1);
      expect(result.images[0].name).toBe("Test iPhone");
    });

    test("should allow providing only avdManager", async () => {
      const avdInfoList: AvdInfo[] = [
        {
          name: "Pixel_Test",
          path: "/path/to/avd",
          target: "Google APIs",
        },
      ];
      fakeAvdManager.setListDeviceImagesResponse(avdInfoList);

      // Only provide avdManager - deviceManager will be defaulted
      // Note: This test verifies partial DI works but won't produce faked device data
      // since we're using the real device manager
      const handler = createDeviceImageResourcesHandler({
        avdManager: fakeAvdManager,
      });

      // The handler was created successfully with partial deps
      expect(handler).toBeDefined();
      expect(handler.getAllDeviceImages).toBeDefined();
      expect(handler.getDeviceImagesByPlatform).toBeDefined();
      expect(handler.getDeviceImagesForPlatforms).toBeDefined();
    });
  });
});
