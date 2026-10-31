import { CtrlProxyRunnerExitedDuringStartupError } from "../../src/ctrlProxy/ios/CtrlProxyRunnerExitedDuringStartupError";
import { CtrlProxyLaunchTimeoutError } from "../../src/ctrlProxy/ios/CtrlProxyLaunchTimeoutError";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { createExecResult } from "../../src/utils/execResult";
import { PortManager } from "../../src/utils/PortManager";
import { logger } from "../../src/utils/logger";
import type { Xcodebuild } from "../../src/utils/ios-cmdline-tools/XcodebuildClient";
import { DeviceAppManager } from "../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { SimctlCommandTimeoutError } from "../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import os from "os";
import {
  createFakeBuilder,
  createManagerWithFakeHealthClient,
  installIosManagerSuiteHooks,
  tunnel,
} from "../helpers/iosCtrlProxyManagerHarness";
import {
  fakeIosCtrlProxyBuilder,
  createStartableBuilder,
} from "../helpers/iosCtrlProxyBuilderFake";

type BundleHashLookupOptions = { signal?: AbortSignal; throwOnLookupTimeout?: boolean };

/** A DeviceAppManager whose installed-bundle hash lookup is scripted by the test. */
class ScriptedBundleHashDeviceAppManager extends DeviceAppManager {
  constructor(
    private readonly lookup: (options?: BundleHashLookupOptions) => Promise<string | null>,
  ) {
    super();
  }

  override async getInstalledAppBundleHash(
    _deviceUdid: string,
    _bundleId: string,
    _isSimulator = false,
    options?: BundleHashLookupOptions,
  ): Promise<string | null> {
    return this.lookup(options);
  }
}

const noInstalledBundle = (): DeviceAppManager =>
  new ScriptedBundleHashDeviceAppManager(async () => null);

describe("IOSCtrlProxyManager", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;

  installIosManagerSuiteHooks((ctx) => {
    testDevice = ctx.testDevice;
    fakeTimer = ctx.fakeTimer;
  });

  test("setup warns with the underlying failure while returning a retryable status", async function () {
    const manager = createManagerWithFakeHealthClient(testDevice, fakeTimer, {
      uninstallLegacyAppIfPresent: async () => {},
    });
    const checkRunning = spyOn(manager, "isRunning").mockRejectedValue(
      new Error("health probe unavailable"),
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await manager.setup();
      expect(result).toMatchObject({
        success: false,
        message: "Failed to setup CtrlProxy",
        error: "health probe unavailable",
      });
      expect(warn).toHaveBeenCalledWith("[IOSCtrlProxy] Setup failed: health probe unavailable");
      checkRunning.mockResolvedValue(true);
      expect((await manager.setup()).success).toBe(true);
    } finally {
      checkRunning.mockRestore();
      warn.mockRestore();
    }
  });

  test.each([
    [new CtrlProxyRunnerExitedDuringStartupError(), true],
    [new CtrlProxyLaunchTimeoutError("launch deadline"), true],
    [new Error("missing runner artifact"), false],
  ] as const)(
    "setup preserves typed startup retry eligibility for %s",
    async (failure, retryable) => {
      const manager = IOSCtrlProxyManager.createForTestingWithOptions({
        device: testDevice,
        timer: fakeTimer,
        builder: createFakeBuilder(),
        processExecutor: new FakeProcessExecutor(),
        steps: { uninstallLegacyAppIfPresent: async () => {} },
      });
      const running = spyOn(manager, "isRunning").mockResolvedValue(false);
      const start = spyOn(manager, "start").mockRejectedValue(failure);
      try {
        const result = await manager.setup();
        expect(result).toMatchObject({
          success: false,
          error: failure.message,
        });
        expect(result.retryableStartupFailure).toBe(retryable ? true : undefined);
      } finally {
        running.mockRestore();
        start.mockRestore();
      }
    },
  );

  describe("setup fail-closed on unverifiable pin", function () {
    test("returns failure for an unknown pin before any reuse short-circuit (#2746)", async function () {
      const prev = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "99.99.99";
      try {
        const manager = IOSCtrlProxyManager.getInstance(testDevice);
        const result = await manager.setup();
        expect(result.success).toBe(false);
        expect(result.message).toContain("not in the AutoMobile release");
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prev;
        }
      }
    });
  });

  describe("start fail-closed on unusable runner override (#4221)", function () {
    test("start() rejects before any launch work when the override is a directory", async function () {
      // A directory is the canonical unusable override (pointing at a derived-data
      // tree instead of the packaged .ipa). This must fail closed on EVERY launch
      // path, including a device pooled by discovery that never went through
      // verifyIosDevice/ensureCtrlProxyReady -- start()/startInternal() is that
      // single chokepoint, so the check lives there.
      const prev = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
      process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = os.tmpdir();
      try {
        const manager = IOSCtrlProxyManager.getInstance(testDevice);
        await expect(manager.start()).rejects.toThrow(/set but unusable/);
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
        } else {
          process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = prev;
        }
      }
    });
  });

  describe("getInstance", function () {
    test("should return same instance for same device", function () {
      const instance1 = IOSCtrlProxyManager.getInstance(testDevice);
      const instance2 = IOSCtrlProxyManager.getInstance(testDevice);

      expect(instance1).toBe(instance2);
    });

    test("should return different instances for different devices", function () {
      const device2: BootedDevice = {
        deviceId: "B2C3D4E5-F6A7-8901-BCDE-F12345678901",
        platform: "ios",
        name: "iPad Simulator",
      };

      const instance1 = IOSCtrlProxyManager.getInstance(testDevice);
      const instance2 = IOSCtrlProxyManager.getInstance(device2);

      expect(instance1).not.toBe(instance2);
    });
  });

  test("returns the persisted runner bundle identity from its builder", async function () {
    const builder = fakeIosCtrlProxyBuilder({
      getInstalledBundleVersion: async () => "2026.9.13",
    });
    const manager = IOSCtrlProxyManager.createForTesting(testDevice, fakeTimer, { builder });

    expect(await manager.getInstalledVersionIdentity()).toBe("2026.9.13");
  });

  describe("target bundle id resolution", function () {
    const ENV_KEY = "CTRL_PROXY_IOS_BUNDLE_ID";
    let prevEnv: string | undefined;

    beforeEach(function () {
      prevEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(function () {
      if (prevEnv === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = prevEnv;
      }
    });

    test("getTargetBundleId precedence: explicit > env var > undefined", function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      expect(manager.getTargetBundleId()).toBeUndefined();

      process.env[ENV_KEY] = "com.env.fallback";
      expect(manager.getTargetBundleId()).toBe("com.env.fallback");

      manager.setTargetBundleId("com.explicit.app");
      expect(manager.getTargetBundleId()).toBe("com.explicit.app");
    });

    test("getExistingTargetBundleId reads env without constructing a manager (no port reserved)", function () {
      // No instance exists for this device after resetInstances() in beforeEach.
      expect(IOSCtrlProxyManager.getExistingTargetBundleId(testDevice)).toBeUndefined();
      // Proof it didn't build a manager: no service port got reserved for the device.
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();

      process.env[ENV_KEY] = "com.env.fallback";
      expect(IOSCtrlProxyManager.getExistingTargetBundleId(testDevice)).toBe("com.env.fallback");
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
    });

    test("getExistingTargetBundleId returns an existing instance's explicit target (precedence over env)", function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      manager.setTargetBundleId("com.explicit.app");
      process.env[ENV_KEY] = "com.env.fallback";
      expect(IOSCtrlProxyManager.getExistingTargetBundleId(testDevice)).toBe("com.explicit.app");
    });
  });

  describe("getReportedRunnerPort", function () {
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function () {
      fakeExecutor = new FakeProcessExecutor();
    });

    // Map each candidate /health port to a body the runner would return.
    const installHealthFakes = (bodyByPort: Record<number, string>): void => {
      fakeExecutor.setCommandHandler("curl -s", (command) => {
        const port = Number(command.match(/127\.0\.0\.1:(\d+)\/health/)?.[1]);
        return createExecResult(bodyByPort[port] ?? "", "");
      });
    };

    test("returns the bound port the runner reports on the service port", async function () {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 8765 }),
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.getReportedRunnerPort()).toBe(8765);
    });

    test("discovers the runner on the default port when the service port is silent (#2731)", async function () {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 8765 }),
        // 8767 (service port) returns nothing — the runner bound the default instead.
      });
      // A non-default service port leaves 8765 as a distinct fallback candidate.
      PortManager.reserve(testDevice.deviceId, 8767);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.getReportedRunnerPort()).toBe(8765);
    });

    test("ignores a health response from a different device on a shared port", async function () {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: "SOME-OTHER-DEVICE", port: 8765 }),
      });
      // A non-default service port leaves 8765 as a distinct fallback candidate.
      PortManager.reserve(testDevice.deviceId, 8767);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    test("ignores a port reported without a matching device id (false-adoption guard)", async function () {
      // The #2731 env-propagation failure that drops the port var can also drop
      // the runner's device-id var, so a sibling simulator's runner on the shared
      // default port could answer with a port but no device id. It must not be
      // adopted as ours.
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", port: 8765 }),
      });
      // A non-default service port leaves 8765 as a distinct fallback candidate.
      PortManager.reserve(testDevice.deviceId, 8767);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    test("ignores an out-of-range reported port", async function () {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 70000 }),
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    test("returns null when the runner reports no port (older runner)", async function () {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }),
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    test("returns null when no runner answers the health endpoint", async function () {
      installHealthFakes({});
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    // PARAM-2 (#4177 item 8): the #2731 service-port-beats-default ordering had
    // no test with BOTH candidate ports answering. The service port is probed
    // first, so when both a runner on the service port and one on the default
    // port answer validly for this device, the service port's report wins.
    test("prefers the service port over the default when BOTH answer for this device (#2731)", async function () {
      installHealthFakes({
        8767: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 8767 }),
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 8765 }),
      });
      // A non-default service port leaves 8765 as a distinct fallback candidate.
      PortManager.reserve(testDevice.deviceId, 8767);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.getReportedRunnerPort()).toBe(8767);
    });

    // PARAM-2: a truncated/non-JSON health body can't confirm the device, so the
    // reported port must be nulled rather than partially parsed.
    test("returns null when the health body is truncated JSON", async function () {
      installHealthFakes({
        8765: `{"status":"ok","deviceId":"${testDevice.deviceId}","port":87`,
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });
  });

  // #6415: checkHealthEndpoint() (the gate behind isRunning()/start()'s
  // short-circuit/waitForHealthEndpoint/checkCtrlProxyProcessLiveness) must reject a
  // foreign responder on the service port rather than treating any "ok"/"healthy"
  // body as proof this device's runner is up.
  describe("device-identity gate on the health probe (#6415)", function () {
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function () {
      fakeExecutor = new FakeProcessExecutor();
    });

    const installHealthBody = (body: string): void => {
      fakeExecutor.setCommandHandler("curl -s", () => createExecResult(body, ""));
    };

    test("isRunning() is false when the service port answers for a different device", async function () {
      installHealthBody(JSON.stringify({ status: "ok", deviceId: "OTHER-UDID", port: 8765 }));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.isRunning()).toBe(false);
    });

    test("isRunning() is true when the service port answers with this device's id", async function () {
      installHealthBody(
        JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 8765 }),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.isRunning()).toBe(true);
    });

    test("isRunning() is false when the responder omits device identity", async function () {
      installHealthBody(JSON.stringify({ status: "ok", port: 8765 }));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.isRunning()).toBe(false);
    });

    test("checkRunningWithReason() rejects a responder that omits device identity", async function () {
      installHealthBody('{"status":"ok"}');
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.checkRunningWithReason()).toEqual({ ok: false, reason: "unhealthy" });
      expect(await manager.isRunning()).toBe(false);
    });

    test("isRunning() is false for the Android runner's plain-text 'OK' body reached via the same port", async function () {
      installHealthBody("OK");
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.isRunning()).toBe(false);
    });

    test("start() does not short-circuit on a foreign responder; it proceeds to spawn its own runner", async function () {
      // Foreign runner answers the service port for a different device. No
      // xcodebuild/CtrlProxy process is discoverable (pgrep empty), so once the
      // loose short-circuit is gone, start() must fall through to spawning its
      // own runner rather than returning early as "already running".
      installHealthBody(JSON.stringify({ status: "ok", deviceId: "OTHER-UDID", port: 8765 }));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("", ""));
      const fakeBuilder = createStartableBuilder("/tmp/CtrlProxy.xctestrun");
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: fakeBuilder,
        processExecutor: fakeExecutor,
      });
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      // Proof it did NOT short-circuit on the foreign "already running" result:
      // it actually attempted to spawn a runner of its own.
      expect(fakeExecutor.getSpawnedProcesses().length).toBeGreaterThan(0);
    });
  });

  describe("getCapabilities", function () {
    test("should identify simulator device type for UUID format deviceId", async function () {
      const manager = IOSCtrlProxyManager.createForTesting(testDevice, fakeTimer);
      const capabilities = await manager.getCapabilities();

      expect(capabilities.deviceType).toBe("simulator");
      expect(capabilities.supportsXCTest).toBe(true);
    });

    test("should identify physical device type for non-UUID format deviceId", async function () {
      const physicalDevice: BootedDevice = {
        deviceId: "00008030001E28C11E", // Physical device serial number format
        platform: "ios",
        name: "iPhone",
      };

      const manager = IOSCtrlProxyManager.createForTesting(physicalDevice, fakeTimer);
      const capabilities = await manager.getCapabilities();

      expect(capabilities.deviceType).toBe("physical");
      expect(capabilities.supportsXCTest).toBe(true);
    });
  });

  // REWRITE-2 (#4177 item 6): the old "should not throw" tests passed even with
  // the method bodies deleted. `isRunning` caches its health result for
  // STATUS_CACHE_TTL, so a stale cached `false` is served until the cache is
  // cleared. These assert the observable re-probe: only after clearing does a
  // now-healthy endpoint flip the cached answer.
  describe("clearCaches", function () {
    test("forces isRunning to re-probe the health endpoint after clearing", async function () {
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = false;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.isRunning()).toBe(false); // probes, caches false
      healthy = true;
      expect(await manager.isRunning()).toBe(false); // cached false is served
      manager.clearCaches();
      expect(await manager.isRunning()).toBe(true); // cache cleared → re-probe
    });

    test("drops a cached positive availability so a now-down runner is re-probed", async function () {
      // isAvailable() delegates directly to isRunning() (#6416 — it no longer
      // layers its own hour-long cache on top), so this pins that clearCaches()
      // still drops the underlying cachedRunning positive: deleting
      // `this.cachedRunning = null` from clearCaches leaves the stale positive
      // and reds the final assertion. cachedInstalled has no such test here
      // because for a simulator device isInstalled is unconditionally true —
      // clearing it is unobservable.
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = true;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.isAvailable()).toBe(true); // installed(true)+running(true) → running cached positive
      healthy = false;
      expect(await manager.isAvailable()).toBe(true); // running's own STATUS_CACHE_TTL cache is served (stale)
      manager.clearCaches();
      expect(await manager.isAvailable()).toBe(false); // caches dropped → re-probes the down runner
    });
  });

  describe("resetSetupState", function () {
    test("clears the running cache so isRunning re-probes", async function () {
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = false;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      expect(await manager.isRunning()).toBe(false);
      healthy = true;
      expect(await manager.isRunning()).toBe(false);
      manager.resetSetupState();
      expect(await manager.isRunning()).toBe(true);
    });

    test("allows setup to launch again after a completed setup attempt", async function () {
      const fakeExecutor = new FakeProcessExecutor();
      let runnerHealthy = false;
      let launchCount = 0;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          runnerHealthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      fakeExecutor.setCommandHandler("kill -0", () => {
        throw new Error("runner is no longer running");
      });

      const fakeDeviceAppManager = noInstalledBundle();
      const xcodebuild: Xcodebuild = {
        executeCommand: async () => createExecResult("", ""),
        isAvailable: async () => true,
        startStreaming: async () => {
          launchCount++;
          runnerHealthy = true;
          return new FakeChildProcess();
        },
      };
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: createFakeBuilder(),
        processExecutor: fakeExecutor,
        signingManager: undefined,
        deviceAppManager: fakeDeviceAppManager,
        remoteRunner: undefined,
        hostPortAvailabilityChecker: undefined,
        xcodebuild,
      });
      fakeTimer.enableAutoAdvance();

      expect((await manager.setup()).success).toBe(true);
      expect(launchCount).toBe(1);

      runnerHealthy = false;
      manager.resetSetupState();

      expect((await manager.setup()).success).toBe(true);
      expect(launchCount).toBe(2);
    });
  });

  // #6575: the legacy-app uninstall probe used to run on every setup() call,
  // including the attemptedSetup fast path that exists to make repeat calls
  // cheap. It should fire at most once per manager instance.
  describe("legacy-app uninstall probe runs at most once per manager (#6575)", function () {
    test("does not re-probe on a setup() call that hits the attemptedSetup fast path", async function () {
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = false;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      let legacyProbeCount = 0;
      const fakeDeviceAppManager = new ScriptedBundleHashDeviceAppManager(async () => {
        legacyProbeCount++;
        return null;
      });
      const xcodebuild: Xcodebuild = {
        executeCommand: async () => createExecResult("", ""),
        isAvailable: async () => true,
        startStreaming: async () => {
          healthy = true;
          return new FakeChildProcess();
        },
      };
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: createFakeBuilder(),
        processExecutor: fakeExecutor,
        signingManager: undefined,
        deviceAppManager: fakeDeviceAppManager,
        remoteRunner: undefined,
        hostPortAvailabilityChecker: undefined,
        xcodebuild,
      });
      fakeTimer.enableAutoAdvance();

      const first = await manager.setup();
      expect(first.success).toBe(true);
      expect(legacyProbeCount).toBe(1);

      // Second call hits the `attemptedSetup && !force` fast path.
      const second = await manager.setup();
      expect(second.success).toBe(true);
      expect(legacyProbeCount).toBe(1);
    });

    test("keeps the lifetime guard latched across setup resets", async function () {
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = false;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      fakeExecutor.setCommandHandler("kill -0", () => {
        throw new Error("runner is no longer running");
      });
      let legacyProbeCount = 0;
      const fakeDeviceAppManager = new ScriptedBundleHashDeviceAppManager(async () => {
        legacyProbeCount++;
        return null;
      });
      const xcodebuild: Xcodebuild = {
        executeCommand: async () => createExecResult("", ""),
        isAvailable: async () => true,
        startStreaming: async () => {
          healthy = true;
          return new FakeChildProcess();
        },
      };
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: createFakeBuilder(),
        processExecutor: fakeExecutor,
        signingManager: undefined,
        deviceAppManager: fakeDeviceAppManager,
        remoteRunner: undefined,
        hostPortAvailabilityChecker: undefined,
        xcodebuild,
      });
      fakeTimer.enableAutoAdvance();

      expect((await manager.setup()).success).toBe(true);
      expect(legacyProbeCount).toBe(1);

      healthy = false;
      manager.resetSetupState();

      expect((await manager.setup()).success).toBe(true);
      expect(legacyProbeCount).toBe(1);
    });
  });

  describe("legacy-app probe treats a timed-out lookup as unknown, not absent", () => {
    function setupWithLegacyLookup(lookup: (callNumber: number) => Promise<string | null>) {
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = false;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      fakeExecutor.setCommandHandler("kill -0", () => {
        throw new Error("runner is no longer running");
      });
      const lookupOptions: unknown[] = [];
      const fakeDeviceAppManager = new ScriptedBundleHashDeviceAppManager(async (options) => {
        lookupOptions.push(options);
        return lookup(lookupOptions.length);
      });
      const xcodebuild: Xcodebuild = {
        executeCommand: async () => createExecResult("", ""),
        isAvailable: async () => true,
        startStreaming: async () => {
          healthy = true;
          return new FakeChildProcess();
        },
      };
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: createFakeBuilder(),
        processExecutor: fakeExecutor,
        signingManager: undefined,
        deviceAppManager: fakeDeviceAppManager,
        remoteRunner: undefined,
        hostPortAvailabilityChecker: undefined,
        xcodebuild,
      });
      fakeTimer.enableAutoAdvance();
      return {
        manager,
        lookupOptions,
        stop: () => {
          healthy = false;
        },
      };
    }

    test("a get_app_container timeout is re-checked on the next setup", async function () {
      const { manager, lookupOptions, stop } = setupWithLegacyLookup(async (callNumber) => {
        if (callNumber === 1) {
          throw new SimctlCommandTimeoutError("get_app_container timed out");
        }
        return null;
      });

      expect((await manager.setup()).success).toBe(true);
      expect(lookupOptions).toHaveLength(1);
      expect(lookupOptions[0]).toEqual({ throwOnLookupTimeout: true });

      stop();
      manager.resetSetupState();
      expect((await manager.setup()).success).toBe(true);
      expect(lookupOptions).toHaveLength(2);

      // The second lookup answered "absent", which is recorded: no third probe.
      stop();
      manager.resetSetupState();
      expect((await manager.setup()).success).toBe(true);
      expect(lookupOptions).toHaveLength(2);
    });

    test("a plain absent answer is still recorded and never re-probed", async function () {
      const { manager, lookupOptions, stop } = setupWithLegacyLookup(async () => null);

      expect((await manager.setup()).success).toBe(true);
      stop();
      manager.resetSetupState();
      expect((await manager.setup()).success).toBe(true);

      expect(lookupOptions).toHaveLength(1);
    });
  });

  // #6416: `isAvailable()` used to serve a positive answer from a 1-hour
  // `cachedAvailability` layer that `setup()`'s already-attempted gate
  // consults. A runner that dies without a local child-exit event (killed
  // externally, simulator erased, wedged-but-still-answering /health) is
  // never re-probed until that hour elapses, so `setup()` keeps reporting
  // "CtrlProxy was already running" against a dead runner. The fix removes
  // that layer so the gate relies on `isRunning()`'s own 30s STATUS_CACHE_TTL.
  describe("setup gate re-probes after STATUS_CACHE_TTL (#6416)", function () {
    test("setup() re-probes and does not report success once the runner stops answering, even under an hour", async function () {
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = true;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: fakeIosCtrlProxyBuilder({
          ...createFakeBuilder(),
          needsRebuild: async () => true,
          build: async () => ({ success: false, message: "fake rebuild unavailable" }),
        }),
        processExecutor: fakeExecutor,
        signingManager: undefined,
        deviceAppManager: noInstalledBundle(),
      });

      // First pass through the gate: attemptedSetup becomes true and the
      // runner is genuinely up.
      const first = await manager.setup();
      expect(first.success).toBe(true);

      // Second pass: attemptedSetup is now true, so this call goes through
      // the isAvailable() gate and (pre-fix) populates cachedAvailability
      // with a positive result.
      const second = await manager.setup();
      expect(second.success).toBe(true);

      // The runner goes away without a local child-exit event. Advance past
      // the 30s STATUS_CACHE_TTL (but nowhere near the old 1-hour window) so
      // isRunning() is willing to re-probe.
      healthy = false;
      fakeTimer.advanceTime(31 * 1000);

      const third = await manager.setup();
      expect(third.success).toBe(false);
      expect(third.message).not.toBe("CtrlProxy was already running");
    });

    test("setup() still does not report success after a full hour, pinning that the fix does not depend on the old TTL value", async function () {
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = true;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: fakeIosCtrlProxyBuilder({
          ...createFakeBuilder(),
          needsRebuild: async () => true,
          build: async () => ({ success: false, message: "fake rebuild unavailable" }),
        }),
        processExecutor: fakeExecutor,
        signingManager: undefined,
        deviceAppManager: noInstalledBundle(),
      });

      expect((await manager.setup()).success).toBe(true);
      expect((await manager.setup()).success).toBe(true);

      healthy = false;
      fakeTimer.advanceTime(60 * 60 * 1000 + 1000);

      const result = await manager.setup();
      expect(result.success).toBe(false);
      expect(result.message).not.toBe("CtrlProxy was already running");
    });

    test("the fast path still short-circuits when the runner really is up", async function () {
      const fakeExecutor = new FakeProcessExecutor();
      const healthy = true;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: fakeIosCtrlProxyBuilder({
          ...createFakeBuilder(),
          needsRebuild: async () => true,
          build: async () => ({ success: false, message: "fake rebuild unavailable" }),
        }),
        processExecutor: fakeExecutor,
        signingManager: undefined,
        deviceAppManager: noInstalledBundle(),
      });

      expect((await manager.setup()).success).toBe(true);
      expect((await manager.setup()).success).toBe(true);

      fakeTimer.advanceTime(31 * 1000);

      const result = await manager.setup();
      expect(result.success).toBe(true);
      expect(result.message).toBe("CtrlProxy was already running");
    });
  });

  describe("iproxy tunnel", function () {
    let physicalDevice: BootedDevice;
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function () {
      physicalDevice = {
        deviceId: "00008030001E28C11E",
        platform: "ios",
        name: "iPhone",
      };
      fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandResponse(
        "idevice_id -l",
        createExecResult(`${physicalDevice.deviceId}\n`, ""),
      );
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
    });

    test("starts iproxy for physical devices with device-specific port", async function () {
      const fakeProcess = new FakeChildProcess();
      fakeExecutor.setNextSpawnProcess(fakeProcess);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: physicalDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      await manager.startIproxyTunnel();

      const spawns = fakeExecutor.getSpawnedProcesses();
      expect(spawns.length).toBe(1);
      expect(spawns[0].command).toBe("iproxy");
      expect(spawns[0].args).toEqual([
        String(manager.getServicePort()),
        String(manager.getServicePort()),
        physicalDevice.deviceId,
      ]);
    });

    test("escalates a local iproxy that ignores graceful shutdown before clearing ownership", async function () {
      const fakeProcess = new FakeChildProcess();
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      spyOn(fakeProcess, "kill").mockImplementation((signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          fakeProcess.exitCode = null;
          fakeProcess.emit("exit", null, "SIGKILL");
        }
        return true;
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: physicalDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });
      tunnel(manager).setStateForTesting({ processId: fakeProcess.pid });
      tunnel(manager).setStateForTesting({ process: fakeProcess });

      fakeTimer.enableAutoAdvance();
      await tunnel(manager).stop();

      expect(signals).toEqual([undefined, "SIGKILL"]);
      expect(tunnel(manager).diagnostics.processId).toBeNull();
    });

    test("restarts iproxy after unexpected exit", async function () {
      const fakeProcess = new FakeChildProcess();
      fakeExecutor.setNextSpawnProcess(fakeProcess);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: physicalDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });

      await manager.startIproxyTunnel();

      fakeProcess.emit("exit", 1, null);
      await Promise.resolve();
      fakeTimer.advanceTime(1000);
      await Promise.resolve();

      expect(fakeExecutor.getSpawnedProcesses().length).toBe(2);
    });

    test("ignores stale local iproxy exit or error after a newer tunnel is tracked", async function () {
      for (const staleEvent of ["exit", "error"] as const) {
        const eventTimer = new FakeTimer();
        const eventExecutor = new FakeProcessExecutor();
        eventExecutor.setCommandResponse(
          "idevice_id -l",
          createExecResult(`${physicalDevice.deviceId}\n`, ""),
        );
        eventExecutor.setCommandResponse("curl -s", createExecResult("", ""));
        const oldProcess = new FakeChildProcess();
        oldProcess.pid = 1111;
        const newProcess = new FakeChildProcess();
        newProcess.pid = 2222;
        eventExecutor.setNextSpawnProcess(oldProcess);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps({
          device: physicalDevice,
          timer: eventTimer,
          builder: undefined,
          processExecutor: eventExecutor,
        });

        await manager.startIproxyTunnel();
        await tunnel(manager).stop();
        eventExecutor.setNextSpawnProcess(newProcess);
        await manager.startIproxyTunnel();

        if (staleEvent === "exit") {
          oldProcess.emit("exit", 0, null);
        } else {
          oldProcess.emit("error", new Error("old tunnel failed after replacement"));
        }
        for (let i = 0; i < 5; i++) {
          await Promise.resolve();
        }

        expect(tunnel(manager).diagnostics.processId).toBe(2222);
        expect(tunnel(manager).diagnostics.process).toBe(newProcess);
        expect(eventTimer.getPendingTimeoutCount()).toBe(0);
        expect(eventExecutor.getSpawnedProcesses().length).toBe(2);
      }
    });
  });
});
