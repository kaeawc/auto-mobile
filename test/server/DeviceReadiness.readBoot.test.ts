import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import {
  DeviceReadiness,
  type ConnectedPlatformScan,
  type DeviceReadyOptions,
} from "../../src/daemon/readiness/DeviceReadiness";
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
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeCtrlProxyManager } from "../fakes/FakeCtrlProxyManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeWindow } from "../fakes/FakeWindow";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { drainUntil, settleByFakeEvents } from "../helpers/fakeTimerStepping";

let restoreResume: (() => void) | undefined;
afterEach(() => {
  restoreResume?.();
  restoreResume = undefined;
});

class FakeReadSimctl extends FakeSimctl {
  readonly presentations: string[] = [];
  readonly imageSignals: AbortSignal[] = [];
  readonly imageCacheBypasses: boolean[] = [];
  imageError?: Error;
  imagesHang = false;
  async listSimulatorImages(
    _timeoutMs?: number,
    options?: { bypassCache?: boolean; signal?: AbortSignal },
  ): Promise<DeviceInfo[]> {
    const images = await super.listSimulatorImages();
    this.imageCacheBypasses.push(options?.bypassCache === true);
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
  const image: DeviceInfo =
    platform === "android"
      ? { name: device.name, platform, isRunning: false, isAvailable: true, source: "local" }
      : { ...device, isRunning: false, isAvailable: true };
  const firstImage: DeviceInfo = {
    ...image,
    name: "First image",
    ...(platform === "ios" ? { deviceId: "first-ios" } : {}),
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
  const manager = DeviceReadiness.createInstance(
    new FakeDeviceClientProvider(adb, devices, simctlAvailable ? simctl : undefined, {
      window,
      ctrlProxyManager: new FakeCtrlProxyManager(),
    }),
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
    scanned: { android: true, ios: simctlAvailable, watchos: false },
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
  const wait = devices.waitForDeviceReady.bind(devices);
  devices.waitForDeviceReady = (target, ...args) =>
    wait(
      { ...target, deviceId: target.name === device.name ? device.deviceId : "emulator-5554" },
      ...args,
    );
  const start = devices.startDevice.bind(devices);
  const startCalls: string[] = [];
  let startError: Error | undefined;
  devices.startDevice = async (target, timeout) => {
    startCalls.push(target.name);
    if (startError) {
      throw startError;
    }
    const result = await start(
      platform === "android"
        ? { ...target, deviceId: target.name === device.name ? device.deviceId : "emulator-5554" }
        : target,
      timeout,
    );
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
  function publishReadBoots(firstFailure?: Error) {
    let attempts = 0;
    const publish = () => {
      setImages([firstImage, { ...image, isRunning: true }]);
      setRunning([device]);
      // Keep the per-call daemon discovery stale: the lease recheck must bypass it.
      scan.devices = [];
    };
    const launchAndroid = devices.startDevice.bind(devices);
    devices.startDevice = async (target, timeout) => {
      if (++attempts === 1 && firstFailure) {
        startCalls.push(target.name);
        throw firstFailure;
      }
      const result = await launchAndroid(target, timeout);
      publish();
      return result;
    };
    const launchIos = simctl.bootSimulator.bind(simctl);
    simctl.bootSimulator = async (udid) => {
      const result = await launchIos(udid);
      if (++attempts === 1 && firstFailure) {
        throw firstFailure;
      }
      publish();
      return result;
    };
  }
  function assertNoBoot() {
    expect(startCalls).toEqual([]);
    expect(simctl.getMethodCalls("bootSimulator")).toEqual([]);
    expect(simctl.getMethodCalls("createSimulator")).toEqual([]);
    expect(instrumentation.requests).toEqual([]);
    expect(simctl.presentations).toEqual([]);
  }
  function assertNoReadWrites() {
    expect("getCurrentDevice" in manager).toBe(false);
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
    publishReadBoots,
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

async function expectStoppedIosRead(
  h: ReturnType<typeof harness>,
  requested: SomePlatform = "ios",
) {
  const error = await h.manager
    .ensureDeviceReady(requested, h.id, h.options)
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ActionableError);
  expect(error).toHaveProperty(
    "message",
    `iOS simulator '${h.device.name}' (${h.id}) is not booted; a read never boots a simulator. Call startDevice (or acquire a session) to boot it.`,
  );
  h.assertNoBoot();
  h.assertNoReadWrites();
}

describe("reads boot only explicitly named stopped Android images", () => {
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
            h.manager.setExplicitDevicePin(h.device);
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
      test(`${lane}: multiple running devices require an explicit target`, async () => {
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
        await expect(
          h.manager.ensureDeviceReady(platform, undefined, h.options),
        ).rejects.toMatchObject({ code: "ambiguous_device_target" });
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
        test(`${lane}: ${requested} named stopped image follows platform read policy`, async () => {
          const h = harness(platform, daemon);
          if (platform === "ios") {
            await expectStoppedIosRead(h, requested);
            expect(h.lifecycle.reservations).toEqual([]);
            return;
          }
          const result = await h.manager.ensureDeviceReady(requested, h.id, h.options);
          expect(result.deviceId).toBe(h.device.deviceId);
          expect(result.platform).toBe(platform);
          expect(h.startCalls).toEqual(platform === "android" ? [h.image.name] : []);
          expect(h.simctl.getMethodCalls("bootSimulator")).toEqual([]);
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
        if (platform === "ios") {
          h.setImages([h.image]);
        }
        const result = await (
          platform === "ios"
            ? h.manager.findOrStartDevice(platform, { ...h.options, intent: "control" })
            : h.manager.ensureDeviceReady(platform, h.id, h.options)
        ).catch((e: unknown) => e);
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
        h.manager.setExplicitDevicePin(h.device);
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
        test(`${lane}: ${invalid} named image keeps the platform-specific discovery answer`, async () => {
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
          await expect(
            h.manager.ensureDeviceReady(platform, h.id, h.options),
          ).rejects.toMatchObject(
            platform === "android" && invalid === "running"
              ? { code: "discovery_incomplete", retryable: true }
              : {
                  message: `Device ${h.id} not found on ${platform} platform. Available ${platform} devices: none`,
                },
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
        if (platform === "ios") {
          await expectStoppedIosRead(h, "either");
          return;
        }
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
        expect(result.deviceId).toBe(
          platform === "android" ? "emulator-5554" : h.firstImage.deviceId!,
        );
        expect(h.startCalls).toEqual(platform === "android" ? [h.firstImage.name] : []);
        expect(h.simctl.getMethodCalls("bootSimulator")).toEqual(
          platform === "ios" ? [{ udid: h.firstImage.deviceId }] : [],
        );
        expect(h.manager.getExplicitDevicePin()).toBeUndefined();
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
        test(`${lane}: either named stopped simulator refuses when Android cannot be scanned`, async () => {
          const h = harness(platform, daemon);
          h.incomplete("android");
          h.devices.listDeviceImages = async () => {
            throw new Error("adb unavailable");
          };
          await expectStoppedIosRead(h, "either");
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
          h.manager.setExplicitDevicePin(physical);
          const verifiedIds: string[] = [];
          h.manager.verifyDevice = async (deviceId) => {
            verifiedIds.push(deviceId);
          };
          expect(await h.manager.ensureDeviceReady("ios", undefined, h.options)).toEqual(h.device);
          expect(h.manager.getExplicitDevicePin()).toEqual(physical);
          expect(verifiedIds).toEqual([h.device.deviceId]);
          h.assertNoBoot();
          expect(h.getConfig).not.toHaveBeenCalled();
          expect(h.apply).not.toHaveBeenCalled();
          expect(h.manager.getExplicitDevicePin()).toEqual(physical);
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
            h.manager.setExplicitDevicePin({
              platform: "ios",
              name: "Physical iPhone",
              deviceId: "00008110-001A2B3C4D5E001E",
            });
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

for (const platform of ["android"] as const) {
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

for (const platform of ["android"] as const) {
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

test("Android running image without a resolved serial is retryable discovery, never a boot", async () => {
  const h = harness("android", true);
  h.setRunning([{ ...h.device, name: h.device.deviceId }]);
  h.setImages([{ ...h.image, isRunning: true }]);
  await expect(h.manager.ensureDeviceReady("android", h.id, h.options)).rejects.toMatchObject({
    code: "discovery_incomplete",
    retryable: true,
    message: `Android AVD '${h.image.name}' is running but its serial could not be resolved yet.`,
  });
  h.assertNoBoot();
  h.assertNoReadWrites();
  expect(h.lifecycle.reservations).toEqual([]);
});

for (const platform of ["android"] as const) {
  for (const daemon of [false, true]) {
    test(`${platform} ${daemon ? "daemon" : "direct"}: concurrent stopped reads launch once after lifecycle wait`, async () => {
      const h = harness(platform, daemon);
      h.publishReadBoots();
      const identity = { kind: "stable" as const, platform, stableId: h.id };
      const blocker = await h.lifecycle.reserve(identity, {
        operation: "start",
        deadlineMs: 300_000,
      });
      const beforeReadBoot = mock(async () => {});
      const options = { ...h.options, beforeReadBoot };
      const client = platform === "android" ? AndroidCtrlProxyClient : IOSCtrlProxyClient;
      const originalResume = client.resumeAfterDeviceStart;
      const events: string[] = [];
      const resume = spyOn(client, "resumeAfterDeviceStart").mockImplementation((deviceId) => {
        expect(deviceId).toBe(h.device.deviceId);
        events.push("resume");
      });
      restoreResume = () => {
        resume.mockRestore();
        expect(client.resumeAfterDeviceStart).toBe(originalResume);
      };
      const originalVerify = h.manager.verifyDevice.bind(h.manager);
      const verifyDevice = mock(async (...args: Parameters<typeof originalVerify>) => {
        events.push("verify");
        expect(events).toEqual(["resume", "resume", "verify"]);
        return await originalVerify(...args);
      });
      h.manager.verifyDevice = verifyDevice;
      const outcomes = Promise.all([
        h.manager.ensureDeviceReady(platform, h.id, options),
        h.manager.ensureDeviceReady(platform, h.id, options),
      ]);
      await drainUntil(() => h.lifecycle.reservations.length === 3, {
        description: "both stopped reads queue behind the lifecycle lease",
      });
      expect(beforeReadBoot).toHaveBeenCalledTimes(2);
      h.assertNoBoot();
      blocker.release();
      const results = await outcomes;
      expect(results.map((device) => device.deviceId)).toEqual([
        h.device.deviceId,
        h.device.deviceId,
      ]);
      expect(h.startCalls.length + h.simctl.getMethodCalls("bootSimulator").length).toBe(1);
      expect(h.instrumentation.requests).toEqual([]);
      expect(beforeReadBoot).toHaveBeenCalledTimes(4);
      expect(verifyDevice).toHaveBeenCalledTimes(1);
      expect(verifyDevice.mock.calls[0]).toEqual([
        h.device.deviceId,
        platform,
        expect.objectContaining({ ...options, signal: expect.any(AbortSignal) }),
        expect.objectContaining(h.device),
      ]);
      if (platform === "android") {
        expect(h.devices.getBootedDevicesDetailedCalls()).toHaveLength(2);
        expect(
          h.devices
            .getBootedDevicesDetailedCalls()
            .every(
              (call) =>
                call.options.bypassAndroidDeviceListCache === true &&
                call.options.signal !== undefined,
            ),
        ).toBe(true);
        expect(h.devices.getListDeviceImagesCalls()).toHaveLength(4);
      }
      expect(h.lifecycle.isReserved(identity)).toBe(false);
      h.assertNoReadWrites();
    });
  }

  test(`${platform}: concurrent loser boots after the first launch fails`, async () => {
    const h = harness(platform, true);
    const failure = new ActionableError("first fake launch failed");
    h.publishReadBoots(failure);
    const identity = { kind: "stable" as const, platform, stableId: h.id };
    const blocker = await h.lifecycle.reserve(identity, {
      operation: "start",
      deadlineMs: 300_000,
    });
    const outcomes = Promise.allSettled([
      h.manager.ensureDeviceReady(platform, h.id, h.options),
      h.manager.ensureDeviceReady(platform, h.id, h.options),
    ]);
    await drainUntil(() => h.lifecycle.reservations.length === 3, {
      description: "both reads queue before the failed boot",
    });
    blocker.release();
    expect(await outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: expect.objectContaining({ deviceId: h.device.deviceId }) },
    ]);
    expect(h.startCalls.length + h.simctl.getMethodCalls("bootSimulator").length).toBe(2);
    expect(h.lifecycle.isReserved(identity)).toBe(false);
    h.assertNoReadWrites();
  });

  test(`${platform}: concurrent loser ownership refusal wins over the running recheck`, async () => {
    const h = harness(platform, true);
    h.publishReadBoots();
    const identity = { kind: "stable" as const, platform, stableId: h.id };
    const blocker = await h.lifecycle.reserve(identity, {
      operation: "start",
      deadlineMs: 300_000,
    });
    const refusal = new ActionableError("holder appeared during the second read's lease wait");
    let loserChecks = 0;
    const outcomes = Promise.allSettled([
      h.manager.ensureDeviceReady(platform, h.id, h.options),
      h.manager.ensureDeviceReady(platform, h.id, {
        ...h.options,
        beforeReadBoot: async () => {
          if (++loserChecks === 2) {
            throw refusal;
          }
        },
      }),
    ]);
    await drainUntil(() => h.lifecycle.reservations.length === 3, {
      description: "both reads queue before ownership changes",
    });
    blocker.release();
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: expect.objectContaining({ deviceId: h.device.deviceId }) },
      { status: "rejected", reason: refusal },
    ]);
    expect(loserChecks).toBe(2);
    expect(h.startCalls.length + h.simctl.getMethodCalls("bootSimulator").length).toBe(1);
    expect(h.lifecycle.isReserved(identity)).toBe(false);
    h.assertNoReadWrites();
  });

  for (const abort of [false, true]) {
    test(`${platform}: concurrent loser releases the lease after running verification ${abort ? "aborts" : "fails"}`, async () => {
      const h = harness(platform, true);
      h.publishReadBoots();
      const identity = { kind: "stable" as const, platform, stableId: h.id };
      const blocker = await h.lifecycle.reserve(identity, {
        operation: "start",
        deadlineMs: 300_000,
      });
      const controller = new AbortController();
      const failure = new ActionableError("running loser verification refused");
      const verifyDevice = mock(
        async (_id: string, _platform: Platform, options?: DeviceReadyOptions) => {
          expect(h.lifecycle.isReserved(identity)).toBe(true);
          expect(options?.readiness).toBe("booted");
          if (abort) {
            controller.abort(failure);
            options?.signal?.throwIfAborted();
          }
          throw failure;
        },
      );
      h.manager.verifyDevice = verifyDevice;
      const outcomes = Promise.allSettled([
        h.manager.ensureDeviceReady(platform, h.id, h.options),
        h.manager.ensureDeviceReady(platform, h.id, { ...h.options, signal: controller.signal }),
      ]);
      await drainUntil(() => h.lifecycle.reservations.length === 3, {
        description: "both reads queue before loser verification",
      });
      blocker.release();
      expect(await outcomes).toEqual([
        { status: "fulfilled", value: expect.objectContaining({ deviceId: h.device.deviceId }) },
        { status: "rejected", reason: failure },
      ]);
      expect(verifyDevice).toHaveBeenCalledTimes(1);
      expect(h.startCalls.length + h.simctl.getMethodCalls("bootSimulator").length).toBe(1);
      expect(h.lifecycle.isReserved(identity)).toBe(false);
      h.assertNoReadWrites();
    });
  }
}

for (const state of ["unresolved serial", "unknown running state"] as const) {
  test(`android: concurrent loser reports discovery_incomplete for ${state}`, async () => {
    const h = harness("android", true);
    h.publishReadBoots();
    const identity = { kind: "stable" as const, platform: "android" as const, stableId: h.id };
    const blocker = await h.lifecycle.reserve(identity, {
      operation: "start",
      deadlineMs: 300_000,
    });
    let loserChecks = 0;
    const outcomes = Promise.allSettled([
      h.manager.ensureDeviceReady("android", h.id, h.options),
      h.manager.ensureDeviceReady("android", h.id, {
        ...h.options,
        beforeReadBoot: async () => {
          if (++loserChecks === 2) {
            h.setImages([
              {
                ...h.image,
                isRunning: state === "unresolved serial",
                isRunningStateKnown: state !== "unknown running state",
              },
            ]);
            h.setRunning([{ ...h.device, name: `Unknown (${h.device.deviceId})` }]);
            h.scan.devices = [];
          }
        },
      }),
    ]);
    await drainUntil(() => h.lifecycle.reservations.length === 3, {
      description: "both Android reads queue before discovery becomes incomplete",
    });
    blocker.release();
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: expect.objectContaining({ deviceId: h.device.deviceId }) },
      {
        status: "rejected",
        reason: expect.objectContaining({
          code: "discovery_incomplete",
          retryable: true,
          message:
            state === "unresolved serial"
              ? `Android AVD '${h.image.name}' is running but its serial could not be resolved yet.`
              : `Cannot safely cold-boot Android AVD '${h.image.name}': its running state is unknown.`,
        }),
      },
    ]);
    expect(h.startCalls).toEqual([h.image.name]);
    expect(h.lifecycle.isReserved(identity)).toBe(false);
    h.assertNoReadWrites();
  });
}

for (const daemon of [false, true]) {
  for (const platform of ["android", "ios"] as const) {
    const lane = `${platform} ${daemon ? "daemon" : "direct"}`;
    test(`${lane}: shaped absent read ignores failed other-platform discovery and inventory`, async () => {
      const h = harness(platform, daemon);
      const other = platform === "android" ? "ios" : "android";
      const id = platform === "android" ? "emulator-5599" : "87654321-ABCD-ABCD-ABCD-123456789ABC";
      h.incomplete(other);
      const otherImages = mock(async (): Promise<DeviceInfo[]> => {
        throw new Error("other inventory must not be read");
      });
      if (other === "ios") {
        h.simctl.listSimulatorImages = otherImages;
      } else {
        h.devices.listDeviceImages = otherImages;
      }
      await expect(h.manager.ensureDeviceReady("either", id, h.options)).rejects.toThrow(
        `Device ${id} not found on either platform`,
      );
      expect(otherImages).not.toHaveBeenCalled();
      h.assertNoBoot();
      h.assertNoReadWrites();
      expect(h.lifecycle.reservations).toEqual([]);
    });
    test(`${lane}: shaped image still requires healthy own-platform discovery`, async () => {
      const h = harness(platform, daemon);
      const id = platform === "android" ? "emulator-5599" : "87654321-ABCD-ABCD-ABCD-123456789ABC";
      h.incomplete(platform);
      await expect(h.manager.ensureDeviceReady("either", id, h.options)).rejects.toMatchObject({
        code: "discovery_incomplete",
        platform,
        retryable: true,
      });
      h.assertEmptySelection();
    });
  }
}

for (const platform of ["android"] as const) {
  for (const refused of [false, true]) {
    test(`${platform}: resolved running read checks ownership before resume and verify, refused=${refused}`, async () => {
      const h = harness(platform, true);
      const identity = { kind: "stable" as const, platform, stableId: h.id };
      const blocker = await h.lifecycle.reserve(identity, {
        operation: "start",
        deadlineMs: 300_000,
      });
      const client = platform === "android" ? AndroidCtrlProxyClient : IOSCtrlProxyClient;
      const events: string[] = [];
      const resume = spyOn(client, "resumeAfterDeviceStart").mockImplementation(() => {
        events.push("resume");
      });
      restoreResume = () => resume.mockRestore();
      const verify = mock(async () => {
        events.push("verify");
      });
      h.manager.verifyDevice = verify;
      const failure = new ActionableError("resolved target held");
      const beforeReadReadiness = mock(async (device: BootedDevice) => {
        expect(device).toMatchObject(h.device);
        expect(events).toEqual([]);
        expect(h.lifecycle.isReserved(identity)).toBe(true);
        events.push("ownership");
        if (refused) {
          throw failure;
        }
      });
      const outcome = h.manager
        .ensureDeviceReady(platform, h.id, { ...h.options, beforeReadReadiness })
        .then(
          (device) => device,
          (error: unknown) => error,
        );
      await drainUntil(() => h.lifecycle.reservations.length === 2, {
        description: "read lease queued",
      });
      h.setRunning([h.device]);
      h.setImages([{ ...h.image, isRunning: true }]);
      blocker.release();
      if (refused) {
        expect(await outcome).toBe(failure);
        expect(events).toEqual(["ownership"]);
        expect(verify).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
      } else {
        expect(await outcome).toMatchObject(h.device);
        expect(events).toEqual(["ownership", "resume", "verify"]);
      }
      expect(beforeReadReadiness).toHaveBeenCalledTimes(1);
      expect(h.lifecycle.isReserved(identity)).toBe(false);
      h.assertNoBoot();
      h.assertNoReadWrites();
    });
  }
}

test("Android cold read readiness refusal leaves the booted emulator running and releases its lease", async () => {
  const h = harness("android", true);
  const identity = { kind: "stable" as const, platform: "android" as const, stableId: h.id };
  const failure = new ActionableError("booted serial acquired");
  const resume = spyOn(AndroidCtrlProxyClient, "resumeAfterDeviceStart");
  restoreResume = () => resume.mockRestore();
  const verify = mock(async () => {});
  h.manager.verifyAndroidDevice = verify;
  const beforeReadReadiness = mock(async (device: BootedDevice) => {
    expect(device).toMatchObject(h.device);
    expect(h.lifecycle.isReserved(identity)).toBe(true);
    throw failure;
  });
  await expect(
    h.manager.ensureDeviceReady("android", h.id, { ...h.options, beforeReadReadiness }),
  ).rejects.toBe(failure);
  expect(h.startCalls).toEqual([h.id]);
  expect(resume).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  expect(
    h.devices.getExecutedOperations().filter((operation) => operation.startsWith("killDevice")),
  ).toEqual([]);
  expect(h.lifecycle.isReserved(identity)).toBe(false);
  h.assertNoReadWrites();
});

for (const platform of ["android", "ios"] as const) {
  for (const daemon of [false, true]) {
    test(`${platform} ${daemon ? "daemon" : "direct"}: shutdown then start leaves a running device for the queued read`, async () => {
      const h = harness(platform, daemon);
      const identity = { kind: "stable" as const, platform, stableId: h.id };
      const shutdown = await h.lifecycle.reserve(identity, {
        operation: "shutdown",
        deadlineMs: 300_000,
      });
      const startPending = h.lifecycle.reserve(identity, {
        operation: "start",
        deadlineMs: 300_000,
      });
      if (platform === "ios") {
        h.setRunning([h.device]);
        h.setImages([{ ...h.image, isRunning: true }]);
      }
      const outcome = h.manager.ensureDeviceReady(platform, h.id, h.options);
      await drainUntil(() => h.lifecycle.reservations.length === 3, {
        description: "start and read queued behind shutdown",
      });
      shutdown.release();
      const start = await startPending;
      h.setImages([{ ...h.image, isRunning: true }]);
      h.setRunning([h.device]);
      start.release();
      expect(await outcome).toMatchObject(h.device);
      h.assertNoBoot();
      expect(h.lifecycle.isReserved(identity)).toBe(false);
    });
    for (const stop of ["shutdown", "teardown"] as const) {
      test(`${platform} ${daemon ? "daemon" : "direct"}: read refuses boot ${platform === "ios" ? "before queueing behind" : "after waiting for"} ${stop}`, async () => {
        const h = harness(platform, daemon);
        const identity = { kind: "stable" as const, platform, stableId: h.id };
        const blocker = await h.lifecycle.reserve(identity, {
          operation: stop,
          deadlineMs: 300_000,
        });
        if (platform === "ios") {
          let settled = false;
          const outcome = expectStoppedIosRead(h).finally(() => {
            settled = true;
          });
          await drainUntil(() => settled || h.lifecycle.reservations.length === 2, {
            description: "iOS read rejects or incorrectly queues behind stop",
          });
          blocker.release();
          await outcome;
          expect(h.lifecycle.reservations).toHaveLength(1);
          expect(h.lifecycle.isReserved(identity)).toBe(false);
          return;
        }
        let settled = false;
        const outcome = h.manager.ensureDeviceReady(platform, h.id, h.options).then(
          (device) => {
            settled = true;
            return device;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        await drainUntil(
          () =>
            h.lifecycle.reservations.length === 2 &&
            h.lifecycle.timer.getPendingTimeoutCount() === 1,
          { description: "read queued behind stop" },
        );
        expect(settled).toBe(false);
        h.assertNoBoot();
        blocker.release();
        const error = await outcome;
        expect(error).toBeInstanceOf(ActionableError);
        expect(error).toHaveProperty(
          "message",
          `${platform} device '${h.device.name}': a shutdown or teardown ran while this read waited for it; a read does not boot it again. Call startDevice to boot it.`,
        );
        h.assertNoBoot();
        expect(h.lifecycle.isReserved(identity)).toBe(false);
      });
    }
    for (const control of (platform === "android"
      ? ["read-behind-start", "control-behind-shutdown"]
      : ["control-behind-shutdown"]) as readonly string[]) {
      test(`${platform} ${daemon ? "daemon" : "direct"}: ${control} still boots`, async () => {
        const h = harness(platform, daemon);
        const identity = { kind: "stable" as const, platform, stableId: h.id };
        const blocker = await h.lifecycle.reserve(identity, {
          operation: control === "read-behind-start" ? "start" : "shutdown",
          deadlineMs: 300_000,
        });
        h.setImages([h.image]);
        const outcome =
          control === "read-behind-start"
            ? h.manager.ensureDeviceReady(platform, h.id, h.options)
            : h.manager.findOrStartDevice(platform, { ...h.options, intent: "control" });
        await drainUntil(
          () =>
            h.lifecycle.reservations.length === 2 &&
            h.lifecycle.timer.getPendingTimeoutCount() === 1,
          { description: "control queued behind owner" },
        );
        h.assertNoBoot();
        blocker.release();
        expect(await outcome).toMatchObject({ deviceId: h.device.deviceId, platform });
        expect(h.startCalls).toEqual(platform === "android" ? [h.image.name] : []);
        expect(h.simctl.getMethodCalls("bootSimulator")).toEqual(
          platform === "ios" ? [{ udid: h.id }] : [],
        );
        expect(h.lifecycle.isReserved(identity)).toBe(false);
      });
    }
  }
}

for (const daemon of [false, true]) {
  for (const intent of ["read", "control"] as const) {
    test(`ios ${daemon ? "daemon" : "direct"}: ${intent} verifies boot state after waiting behind shutdown`, async () => {
      const h = harness("ios", daemon);
      h.setRunning([h.device]);
      h.setImages([{ ...h.image, isRunning: true }]);
      const identity = { kind: "stable" as const, platform: "ios" as const, stableId: h.id };
      const shutdown = await h.lifecycle.reserve(identity, {
        operation: "shutdown",
        deadlineMs: 300_000,
      });
      const outcome = h.manager.ensureDeviceReady("ios", h.id, { ...h.options, intent });
      await drainUntil(() => h.lifecycle.reservations.length === 2, {
        description: "running selection queued behind shutdown",
      });
      h.setRunning([]);
      h.setImages([h.image]);
      h.simctl.setDeviceInfo(h.id, {
        udid: h.id,
        name: h.device.name,
        state: "Shutdown",
        isAvailable: true,
      });
      shutdown.release();
      if (intent === "read") {
        const error = await outcome.catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ActionableError);
        expect(error).toHaveProperty(
          "message",
          `iOS simulator '${h.device.name}' (${h.id}) is not booted (state: Shutdown); a read never boots a simulator. Call startDevice (or acquire a session) to boot it.`,
        );
      } else {
        expect(await outcome).toEqual(h.device);
      }
      h.assertNoBoot();
      expect(h.lifecycle.isReserved(identity)).toBe(false);
    });
  }
}

for (const state of ["Shutdown", "Shutting Down"] as const) {
  for (const daemon of [false, true]) {
    test(`ios ${daemon ? "daemon" : "direct"}: plain ${state} read never boots`, async () => {
      const h = harness("ios", daemon);
      h.simctl.setDeviceInfo(h.id, {
        udid: h.id,
        name: h.device.name,
        state,
        isAvailable: true,
      });
      const beforeReadBoot = mock(async () => {});
      const error = await h.manager
        .ensureDeviceReady("ios", h.id, {
          ...h.options,
          beforeReadBoot,
        })
        .catch((error: unknown) => error);
      h.assertNoBoot();
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toHaveProperty(
        "message",
        `iOS simulator '${h.device.name}' (${h.id}) is not booted; a read never boots a simulator. Call startDevice (or acquire a session) to boot it.`,
      );
      expect(beforeReadBoot).not.toHaveBeenCalled();
      expect(h.lifecycle.reservations).toEqual([]);
      h.assertNoBoot();
      h.assertNoReadWrites();
    });
  }
}

for (const daemon of [false, true]) {
  test(`ios ${daemon ? "daemon" : "direct"}: findOrStart read refuses before reserving a boot lease`, async () => {
    const h = harness("ios", daemon);
    h.setImages([h.image]);
    const error = await h.manager
      .findOrStartDevice("ios", h.options)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error).toHaveProperty(
      "message",
      `iOS simulator '${h.device.name}' (${h.id}) is not booted; a read never boots a simulator. Call startDevice (or acquire a session) to boot it.`,
    );
    expect(h.lifecycle.reservations).toEqual([]);
    h.assertNoBoot();
    h.assertNoReadWrites();
  });
}
