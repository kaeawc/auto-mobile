import { describe, expect, mock, test } from "bun:test";
import {
  DeviceSessionManager,
  type ConnectedPlatformScan,
  type DeviceReadyOptions,
} from "../../src/devices/DeviceSessionManager";
import {
  ActionableError,
  type BootedDevice,
  type DeviceInfo,
  type Platform,
  type SomePlatform,
} from "../../src/models";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import type {
  IosBootInstrumentation,
  IosBootRequest,
} from "../../src/features/iosSimFleet/IosBootInstrumentation";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeWindow } from "../fakes/FakeWindow";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { drainUntil, settleByFakeEvents } from "../helpers/fakeTimerStepping";

class FakeReadSimctl extends FakeSimctl {
  readonly presentations: string[] = [];
  readonly imageSignals: AbortSignal[] = [];
  imageError?: Error;
  imagesHang = false;
  async listSimulatorImages(
    _timeoutMs?: number,
    options?: { bypassCache?: boolean; signal?: AbortSignal },
  ): Promise<DeviceInfo[]> {
    const images = await super.listSimulatorImages();
    if (options?.signal) {
      this.imageSignals.push(options.signal);
    }
    if (this.imageError) {
      throw this.imageError;
    }
    if (this.imagesHang) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    }
    return images;
  }
  async presentSimulatorAfterStart(udid: string): Promise<void> {
    this.presentations.push(udid);
  }
}

class FakeReadIosBootInstrumentation implements IosBootInstrumentation {
  readonly requests: IosBootRequest[] = [];
  error?: Error;
  async run<T>(request: IosBootRequest, boot: (remainingMs: number) => Promise<T>): Promise<T> {
    this.requests.push(request);
    if (this.error) {
      throw this.error;
    }
    return await boot(request.timeoutMs);
  }
}

function harness(platform: Platform, daemon: boolean, simctlAvailable = true) {
  const device: BootedDevice = {
    platform,
    name: platform === "android" ? "Named_Pixel" : "Named iPhone",
    deviceId: platform === "android" ? "emulator-5556" : "named-ios",
  };
  const image: DeviceInfo = { ...device, isRunning: false, isAvailable: true };
  const firstImage: DeviceInfo = {
    ...image,
    name: "First image",
    deviceId: platform === "android" ? "emulator-5554" : "first-ios",
  };
  const adb = new FakeAdbExecutor();
  const devices = new FakeDeviceUtils();
  const simctl = new FakeReadSimctl();
  const timer = new FakeTimer();
  const lifecycle = new FakeVirtualDeviceLifecycleCoordinator();
  const instrumentation = new FakeReadIosBootInstrumentation();
  const window = new FakeWindow();
  window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
  const apply = mock(async () => {});
  const getConfig = mock(async () => ({
    syncWithHost: false,
    defaultMode: "light" as const,
    applyOnConnect: false,
  }));
  const manager = DeviceSessionManager.createInstance(
    new FakeDeviceClientProvider(
      adb,
      devices,
      simctlAvailable ? (simctl as unknown as SimCtlClient) : undefined,
      { window },
    ),
    { create: () => adb },
    {
      runnerReadinessTimer: timer,
      lifecycleCoordinator: lifecycle,
      idGenerator: new FakeIdGenerator(),
      admissionGate: { assertDeviceActionable: () => {} },
      executionBinding: { bindDeviceExecution: () => {} },
      iosBootInstrumentation: instrumentation,
      appearanceOnConnectDependencies: {
        isSyncEnabled: () => true,
        getConfig,
        resolveMode: async () => "light",
        apply,
      },
    },
  );
  const scan: ConnectedPlatformScan = {
    devices: [],
    scanned: { android: true, ios: simctlAvailable },
  };
  const options: DeviceReadyOptions = {
    intent: "read",
    readiness: "booted",
    ...(daemon ? { getConnectedPlatforms: async () => scan } : {}),
  };
  function setRunning(running: BootedDevice[]) {
    scan.devices = running;
    adb.setDevices(running.filter((d) => d.platform === "android"));
    devices.setBootedDevices(
      "android",
      running.filter((d) => d.platform === "android"),
    );
    simctl.setBootedSimulators(running.filter((d) => d.platform === "ios"));
  }
  function setImages(images: DeviceInfo[]) {
    devices.setDeviceImages(
      "android",
      images.filter((d) => d.platform === "android"),
    );
    simctl.setAvailableSimulators(images.filter((d) => d.platform === "ios"));
    for (const d of images) {
      if (d.platform === "ios" && d.deviceId) {
        simctl.setDeviceInfo(d.deviceId, {
          udid: d.deviceId,
          name: d.name,
          state: "Booted",
          isAvailable: true,
        });
      }
      devices.setMockChildProcess(d.name, null);
    }
  }
  const start = devices.startDevice.bind(devices);
  const startCalls: string[] = [];
  let startError: Error | undefined;
  devices.startDevice = async (target, timeout) => {
    startCalls.push(target.name);
    if (startError) {
      throw startError;
    }
    const result = await start(target, timeout);
    adb.setDevices(await devices.getBootedDevices("android"));
    return result;
  };
  function incomplete(p: Platform) {
    scan.scanned[p] = false;
    if (p === "android") {
      adb.getBootedAndroidDevices = async () => {
        throw new Error("fake adb discovery failed");
      };
    } else {
      simctl.setBootedSimulatorsError(new Error("fake simctl discovery failed"));
    }
  }
  function assertNoBoot() {
    expect(startCalls).toEqual([]);
    expect(simctl.getMethodCalls("bootSimulator")).toEqual([]);
    expect(simctl.getMethodCalls("createSimulator")).toEqual([]);
    expect(instrumentation.requests).toEqual([]);
  }
  function assertNoReadWrites() {
    expect(manager.getCurrentDevice()).toBeUndefined();
    expect(manager.getCurrentPlatform()).toBeUndefined();
    expect(manager.getExplicitDevicePin()).toBeUndefined();
    expect(getConfig).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(
      adb.getExecutedCommands().filter((c) => /settings (put|delete)|cmd uimode/.test(c)),
    ).toEqual([]);
  }
  function assertEmptySelection() {
    assertNoBoot();
    assertNoReadWrites();
    expect(devices.getCallCount("listDeviceImages")).toBe(0);
    expect(simctl.getMethodCalls("listSimulatorImages")).toEqual([]);
    expect(lifecycle.reservations).toEqual([]);
  }
  setRunning([]);
  setImages([firstImage, image]);
  return {
    manager,
    device,
    image,
    firstImage,
    options,
    scan,
    adb,
    devices,
    simctl,
    timer,
    lifecycle,
    window,
    instrumentation,
    getConfig,
    apply,
    startCalls,
    setRunning,
    setImages,
    incomplete,
    assertNoBoot,
    assertNoReadWrites,
    assertEmptySelection,
    refuseBoot: (error: Error) => {
      startError = error;
      instrumentation.error = error;
    },
    id: platform === "android" ? image.name : image.deviceId!,
  };
}

function noDeviceMessage(platform: SomePlatform): string {
  const label =
    platform === "either" ? "Android or iOS" : platform === "android" ? "Android" : "iOS";
  return `No ${label} device is running, so there is nothing to read. Start one with startDevice or provisionDevice, or pass a deviceId.`;
}

describe("read boots only an explicitly named stopped device", () => {
  for (const daemon of [false, true]) {
    for (const platform of ["android", "ios"] as const) {
      const lane = `${platform} ${daemon ? "daemon" : "direct"}`;
      for (const requested of [platform, "either"] as const) {
        test(`${lane}: ${requested} unnamed read has nothing to read`, async () => {
          const h = harness(platform, daemon);
          const error = await h.manager
            .ensureDeviceReady(requested, undefined, h.options)
            .catch((e: unknown) => e);
          expect(error).toBeInstanceOf(ActionableError);
          expect(error).not.toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
          expect(error).toHaveProperty("message", noDeviceMessage(requested));
          h.assertEmptySelection();
        });
        test(`${lane}: ${requested} incomplete unnamed read reports discovery_incomplete`, async () => {
          const h = harness(platform, daemon);
          h.incomplete(platform);
          if (requested === "either") {
            h.incomplete(platform === "android" ? "ios" : "android");
          }
          const error = await h.manager
            .ensureDeviceReady(requested, undefined, h.options)
            .catch((e: unknown) => e);
          expect(error).toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
          expect(error).toMatchObject({
            code: "discovery_incomplete",
            retryable: true,
            platform: requested === "either" ? "android" : platform,
          });
          h.assertEmptySelection();
        });
      }
      for (const selection of ["pin", "current"] as const) {
        test(`${lane}: stale ${selection} is not an explicit id`, async () => {
          const h = harness(platform, daemon);
          if (selection === "pin") {
            h.manager.setExplicitDevicePin(h.device);
          } else {
            h.manager.setCurrentDevice(h.device, platform);
          }
          await expect(h.manager.ensureDeviceReady(platform, undefined, h.options)).rejects.toThrow(
            noDeviceMessage(platform),
          );
          h.assertNoBoot();
          expect(h.lifecycle.reservations).toEqual([]);
          expect(h.devices.getCallCount("listDeviceImages")).toBe(0);
          expect(h.simctl.getMethodCalls("listSimulatorImages")).toEqual([]);
        });
      }
      test(`${lane}: running device remains usable without selection writes`, async () => {
        const h = harness(platform, daemon);
        h.setRunning([h.device]);
        h.setImages([{ ...h.image, isRunning: true }]);
        expect(await h.manager.ensureDeviceReady(platform, undefined, h.options)).toEqual(h.device);
        h.assertNoBoot();
        h.assertNoReadWrites();
      });
      test(`${lane}: multiple running devices keep the existing selection order`, async () => {
        const h = harness(platform, daemon);
        const other = {
          ...h.device,
          name: "Other device",
          deviceId: platform === "android" ? "emulator-5554" : "aaaa-ios",
        };
        h.setRunning([h.device, other]);
        h.setImages([
          { ...h.image, isRunning: true },
          { ...other, isRunning: true },
        ]);
        expect(await h.manager.ensureDeviceReady(platform, undefined, h.options)).toEqual(
          platform === "android" ? h.device : other,
        );
        h.assertNoBoot();
        h.assertNoReadWrites();
      });
      test(`${lane}: a running name resolves to its serial/UDID without booting`, async () => {
        const h = harness(platform, daemon);
        h.setRunning([h.device]);
        h.setImages([{ ...h.image, isRunning: true }]);
        expect(await h.manager.ensureDeviceReady(platform, h.device.name, h.options)).toEqual(
          h.device,
        );
        h.assertNoBoot();
        h.assertNoReadWrites();
      });
      test(`${lane}: an ambiguous running name lists the same candidate ids`, async () => {
        const h = harness(platform, daemon);
        h.setRunning([h.device, { ...h.device, deviceId: "second-id" }]);
        await expect(
          h.manager.ensureDeviceReady(platform, h.device.name, h.options),
        ).rejects.toThrow(
          `Ambiguous running device name '${h.device.name}'. Candidates: ${[h.device.deviceId, "second-id"].sort().join(", ")}. Provide a deviceId.`,
        );
        h.assertNoBoot();
        h.assertNoReadWrites();
      });
      for (const requested of [platform, "either"] as const) {
        test(`${lane}: ${requested} named stopped image boots exactly once`, async () => {
          const h = harness(platform, daemon);
          const result = await h.manager.ensureDeviceReady(requested, h.id, h.options);
          expect(result.deviceId).toBe(h.device.deviceId);
          expect(result.platform).toBe(platform);
          expect(h.startCalls).toEqual(platform === "android" ? [h.image.name] : []);
          expect(h.simctl.getMethodCalls("bootSimulator")).toEqual(
            platform === "ios" ? [{ udid: h.id }] : [],
          );
          expect(h.simctl.getMethodCalls("createSimulator")).toEqual([]);
          expect(h.lifecycle.reservations).toEqual([
            { identity: { kind: "stable", platform, stableId: h.id }, operation: "start" },
          ]);
          h.assertNoReadWrites();
        });
      }
      test(`${lane}: capacity error propagates unchanged with no retry`, async () => {
        const h = harness(platform, daemon);
        const error = new BootCapacityExhaustedError(
          { platform, limit: 1, booted: 1, retryAfterMs: 3000 },
          "No boot capacity",
        );
        h.refuseBoot(error);
        const result = await h.manager
          .ensureDeviceReady(platform, h.id, h.options)
          .catch((e: unknown) => e);
        expect(result).toBe(error);
        expect(result).toMatchObject({ code: "capacity_exhausted", retryable: true });
        expect(h.startCalls).toEqual(platform === "android" ? [h.id] : []);
        expect(h.instrumentation.requests.map((r) => r.udid)).toEqual(
          platform === "ios" ? [h.id] : [],
        );
        expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
        expect(h.lifecycle.isReserved({ kind: "stable", platform, stableId: h.id })).toBe(false);
        h.assertNoReadWrites();
      });
      test(`${lane}: incomplete named read never boots`, async () => {
        const h = harness(platform, daemon);
        h.incomplete(platform);
        await expect(h.manager.ensureDeviceReady(platform, h.id, h.options)).rejects.toBeInstanceOf(
          BootedDeviceDiscoveryIncompleteError,
        );
        h.assertNoBoot();
        expect(h.lifecycle.reservations).toEqual([]);
      });
      test(`${lane}: either named read requires the matched platform's complete scan`, async () => {
        const h = harness(platform, daemon);
        h.incomplete(platform);
        await expect(h.manager.ensureDeviceReady("either", h.id, h.options)).rejects.toMatchObject({
          code: "discovery_incomplete",
          platform,
        });
        h.assertNoBoot();
        expect(h.lifecycle.reservations).toEqual([]);
      });
      test(`${lane}: failed named image listing preserves its typed error`, async () => {
        const h = harness(platform, daemon);
        const error = new BootedDeviceDiscoveryIncompleteError(platform, {
          code: "failed",
          message: "fake inventory failed",
        });
        if (platform === "android") {
          h.devices.listDeviceImages = async () => {
            throw error;
          };
        } else {
          h.simctl.imageError = error;
        }
        expect(
          await h.manager.ensureDeviceReady(platform, h.id, h.options).catch((e: unknown) => e),
        ).toBe(error);
        h.assertNoBoot();
        expect(h.lifecycle.reservations).toEqual([]);
      });
      test(`${lane}: hanging named image listing reports discovery_incomplete`, async () => {
        const h = harness(platform, daemon);
        if (platform === "android") {
          h.devices.setListDeviceImagesHangs(platform, true);
        } else {
          h.simctl.imagesHang = true;
        }
        const result = h.manager
          .ensureDeviceReady(platform, h.id, h.options)
          .catch((e: unknown) => e);
        const error = await settleByFakeEvents(h.timer, result, {
          description: "named image discovery deadline",
        });
        expect(error).toMatchObject({
          code: "discovery_incomplete",
          retryable: true,
          platform,
          discoveryError: { code: "timeout" },
        });
        if (platform === "ios") {
          expect(h.simctl.imageSignals[0]?.aborted).toBe(true);
        } else {
          expect(h.devices.getListDeviceImagesCalls()[0]?.signal?.aborted).toBe(true);
        }
        h.assertNoBoot();
        expect(h.lifecycle.reservations).toEqual([]);
        h.assertNoReadWrites();
      });
      test(`${lane}: an untyped image listing failure becomes discovery_incomplete`, async () => {
        const h = harness(platform, daemon);
        const error = new Error("fake inventory failed");
        if (platform === "android") {
          h.devices.listDeviceImages = async () => {
            throw error;
          };
        } else {
          h.simctl.imageError = error;
        }
        await expect(h.manager.ensureDeviceReady(platform, h.id, h.options)).rejects.toBeInstanceOf(
          BootedDeviceDiscoveryIncompleteError,
        );
        h.assertNoBoot();
      });
      test(`${lane}: a running current device's verification error surfaces without booting`, async () => {
        const h = harness(platform, daemon);
        h.setRunning([h.device]);
        h.manager.setCurrentDevice(h.device, platform);
        const error = new ActionableError("CtrlProxy is not enabled");
        const verifiedIds: string[] = [];
        h.manager.verifyDevice = async () => {
          verifiedIds.push(h.device.deviceId);
          throw error;
        };
        expect(
          await h.manager
            .ensureDeviceReady(platform, undefined, h.options)
            .catch((e: unknown) => e),
        ).toBe(error);
        expect(verifiedIds).toEqual([h.device.deviceId]);
        h.assertNoBoot();
        expect(h.devices.getCallCount("listDeviceImages")).toBe(0);
        expect(h.simctl.getMethodCalls("listSimulatorImages")).toEqual([]);
        h.assertNoReadWrites();
      });
      test(`${lane}: platform mismatch fallback never boots`, async () => {
        const h = harness(platform, daemon);
        h.setRunning([h.device]);
        h.manager.verifyDevice = async () => {
          h.device.platform = platform === "android" ? "ios" : "android";
        };
        await expect(
          h.manager.ensureDeviceReady(platform, h.device.deviceId, h.options),
        ).rejects.toThrow(noDeviceMessage(platform));
        h.assertNoBoot();
        expect(h.devices.getCallCount("listDeviceImages")).toBe(0);
        expect(h.simctl.getMethodCalls("listSimulatorImages")).toEqual([]);
        h.assertNoReadWrites();
      });
      test(`${lane}: same id matching both platform inventories is ambiguous`, async () => {
        const h = harness(platform, daemon);
        h.setImages([
          { ...h.image, platform: "android", name: h.id },
          { ...h.image, platform: "ios", deviceId: h.id },
        ]);
        await expect(h.manager.ensureDeviceReady("either", h.id, h.options)).rejects.toThrow(
          `Device ${h.id} not found on either platform.`,
        );
        h.assertNoBoot();
        expect(h.lifecycle.reservations).toEqual([]);
      });
      for (const invalid of ["missing", "running", "ambiguous", "unavailable"] as const) {
        if (invalid === "unavailable" && platform !== "ios") {
          continue;
        }
        test(`${lane}: ${invalid} named image keeps the not-found answer`, async () => {
          const h = harness(platform, daemon);
          h.setImages(
            invalid === "missing"
              ? []
              : invalid === "ambiguous"
                ? [h.image, h.image]
                : [
                    {
                      ...h.image,
                      isRunning: invalid === "running",
                      isAvailable: invalid !== "unavailable",
                    },
                  ],
          );
          await expect(h.manager.ensureDeviceReady(platform, h.id, h.options)).rejects.toThrow(
            `Device ${h.id} not found on ${platform} platform. Available ${platform} devices: none`,
          );
          h.assertNoBoot();
          expect(h.lifecycle.reservations).toEqual([]);
          h.assertNoReadWrites();
        });
      }
      test(`${lane}: named stopped device resolves ahead of mixed-platform ambiguity`, async () => {
        const h = harness(platform, daemon);
        const running: BootedDevice[] = [
          { platform: "android", name: "Other_Pixel", deviceId: "emulator-5558" },
          { platform: "ios", name: "Other iPhone", deviceId: "other-ios" },
        ];
        h.setRunning(running);
        const result = await h.manager.ensureDeviceReady("either", h.id, h.options);
        expect(result.deviceId).toBe(h.device.deviceId);
        expect(result.platform).toBe(platform);
        h.assertNoReadWrites();
      });
      test(`${lane}: control without an id still boots the first image`, async () => {
        const h = harness(platform, daemon);
        const result = await h.manager.ensureDeviceReady(platform, undefined, {
          ...h.options,
          intent: undefined,
        });
        expect(result.deviceId).toBe(h.firstImage.deviceId!);
        expect(h.startCalls).toEqual(platform === "android" ? [h.firstImage.name] : []);
        expect(h.simctl.getMethodCalls("bootSimulator")).toEqual(
          platform === "ios" ? [{ udid: h.firstImage.deviceId }] : [],
        );
        expect(h.manager.getCurrentDevice()).toEqual(result);
      });
      test(`${lane}: control with a stopped id still fails without image lookup`, async () => {
        const h = harness(platform, daemon);
        await expect(
          h.manager.ensureDeviceReady(platform, h.id, { ...h.options, intent: undefined }),
        ).rejects.toThrow(`Device ${h.id} not found on ${platform} platform.`);
        h.assertEmptySelection();
      });
      if (platform === "android") {
        test(`${lane}: either named stopped AVD boots with no simctl`, async () => {
          const h = harness(platform, daemon, false);
          const result = await h.manager.ensureDeviceReady("either", h.id, h.options);
          expect(result.deviceId).toBe(h.device.deviceId);
          expect(result.platform).toBe("android");
          expect(h.startCalls).toEqual([h.image.name]);
          expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
          expect(h.simctl.getMethodCalls("createSimulator")).toEqual([]);
          h.assertNoReadWrites();
        });
        test(`${lane}: either unnamed read with no simctl gives the no-device answer`, async () => {
          const h = harness(platform, daemon, false);
          await expect(h.manager.ensureDeviceReady("either", undefined, h.options)).rejects.toThrow(
            noDeviceMessage("either"),
          );
          h.assertEmptySelection();
        });
        test(`${lane}: either named AVD ignores failed inventory on an unscanned platform`, async () => {
          const h = harness(platform, daemon);
          h.incomplete("ios");
          h.simctl.imageError = new Error("simctl unavailable");
          expect((await h.manager.ensureDeviceReady("either", h.id, h.options)).deviceId).toBe(
            h.device.deviceId,
          );
          expect(h.startCalls).toEqual([h.image.name]);
          expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
          h.assertNoReadWrites();
        });
        test(`${lane}: either unmatched id preserves an incomplete in-scope scan`, async () => {
          const h = harness(platform, daemon);
          h.incomplete("ios");
          await expect(
            h.manager.ensureDeviceReady("either", "missing", h.options),
          ).rejects.toMatchObject({ code: "discovery_incomplete", platform: "ios" });
          h.assertNoBoot();
          expect(h.lifecycle.reservations).toEqual([]);
        });
        test(`${lane}: a failed inventory on a scanned platform cannot rule out an ambiguous id`, async () => {
          const h = harness(platform, daemon);
          const error = new BootedDeviceDiscoveryIncompleteError("ios", {
            code: "failed",
            message: "inventory failed after discovery completed",
          });
          h.simctl.imageError = error;
          expect(
            await h.manager.ensureDeviceReady("either", h.id, h.options).catch((e: unknown) => e),
          ).toBe(error);
          h.assertNoBoot();
          expect(h.lifecycle.reservations).toEqual([]);
        });
        test(`${lane}: unknown image running state is discovery_incomplete`, async () => {
          const h = harness(platform, daemon);
          h.setImages([{ ...h.image, isRunningStateKnown: false }]);
          await expect(
            h.manager.ensureDeviceReady(platform, h.id, h.options),
          ).rejects.toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
          h.assertNoBoot();
          expect(h.lifecycle.reservations).toEqual([]);
        });
      } else {
        test(`${lane}: either named simulator boots when Android cannot be scanned`, async () => {
          const h = harness(platform, daemon);
          h.incomplete("android");
          h.devices.listDeviceImages = async () => {
            throw new Error("adb unavailable");
          };
          expect((await h.manager.ensureDeviceReady("either", h.id, h.options)).deviceId).toBe(
            h.device.deviceId,
          );
          expect(h.startCalls).toEqual([]);
          expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([{ udid: h.id }]);
          expect(h.simctl.getMethodCalls("createSimulator")).toEqual([]);
          h.assertNoReadWrites();
        });
        test(`${lane}: either unnamed read with Android unscanned gives the no-device answer`, async () => {
          const h = harness(platform, daemon);
          h.incomplete("android");
          await expect(h.manager.ensureDeviceReady("either", undefined, h.options)).rejects.toThrow(
            noDeviceMessage("either"),
          );
          h.assertEmptySelection();
        });
        test(`${lane}: an unscanned physical current device survives a read`, async () => {
          const h = harness(platform, daemon);
          const physical: BootedDevice = {
            platform: "ios",
            name: "Physical iPhone",
            deviceId: "00008110-001A2B3C4D5E001E",
          };
          h.setRunning([h.device]);
          h.scan.scannedSources = {
            android: true,
            "ios-simulator": true,
            "ios-physical": false,
          };
          h.manager.setCurrentDevice(physical, "ios");
          const verifiedIds: string[] = [];
          h.manager.verifyDevice = async (deviceId) => {
            verifiedIds.push(deviceId);
          };
          expect(await h.manager.ensureDeviceReady("ios", undefined, h.options)).toEqual(h.device);
          expect(h.manager.getCurrentDevice()).toEqual(physical);
          expect(h.manager.getCurrentPlatform()).toBe("ios");
          expect(verifiedIds).toEqual([h.device.deviceId]);
          h.assertNoBoot();
          expect(h.getConfig).not.toHaveBeenCalled();
          expect(h.apply).not.toHaveBeenCalled();
          expect(h.manager.getExplicitDevicePin()).toBeUndefined();
        });
        if (daemon) {
          test(`${lane}: an authoritative physical scan clears an absent current device`, async () => {
            const h = harness(platform, daemon);
            h.setRunning([h.device]);
            h.scan.scannedSources = {
              android: true,
              "ios-simulator": true,
              "ios-physical": true,
            };
            h.manager.setCurrentDevice(
              { platform: "ios", name: "Physical iPhone", deviceId: "00008110-001A2B3C4D5E001E" },
              "ios",
            );
            expect(await h.manager.ensureDeviceReady("ios", undefined, h.options)).toEqual(
              h.device,
            );
            h.assertNoBoot();
            h.assertNoReadWrites();
          });
        }
      }
    }
  }
});

for (const platform of ["android", "ios"] as const) {
  for (const refuses of [true, false]) {
    test(`${platform}: pre-read-boot callback ${refuses ? "refuses before lifecycle" : "admits the found image"}`, async () => {
      const h = harness(platform, true);
      const refusal = new ActionableError("late holder");
      const seen: DeviceInfo[] = [];
      const options = {
        ...h.options,
        beforeReadBoot: async (image: DeviceInfo) => {
          seen.push(image);
          if (refuses) {
            throw refusal;
          }
        },
      };
      const result = await h.manager
        .ensureDeviceReady(platform, h.id, options)
        .catch((error: unknown) => error);
      expect(seen).toEqual(refuses ? [h.image] : [h.image, h.image]);
      if (refuses) {
        expect(result).toBe(refusal);
        h.assertNoBoot();
        expect(h.lifecycle.reservations).toEqual([]);
      } else {
        expect(result).toMatchObject({ deviceId: h.device.deviceId });
        expect(h.startCalls.length + h.simctl.getMethodCalls("bootSimulator").length).toBe(1);
      }
      expect(h.lifecycle.isReserved({ kind: "stable", platform, stableId: h.id })).toBe(false);
      h.assertNoReadWrites();
    });
  }
}

for (const platform of ["android", "ios"] as const) {
  test(`${platform}: rechecks read ownership inside lifecycle lease and releases on refusal`, async () => {
    const h = harness(platform, true);
    const identity = { kind: "stable" as const, platform, stableId: h.id };
    const blocker = await h.lifecycle.reserve(identity, {
      operation: "start",
      deadlineMs: 300_000,
    });
    let calls = 0;
    const refused = new ActionableError("holder appeared during lease wait");
    const beforeReadBoot = mock(async () => {
      calls++;
      expect(h.lifecycle.isReserved(identity)).toBe(true);
      if (calls === 2) {
        throw refused;
      }
    });
    const outcome = h.manager
      .ensureDeviceReady(platform, h.id, { ...h.options, beforeReadBoot })
      .catch((error: unknown) => error);
    await drainUntil(() => h.lifecycle.reservations.length === 2, {
      description: "read waits for lease",
    });
    expect(calls).toBe(1);
    h.assertNoBoot();
    blocker.release();
    expect(await outcome).toBe(refused);
    expect(calls).toBe(2);
    h.assertNoBoot();
    expect(h.lifecycle.isReserved(identity)).toBe(false);
    expect(
      await h.manager.ensureDeviceReady(platform, h.id, {
        ...h.options,
        beforeReadBoot: async () => {},
      }),
    ).toMatchObject({ deviceId: h.device.deviceId });
    expect(h.lifecycle.isReserved(identity)).toBe(false);
    h.assertNoReadWrites();
  });
}
