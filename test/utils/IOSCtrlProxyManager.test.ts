import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
  IOSCtrlProxyManager,
  STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS,
  MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES,
} from "../../src/utils/IOSCtrlProxyManager";
import { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { createExecResult } from "../../src/utils/execResult";
import { PortManager } from "../../src/utils/PortManager";
import { IOSCtrlProxyBuilder } from "../../src/utils/IOSCtrlProxyBuilder";
import { IOSCtrlProxyProcessClient } from "../../src/utils/ios/IOSCtrlProxyProcessClient";
import { logger } from "../../src/utils/logger";
import type { Xcodebuild } from "../../src/utils/ios-cmdline-tools/XcodebuildClient";
import type { DeviceAppManager } from "../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { parsePlist } from "../../src/utils/ios-cmdline-tools/XctestrunPlist";
import type { XcodeSigningManager } from "../../src/utils/ios-cmdline-tools/XcodeSigning";
import * as fs from "fs/promises";
import * as path from "path";
import os from "os";

interface FakeListeningProcess {
  pid: number;
  port: number;
  command: string;
  alive: boolean;
  ppid?: number;
  pgid?: number;
  environment?: string;
  ignoreTerm?: boolean;
  ignoreKill?: boolean;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * A minimal format-version-1 xctestrun with a single UI-test bundle, used by the
 * boundary test to model what the in-simulator runner actually reads.
 */
const BOUNDARY_XCTESTRUN = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
  "<plist version=\"1.0\">",
  "<dict>",
  "\t<key>CtrlProxyUITests</key>",
  "\t<dict>",
  "\t\t<key>EnvironmentVariables</key>",
  "\t\t<dict>",
  "\t\t\t<key>TERM</key>",
  "\t\t\t<string>dumb</string>",
  "\t\t</dict>",
  "\t\t<key>IsUITestBundle</key>",
  "\t\t<true/>",
  "\t</dict>",
  "</dict>",
  "</plist>"
].join("\n");

/**
 * Default fake for IOSCtrlProxyBuilder.writeRunnerEnvironment: returns a
 * deterministic per-launch xctestrun path (in the source's directory, without a
 * platform token) so the manager's spawn path can run without touching disk.
 */
async function fakeWriteRunnerEnvironment(
  xctestrunPath: string,
  _env: Record<string, string>,
  deviceId: string
): Promise<string> {
  const dir = xctestrunPath.includes("/") ? xctestrunPath.slice(0, xctestrunPath.lastIndexOf("/")) : ".";
  const safeDeviceId = deviceId.replace(/[^A-Za-z0-9._-]/g, "_") || "device";
  return `${dir}/automobile-runner-${safeDeviceId}.xctestrun`;
}

function installListeningProcessFakes(
  fakeExecutor: FakeProcessExecutor,
  processes: FakeListeningProcess[]
): void {
  const markProcessDead = (pid: number, signal: "TERM" | "KILL") => {
    const process = processes.find(candidate => candidate.pid === pid);
    if (process && !(signal === "TERM" ? process.ignoreTerm : process.ignoreKill)) {
      process.alive = false;
    }
  };

  fakeExecutor.setCommandHandler("lsof -nP -iTCP:", command => {
    const port = Number(command.match(/-iTCP:(\d+)/)?.[1]);
    const stdout = processes
      .filter(process => process.alive && process.port === port)
      .map(process => `p${process.pid}`)
      .join("\n");
    return createExecResult(stdout, "");
  });
  fakeExecutor.setCommandHandler("ps -p", command => {
    const pid = Number(command.match(/ps -p\s+(\d+)/)?.[1]);
    const process = processes.find(candidate => candidate.pid === pid && candidate.alive);
    return createExecResult(
      process ? `${process.ppid ?? 1} ${process.command}` : "",
      ""
    );
  });
  fakeExecutor.setCommandHandler("ps eww -p", command => {
    const pid = Number(command.match(/ps eww -p\s+(\d+)/)?.[1]);
    const process = processes.find(candidate => candidate.pid === pid && candidate.alive);
    return createExecResult(
      process ? `${process.command} ${process.environment ?? ""}`.trim() : "",
      ""
    );
  });
  fakeExecutor.setCommandHandler("ps -axo pid=,ppid=", () =>
    createExecResult(
      processes
        .filter(process => process.alive)
        .map(process => `${process.pid} ${process.ppid ?? 1}`)
        .join("\n"),
      ""
    )
  );
  fakeExecutor.setCommandHandler("kill -TERM", command => {
    const groupPid = Number(command.match(/kill -TERM -- -(\d+)/)?.[1]);
    if (!Number.isNaN(groupPid)) {
      for (const process of processes.filter(candidate => candidate.alive && (candidate.pgid ?? candidate.pid) === groupPid)) {
        markProcessDead(process.pid, "TERM");
      }
      return createExecResult("", "");
    }
    const pid = Number(command.match(/kill -TERM\s+(\d+)/)?.[1]);
    markProcessDead(pid, "TERM");
    return createExecResult("", "");
  });
  fakeExecutor.setCommandHandler("kill -KILL", command => {
    const groupPid = Number(command.match(/kill -KILL -- -(\d+)/)?.[1]);
    if (!Number.isNaN(groupPid)) {
      for (const process of processes.filter(candidate => candidate.alive && (candidate.pgid ?? candidate.pid) === groupPid)) {
        markProcessDead(process.pid, "KILL");
      }
      return createExecResult("", "");
    }
    const pid = Number(command.match(/kill -KILL\s+(\d+)/)?.[1]);
    markProcessDead(pid, "KILL");
    return createExecResult("", "");
  });
  fakeExecutor.setCommandHandler("kill -0", command => {
    const pid = Number(command.match(/kill -0\s+(\d+)/)?.[1]);
    const process = processes.find(candidate => candidate.pid === pid && candidate.alive);
    if (!process) {
      throw new Error(`process ${pid} is not running`);
    }
    return createExecResult("", "");
  });
}

function createFakeBuilder(xctestrunPath = "/tmp/CtrlProxy.xctestrun") {
  return {
    getXctestrunPath: async () => xctestrunPath,
    getRunnerBinaryPath: async () => null,
    // Pre-launch TOCTOU re-verify seam (#4759); a no-op in the default fake.
    verifyRunnerBinaryBeforeLaunch: async () => {},
    writeRunnerEnvironment: fakeWriteRunnerEnvironment,
    needsRebuild: async () => false,
    build: async () => ({ success: true, message: "built" }),
    getExpectedAppHash: () => null,
  } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
}

describe("IOSCtrlProxyManager", function() {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  let prevHealthMaxAttempts: string | undefined;

  beforeEach(function() {
    fakeTimer = new FakeTimer();

    // Create test device (iOS simulator format - UUID)
    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator"
    };

    // Cap the health-poll budget suite-wide. The timeout-path tests
    // (`enableAutoAdvance()` + `start()` rejects "failed to start within timeout")
    // run the FULL health-poll loop, and each iteration's `timer.sleep(500)`
    // resolves via a real `setImmediate` under auto-advance — so the loop costs
    // one real event-loop tick per attempt. At the default 60 attempts that is 60
    // real ticks whose wall-clock scales with event-loop load, which intermittently
    // blew past bun's 5000ms per-test timeout in the full suite (a real macOS-CI
    // flake, e.g. "ignores xcodebuild CtrlProxy processes for other simulators").
    // A tiny budget proves the same timeout/spawn behavior deterministically and
    // fast. Tests that need a specific budget still override this locally
    // (`withHealthBudget` / the resolver parsing test) and restore to this value.
    prevHealthMaxAttempts = process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = "3";

    // Reset singleton instances
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });

  afterEach(function() {
    fakeTimer.reset();
    if (prevHealthMaxAttempts === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = prevHealthMaxAttempts;
    }
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  describe("setup fail-closed on unverifiable pin", function() {
    test("returns failure for an unknown pin before any reuse short-circuit (#2746)", async function() {
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

  describe("start fail-closed on unusable runner override (#4221)", function() {
    test("start() rejects before any launch work when the override is a directory", async function() {
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

  describe("getInstance", function() {
    test("should return same instance for same device", function() {
      const instance1 = IOSCtrlProxyManager.getInstance(testDevice);
      const instance2 = IOSCtrlProxyManager.getInstance(testDevice);

      expect(instance1).toBe(instance2);
    });

    test("should return different instances for different devices", function() {
      const device2: BootedDevice = {
        deviceId: "B2C3D4E5-F6A7-8901-BCDE-F12345678901",
        platform: "ios",
        name: "iPad Simulator"
      };

      const instance1 = IOSCtrlProxyManager.getInstance(testDevice);
      const instance2 = IOSCtrlProxyManager.getInstance(device2);

      expect(instance1).not.toBe(instance2);
    });
  });

  describe("getServicePort", function() {
    test("should return default port 8765", function() {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      expect(manager.getServicePort()).toBe(8765);
    });
  });

  describe("target bundle id resolution", function() {
    const ENV_KEY = "CTRL_PROXY_IOS_BUNDLE_ID";
    let prevEnv: string | undefined;

    beforeEach(function() {
      prevEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(function() {
      if (prevEnv === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = prevEnv;
      }
    });

    test("getTargetBundleId precedence: explicit > env var > undefined", function() {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      expect(manager.getTargetBundleId()).toBeUndefined();

      process.env[ENV_KEY] = "com.env.fallback";
      expect(manager.getTargetBundleId()).toBe("com.env.fallback");

      manager.setTargetBundleId("com.explicit.app");
      expect(manager.getTargetBundleId()).toBe("com.explicit.app");
    });

    test("getExistingTargetBundleId reads env without constructing a manager (no port reserved)", function() {
      // No instance exists for this device after resetInstances() in beforeEach.
      expect(IOSCtrlProxyManager.getExistingTargetBundleId(testDevice)).toBeUndefined();
      // Proof it didn't build a manager: no service port got reserved for the device.
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();

      process.env[ENV_KEY] = "com.env.fallback";
      expect(IOSCtrlProxyManager.getExistingTargetBundleId(testDevice)).toBe("com.env.fallback");
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
    });

    test("getExistingTargetBundleId returns an existing instance's explicit target (precedence over env)", function() {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      manager.setTargetBundleId("com.explicit.app");
      process.env[ENV_KEY] = "com.env.fallback";
      expect(IOSCtrlProxyManager.getExistingTargetBundleId(testDevice)).toBe("com.explicit.app");
    });
  });

  describe("getReportedRunnerPort", function() {
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function() {
      fakeExecutor = new FakeProcessExecutor();
    });

    // Map each candidate /health port to a body the runner would return.
    const installHealthFakes = (bodyByPort: Record<number, string>): void => {
      fakeExecutor.setCommandHandler("curl -s", command => {
        const port = Number(command.match(/localhost:(\d+)\/health/)?.[1]);
        return createExecResult(bodyByPort[port] ?? "", "");
      });
    };

    test("returns the bound port the runner reports on the service port", async function() {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 8765 })
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      expect(await manager.getReportedRunnerPort()).toBe(8765);
    });

    test("discovers the runner on the default port when the service port is silent (#2731)", async function() {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 8765 })
        // 8767 (service port) returns nothing — the runner bound the default instead.
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );
      (manager as unknown as { servicePort: number }).servicePort = 8767;

      expect(await manager.getReportedRunnerPort()).toBe(8765);
    });

    test("ignores a health response from a different device on a shared port", async function() {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: "SOME-OTHER-DEVICE", port: 8765 })
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );
      (manager as unknown as { servicePort: number }).servicePort = 8767;

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    test("ignores a port reported without a matching device id (false-adoption guard)", async function() {
      // The #2731 env-propagation failure that drops the port var can also drop
      // the runner's device-id var, so a sibling simulator's runner on the shared
      // default port could answer with a port but no device id. It must not be
      // adopted as ours.
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", port: 8765 })
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );
      (manager as unknown as { servicePort: number }).servicePort = 8767;

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    test("ignores an out-of-range reported port", async function() {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 70000 })
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    test("returns null when the runner reports no port (older runner)", async function() {
      installHealthFakes({
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    test("returns null when no runner answers the health endpoint", async function() {
      installHealthFakes({});
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });

    // PARAM-2 (#4177 item 8): the #2731 service-port-beats-default ordering had
    // no test with BOTH candidate ports answering. The service port is probed
    // first, so when both a runner on the service port and one on the default
    // port answer validly for this device, the service port's report wins.
    test("prefers the service port over the default when BOTH answer for this device (#2731)", async function() {
      installHealthFakes({
        8767: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 8767 }),
        8765: JSON.stringify({ status: "ok", deviceId: testDevice.deviceId, port: 8765 }),
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );
      (manager as unknown as { servicePort: number }).servicePort = 8767;

      expect(await manager.getReportedRunnerPort()).toBe(8767);
    });

    // PARAM-2: a truncated/non-JSON health body can't confirm the device, so the
    // reported port must be nulled rather than partially parsed.
    test("returns null when the health body is truncated JSON", async function() {
      installHealthFakes({
        8765: `{"status":"ok","deviceId":"${testDevice.deviceId}","port":87`,
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      expect(await manager.getReportedRunnerPort()).toBeNull();
    });
  });

  describe("getCapabilities", function() {
    test("should identify simulator device type for UUID format deviceId", async function() {
      const manager = IOSCtrlProxyManager.createForTesting(testDevice, fakeTimer);
      const capabilities = await manager.getCapabilities();

      expect(capabilities.deviceType).toBe("simulator");
      expect(capabilities.supportsXCTest).toBe(true);
    });

    test("should identify physical device type for non-UUID format deviceId", async function() {
      const physicalDevice: BootedDevice = {
        deviceId: "00008030001E28C11E", // Physical device serial number format
        platform: "ios",
        name: "iPhone"
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
  describe("clearCaches", function() {
    test("forces isRunning to re-probe the health endpoint after clearing", async function() {
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = false;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          ""
        )
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );

      expect(await manager.isRunning()).toBe(false);   // probes, caches false
      healthy = true;
      expect(await manager.isRunning()).toBe(false);   // cached false is served
      manager.clearCaches();
      expect(await manager.isRunning()).toBe(true);     // cache cleared → re-probe
    });

    test("drops a cached positive availability so a now-down runner is re-probed", async function() {
      // isAvailable only serves a cache when it is POSITIVE, so this pins the
      // cachedAvailability clear specifically: deleting `this.cachedAvailability = null`
      // (or `this.cachedRunning = null`) from clearCaches leaves the stale positive and
      // reds the final assertion. cachedInstalled has no such test here because for a
      // simulator device isInstalled is unconditionally true — clearing it is unobservable.
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = true;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          ""
        )
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );

      expect(await manager.isAvailable()).toBe(true);   // installed(true)+running(true) → cached positive
      healthy = false;
      expect(await manager.isAvailable()).toBe(true);   // positive availability cache is served (stale)
      manager.clearCaches();
      expect(await manager.isAvailable()).toBe(false);  // caches dropped → re-probes the down runner
    });
  });

  describe("resetSetupState", function() {
    test("clears the running cache so isRunning re-probes", async function() {
      const fakeExecutor = new FakeProcessExecutor();
      let healthy = false;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          healthy ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          ""
        )
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );

      expect(await manager.isRunning()).toBe(false);
      healthy = true;
      expect(await manager.isRunning()).toBe(false);
      manager.resetSetupState();
      expect(await manager.isRunning()).toBe(true);
    });

    test("allows setup to launch again after a completed setup attempt", async function() {
      const fakeExecutor = new FakeProcessExecutor();
      let runnerHealthy = false;
      let launchCount = 0;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(runnerHealthy ? JSON.stringify({ status: "ok" }) : "", "")
      );
      fakeExecutor.setCommandHandler("kill -0", () => {
        throw new Error("runner is no longer running");
      });

      const fakeDeviceAppManager = {
        getInstalledAppBundleHash: async () => null
      } as unknown as DeviceAppManager;
      const xcodebuild: Xcodebuild = {
        executeCommand: async () => createExecResult("", ""),
        isAvailable: async () => true,
        startStreaming: async () => {
          launchCount++;
          runnerHealthy = true;
          return new FakeChildProcess() as unknown as ChildProcess;
        }
      };
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
        undefined,
        fakeDeviceAppManager,
        undefined,
        undefined,
        xcodebuild
      );
      fakeTimer.enableAutoAdvance();

      expect((await manager.setup()).success).toBe(true);
      expect(launchCount).toBe(1);

      runnerHealthy = false;
      manager.resetSetupState();

      expect((await manager.setup()).success).toBe(true);
      expect(launchCount).toBe(2);
    });
  });

  describe("iproxy tunnel", function() {
    let physicalDevice: BootedDevice;
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function() {
      physicalDevice = {
        deviceId: "00008030001E28C11E",
        platform: "ios",
        name: "iPhone"
      };
      fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandResponse("idevice_id -l", createExecResult(`${physicalDevice.deviceId}\n`, ""));
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
    });

    test("starts iproxy for physical devices with device-specific port", async function() {
      const fakeProcess = new FakeChildProcess();
      fakeExecutor.setNextSpawnProcess(fakeProcess);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

      const spawns = fakeExecutor.getSpawnedProcesses();
      expect(spawns.length).toBe(1);
      expect(spawns[0].command).toBe("iproxy");
      expect(spawns[0].args).toEqual([
        String(manager.getServicePort()),
        String(manager.getServicePort()),
        physicalDevice.deviceId
      ]);
    });

    test("restarts iproxy after unexpected exit", async function() {
      const fakeProcess = new FakeChildProcess();
      fakeExecutor.setNextSpawnProcess(fakeProcess);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

      fakeProcess.emit("exit", 1, null);
      await Promise.resolve();
      fakeTimer.advanceTime(1000);
      await Promise.resolve();

      expect(fakeExecutor.getSpawnedProcesses().length).toBe(2);
    });

    test("ignores stale local iproxy exit or error after a newer tunnel is tracked", async function() {
      for (const staleEvent of ["exit", "error"] as const) {
        const eventTimer = new FakeTimer();
        const eventExecutor = new FakeProcessExecutor();
        eventExecutor.setCommandResponse("idevice_id -l", createExecResult(`${physicalDevice.deviceId}\n`, ""));
        eventExecutor.setCommandResponse("curl -s", createExecResult("", ""));
        const oldProcess = new FakeChildProcess();
        oldProcess.pid = 1111;
        const newProcess = new FakeChildProcess();
        newProcess.pid = 2222;
        eventExecutor.setNextSpawnProcess(oldProcess);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice,
          eventTimer,
          undefined,
          eventExecutor
        );

        await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();
        await (manager as unknown as { stopIproxyTunnel: () => Promise<void> }).stopIproxyTunnel();
        eventExecutor.setNextSpawnProcess(newProcess);
        await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

        if (staleEvent === "exit") {
          oldProcess.emit("exit", 0, null);
        } else {
          oldProcess.emit("error", new Error("old tunnel failed after replacement"));
        }
        for (let i = 0; i < 5; i++) {await Promise.resolve();}

        expect((manager as unknown as { iproxyProcessId: number | null }).iproxyProcessId).toBe(2222);
        expect((manager as unknown as { iproxyProcess: FakeChildProcess | null }).iproxyProcess).toBe(newProcess);
        expect(eventTimer.getPendingTimeoutCount()).toBe(0);
        expect(eventExecutor.getSpawnedProcesses().length).toBe(2);
      }
    });


  });

  describe("restart prevention", function() {
    let physicalDevice: BootedDevice;
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function() {
      physicalDevice = {
        deviceId: "00008030001E28C11E",
        platform: "ios",
        name: "iPhone"
      };
      fakeExecutor = new FakeProcessExecutor();
    });

    test("start() skips spawning when tracked CtrlProxy PID is alive (simulator)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, // simulator UUID
        fakeTimer,
        undefined,
        fakeExecutor
      );

      // Simulate an already-tracked process (as if startOnSimulator ran previously)
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;

      // Health endpoint responds → confirms this PID really is CtrlProxy (not a PID-reused process)
      fakeExecutor.setCommandResponse("curl -s", createExecResult("ok", ""));
      // kill -0 succeeds by default (FakeProcessExecutor never throws) → process alive

      fakeTimer.enableAutoAdvance();
      await manager.start();

      // Process is alive → no simctl spawn or exec for starting the binary
      expect(fakeExecutor.wasCommandExecuted("simctl")).toBe(false);
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(0);
    });

    // Builds a fake ownable runner process modelled on the REAL launch command
    // (see startOnSimulator): xcodebuild with the CtrlProxy UI test target and this
    // device's identity, so isOwnRunnerProcessAlive()'s CtrlProxy-ownership guard
    // treats it as genuinely ours.
    function ownRunnerProcess(pid: number): FakeListeningProcess {
      return {
        pid,
        port: 8765,
        command: `xcodebuild test-without-building ` +
          `-xctestrun /tmp/automobile-ctrl-proxy/automobile-runner-${testDevice.deviceId}.xctestrun ` +
          `-destination "platform=iOS Simulator,id=${testDevice.deviceId}" ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
    }

    async function withHealthBudget(attempts: string, fn: () => Promise<void>): Promise<void> {
      const prev = process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
      process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = attempts;
      try {
        await fn();
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
        } else {
          process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = prev;
        }
      }
    }

    test("stop() tears down only the tracked owned runner tree without global pkill (#2847)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 912345;

      const ownedRunner = ownRunnerProcess(912345);
      const otherDeviceRunner: FakeListeningProcess = {
        pid: 912346,
        port: 8766,
        command: "xcodebuild test-without-building " +
          "-xctestrun /tmp/automobile-ctrl-proxy/automobile-runner-OTHER.xctestrun " +
          "-destination \"platform=iOS Simulator,id=OTHER-SIMULATOR\" " +
          "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
        environment: "CTRL_PROXY_IOS_PORT=8766 AUTOMOBILE_DEVICE_ID=OTHER-SIMULATOR",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      const externalHotReloadRunner: FakeListeningProcess = {
        pid: 912347,
        port: 8767,
        command: `xcodebuild test-without-building ` +
          `-xctestrun /Users/me/hot-reload/CtrlProxy.xctestrun ` +
          `-destination "platform=iOS Simulator,id=${testDevice.deviceId}" ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8767 AUTOMOBILE_EXTERNAL_RUNNER=1 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [ownedRunner, otherDeviceRunner, externalHotReloadRunner]);

      await manager.stop();

      expect(fakeExecutor.wasCommandExecuted("pkill -f 'CtrlProxyUITests-Runner'")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("pkill -f 'xcodebuild.*CtrlProxyUITests'")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912345")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912346")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL -- -912346")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912347")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL -- -912347")).toBe(false);
      expect(ownedRunner.alive).toBe(false);
      expect(otherDeviceRunner.alive).toBe(true);
      expect(externalHotReloadRunner.alive).toBe(true);
    });

    test("stop() does not kill a recycled tracked PID that is no longer our runner (#2847)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 912348;
      const recycledProcess: FakeListeningProcess = {
        pid: 912348,
        port: 8999,
        command: "/usr/sbin/some-unrelated-daemon --serve",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [recycledProcess]);

      await manager.stop();

      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912348")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 912348")).toBe(false);
      expect(recycledProcess.alive).toBe(true);
    });

    test("start() waits for an own runner then terminates it if it never becomes healthy (#2834)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, // simulator UUID
        fakeTimer,
        undefined,
        fakeExecutor
      );

      // A runner we spawned in an earlier setup() whose health endpoint is not up
      // yet (XCUITest still cold-starting on a loaded CI machine). Its PID is alive.
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      // Health endpoint never responds within this test's tiny budget → the runner
      // is hung, exercising the recovery path below.
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      const runnerProcs = [ownRunnerProcess(12345)];
      installListeningProcessFakes(fakeExecutor, runnerProcs);

      await withHealthBudget("1", async () => {
        fakeTimer.enableAutoAdvance();
        await expect(manager.start()).rejects.toThrow(/failed to start within timeout/);
      });

      // While it was still starting we did NOT respawn a competing runner (the original
      // livelock was: reclaim the port + respawn mid-startup).
      expect(fakeExecutor.wasCommandExecuted("simctl")).toBe(false);
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(0);
      // Thread-3 recovery: because it never became healthy we TERMINATE the hung runner
      // (rather than leave it alive to be re-adopted by findExternalCtrlProxyProcess on
      // the next start), and clear our tracking so the next start spawns fresh.
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 12345")).toBe(true);
      // The kill targets the process GROUP (tracked PID is the shell wrapper; a
      // single-PID TERM would orphan the xcodebuild child — #2834 review round 5).
      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -12345")).toBe(true);
      expect(runnerProcs[0].alive).toBe(false);
      expect((manager as unknown as { xcTestProcessId: number | null }).xcTestProcessId).toBeNull();
      // The auto-restart suppression latch is not left set across the throw (MINOR-2).
      expect((manager as unknown as { isStopping: boolean }).isStopping).toBe(false);
    });

    test("start() re-arms supervision after hung-runner cleanup so the next pre-health exit restarts", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      const runnerProcs = [ownRunnerProcess(12345)];
      installListeningProcessFakes(fakeExecutor, runnerProcs);

      await withHealthBudget("1", async () => {
        fakeTimer.enableAutoAdvance();
        await expect(manager.start()).rejects.toThrow(/failed to start within timeout/);
      });

      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);
      expect((manager as unknown as { xcTestProcessId: number | null }).xcTestProcessId).toBeNull();

      const failedPreHealthProcess = new FakeChildProcess();
      failedPreHealthProcess.pid = 22222;
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = failedPreHealthProcess.pid;
      (manager as unknown as { xcTestProcess: FakeChildProcess }).xcTestProcess = failedPreHealthProcess;
      fakeExecutor.setCommandHandler("curl -s", () => createExecResult(
        fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "",
        ""
      ));

      (manager as unknown as { handleProcessExit: () => void }).handleProcessExit();
      fakeTimer.advanceTime(1000);
      for (let i = 0; i < 5; i++) {await new Promise(resolve => setImmediate(resolve));}

      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("start() does NOT terminate the tracked PID if it was recycled during the wait (#2834)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;

      // PID 12345 stays alive throughout, and health never answers.
      fakeExecutor.setCommandHandler("kill -0", () => createExecResult("", ""));
      fakeExecutor.setCommandHandler("ps eww", () => createExecResult("some-process", ""));
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      // `ps -p … -o args=` reports our CtrlProxy runner at the initial wait decision, but
      // a foreign process by the pre-terminate re-verify (the tracked PID was recycled
      // during the long health poll). Registered first so it wins the "ps -p" match.
      let psArgsCalls = 0;
      fakeExecutor.setCommandHandler("ps -p", () => {
        psArgsCalls++;
        const command = psArgsCalls <= 1
          ? `1 xcodebuild test-without-building ` +
            `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService ` +
            `-destination "platform=iOS Simulator,id=${testDevice.deviceId}"`
          : "1 /usr/sbin/some-unrelated-daemon --serve";
        return createExecResult(command, "");
      });

      await withHealthBudget("1", async () => {
        fakeTimer.enableAutoAdvance();
        await expect(manager.start()).rejects.toThrow(/failed to start within timeout/);
      });

      // The re-verify sees a foreign command, so the recycled PID is NOT killed — we only
      // un-track it (MINOR-1). isStopping is not left latched (MINOR-2).
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 12345")).toBe(false);
      expect((manager as unknown as { xcTestProcessId: number | null }).xcTestProcessId).toBeNull();
      expect((manager as unknown as { isStopping: boolean }).isStopping).toBe(false);
      expect(psArgsCalls).toBeGreaterThanOrEqual(2); // wait-decision + pre-kill re-verify
    });


    test("start() reuses an own runner that becomes healthy during the wait (#2834)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      const runnerProcs = [ownRunnerProcess(12345)];
      installListeningProcessFakes(fakeExecutor, runnerProcs);

      // Health is down for the initial liveness/running checks (still starting) then
      // comes up once the health poll begins.
      let curlCalls = 0;
      fakeExecutor.setCommandHandler("curl -s", () => {
        curlCalls++;
        return createExecResult(curlCalls > 2 ? "ok" : "", "");
      });

      await withHealthBudget("30", async () => {
        fakeTimer.enableAutoAdvance();
        await manager.start(); // resolves — runner became healthy, no throw
      });

      // Reused the starting runner: never respawned, never killed, tracking retained.
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(0);
      expect(fakeExecutor.wasCommandExecuted("simctl")).toBe(false);
      expect(runnerProcs[0].alive).toBe(true);
      expect((manager as unknown as { xcTestProcessId: number | null }).xcTestProcessId).toBe(12345);
    });

    test("start() honors a caller readiness budget beyond the configured health-poll default", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      installListeningProcessFakes(fakeExecutor, [ownRunnerProcess(12345)]);

      let curlCalls = 0;
      fakeExecutor.setCommandHandler("curl -s", () => {
        curlCalls++;
        return createExecResult(curlCalls > 4 ? "ok" : "", "");
      });

      await withHealthBudget("3", async () => {
        fakeTimer.enableAutoAdvance();
        await manager.start({ healthCheckTimeoutMs: 2_000 });
      });

      expect(curlCalls).toBe(5);
    });

    // Directly exercise the PID-reuse guard added in review (thread 2). Testing the
    // predicate rather than a full start() keeps it precise and avoids spawning a
    // runner (whose background monitor would leak into later tests under autoAdvance).
    const callIsOwnRunnerProcessAlive = (m: IOSCtrlProxyManager): Promise<boolean> =>
      (m as unknown as { isOwnRunnerProcessAlive(): Promise<boolean> }).isOwnRunnerProcessAlive();

    test("isOwnRunnerProcessAlive rejects a reused PID that is not our runner (#2834)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );
      // The tracked PID is alive but has been reused by an UNRELATED process
      // (not xcodebuild, no device identity).
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      installListeningProcessFakes(fakeExecutor, [{
        pid: 12345,
        port: 9999,
        command: "/usr/sbin/some-unrelated-daemon --serve",
        alive: true,
      }]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(false);
    });

    test("isOwnRunnerProcessAlive rejects a CtrlProxy runner for a DIFFERENT device (#2834)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      // A genuine CtrlProxy runner, but for a sibling simulator (different device id).
      installListeningProcessFakes(fakeExecutor, [{
        pid: 12345,
        port: 8765,
        command: "xcodebuild test-without-building " +
          "-xctestrun /tmp/automobile-ctrl-proxy/automobile-runner-OTHER.xctestrun " +
          "-destination \"platform=iOS Simulator,id=OTHER-DEVICE-UUID\" " +
          "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
        environment: "CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=OTHER-DEVICE-UUID",
        alive: true,
      }]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(false);
    });

    test("isOwnRunnerProcessAlive rejects a user's own xcodebuild on the same simulator (#2834)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      // The tracked PID was reused by the user's OWN app test run, which targets the
      // same simulator (xcodebuild + our device id) but is NOT a CtrlProxy runner. It
      // must not be mistaken for our runner — otherwise we would wait on it and later
      // terminate it as "hung", killing the user's process (#2834 review, thread 2).
      installListeningProcessFakes(fakeExecutor, [{
        pid: 12345,
        port: 8999,
        command: `xcodebuild test -project MyApp.xcodeproj ` +
          `-destination "platform=iOS Simulator,id=${testDevice.deviceId}"`,
        alive: true,
      }]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(false);
    });

    test("isOwnRunnerProcessAlive accepts our live xcodebuild runner for this device (#2834)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      installListeningProcessFakes(fakeExecutor, [ownRunnerProcess(12345)]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(true);
    });

    test("isOwnRunnerProcessAlive returns false when the tracked PID is dead (#2834)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, fakeTimer, undefined, fakeExecutor
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      // No living process with this PID (installListeningProcessFakes' kill -0 throws).
      installListeningProcessFakes(fakeExecutor, [{
        ...ownRunnerProcess(12345),
        alive: false,
      }]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(false);
    });

    test("health-poll budget is env-configurable with a generous default (#2834)", function() {
      const resolve = (): number =>
        (IOSCtrlProxyManager as unknown as { resolveHealthPollMaxAttempts(): number })
          .resolveHealthPollMaxAttempts();
      const prev = process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
      try {
        process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = "240";
        expect(resolve()).toBe(240);
        // Invalid values fall back to the default (which is well above the old 30 = 15s).
        process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = "nonsense";
        expect(resolve()).toBeGreaterThan(30);
        delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
        expect(resolve()).toBeGreaterThan(30);
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
        } else {
          process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = prev;
        }
      }
    });

    test("start() re-establishes iproxy tunnel when CtrlProxy is alive but tunnel is gone (physical device)", async function() {
      fakeExecutor.setCommandResponse("idevice_id -l", createExecResult(`${physicalDevice.deviceId}\n`, ""));
      // Health endpoint responds → confirms the tracked PID really is CtrlProxy
      fakeExecutor.setCommandResponse("curl -s", createExecResult("ok", ""));

      const fakeProcess = new FakeChildProcess();
      fakeExecutor.setNextSpawnProcess(fakeProcess);

      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      // Simulate: CtrlProxy process is alive but iproxy tunnel was stopped
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      // iproxyProcessId is null → tunnel is gone

      fakeTimer.enableAutoAdvance();
      await manager.start();

      // iproxy should have been (re-)spawned even though CtrlProxy was alive
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(1);
      expect(fakeExecutor.getSpawnedProcesses()[0].command).toBe("iproxy");
    });


    test("xctest process supervisor uses the injected timer so tests can control it", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      expect(fakeTimer.getPendingIntervals().length).toBe(0);

      await (manager as unknown as { processSupervisor: { start: () => Promise<void> } }).processSupervisor.start();

      expect(fakeTimer.getPendingIntervals().length).toBe(1);
      expect(fakeTimer.getPendingIntervals()[0]).toBe(30000);
    });

    describe("iproxy monitor uses process liveness not health endpoint", function() {
      beforeEach(function() {
        fakeExecutor.setCommandResponse("idevice_id -l", createExecResult(`${physicalDevice.deviceId}\n`, ""));
      });

      test("does not restart iproxy when process is alive even if health check fails", async function() {
        const fakeProcess = new FakeChildProcess();
        fakeExecutor.setNextSpawnProcess(fakeProcess);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice, fakeTimer, undefined, fakeExecutor
        );

        await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();
        expect(fakeExecutor.getSpawnedProcesses().length).toBe(1);

        // Health endpoint fails (would have triggered restart in old code)
        fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
        // kill -0 succeeds by default → iproxy process alive

        // Fire one monitor interval
        fakeTimer.advanceTime(5000);
        for (let i = 0; i < 5; i++) {await Promise.resolve();}

        // iproxy is alive → no restart scheduled
        expect(fakeExecutor.getSpawnedProcesses().length).toBe(1);
      });

      test("restarts iproxy when iproxyProcessId is null (process gone)", async function() {
        const fakeProcess1 = new FakeChildProcess();
        const fakeProcess2 = new FakeChildProcess();
        fakeExecutor.setNextSpawnProcess(fakeProcess1);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice, fakeTimer, undefined, fakeExecutor
        );

        await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

        // Simulate iproxy process dying between monitor ticks (clears tracking state)
        (manager as unknown as { iproxyProcessId: null }).iproxyProcessId = null;
        (manager as unknown as { iproxyProcess: null }).iproxyProcess = null;

        fakeExecutor.setNextSpawnProcess(fakeProcess2);

        // Fire monitor — sees no tracked process → schedules restart
        fakeTimer.advanceTime(5000);
        for (let i = 0; i < 5; i++) {await new Promise(resolve => setImmediate(resolve));}

        // Fire restart timer (first attempt = 1000 ms base delay)
        fakeTimer.advanceTime(1000);
        for (let i = 0; i < 5; i++) {await new Promise(resolve => setImmediate(resolve));}

        expect(fakeExecutor.getSpawnedProcesses().length).toBe(2);
      });

      test("resumes iproxy monitoring after scheduled restart completes", async function() {
        const fakeProcess1 = new FakeChildProcess();
        const fakeProcess2 = new FakeChildProcess();
        fakeExecutor.setNextSpawnProcess(fakeProcess1);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice, fakeTimer, undefined, fakeExecutor
        );

        await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

        // Process exit triggers scheduleIproxyRestart
        fakeProcess1.emit("exit", 1, null);
        await Promise.resolve();

        fakeExecutor.setNextSpawnProcess(fakeProcess2);

        // Fire restart timer (1000 ms base delay for first attempt)
        fakeTimer.advanceTime(1000);
        for (let i = 0; i < 5; i++) {await new Promise(resolve => setImmediate(resolve));}

        // After restart, startIproxyMonitoring() should have been called → new interval pending
        expect(fakeTimer.getPendingIntervals().length).toBe(1);
      });

      test("keeps retrying when a scheduled iproxy restart attempt fails before the tunnel is supervised", async function() {
        const fakeProcess1 = new FakeChildProcess();
        const fakeProcess2 = new FakeChildProcess();
        fakeProcess2.pid = undefined as unknown as number;
        fakeExecutor.setNextSpawnProcess(fakeProcess1);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice, fakeTimer, undefined, fakeExecutor
        );

        await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

        fakeProcess1.emit("exit", 1, null);
        await Promise.resolve();
        expect(fakeTimer.getPendingTimeouts()).toEqual([1000]);

        fakeExecutor.setNextSpawnProcess(fakeProcess2);
        fakeTimer.advanceTime(1000);
        for (let i = 0; i < 5; i++) {await Promise.resolve();}

        expect(fakeExecutor.getSpawnedProcesses().length).toBe(2);
        expect(fakeTimer.getPendingTimeouts()).toEqual([2000]);
      });

    });
  });

  describe("simulator start uses xcodebuild test-without-building", function() {
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function() {
      fakeExecutor = new FakeProcessExecutor();
    });

    test("start() throws when simulator xctestrun path is missing", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => null,
        getRunnerBinaryPath: async () => null,
        verifyRunnerBinaryBeforeLaunch: async () => {},
        writeRunnerEnvironment: fakeWriteRunnerEnvironment,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;

      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      // Health check fails → not already running → tries to start
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow(
        "CtrlProxy xctestrun not found for simulator"
      );
    });

    test("start() does not use simctl spawn for simulator", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => "/tmp/test.xctestrun",
        getRunnerBinaryPath: async () => null,
        verifyRunnerBinaryBeforeLaunch: async () => {},
        writeRunnerEnvironment: fakeWriteRunnerEnvironment,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;

      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      // Health check succeeds on first poll (simulating xcodebuild starting the service)
      fakeExecutor.setCommandResponse("curl -s", createExecResult("ok", ""));
      fakeTimer.enableAutoAdvance();

      await manager.start();

      // simctl spawn should never be invoked via processExecutor
      expect(fakeExecutor.wasCommandExecuted("simctl spawn")).toBe(false);
    });

    test("start() adopts a healthy default hot-reload CtrlProxy port before health polling", async function() {
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = {
          getXctestrunPath: async () => {
            throw new Error("should not build when an external CtrlProxy process is reused");
          },
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: fakeWriteRunnerEnvironment,
        } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor
        );
        expect(manager.getServicePort()).toBe(8767);

        fakeExecutor.setCommandResponse("http://localhost:8767/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
        fakeExecutor.setCommandResponse(
          "http://localhost:8765/health",
          createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), "")
        );
        fakeTimer.enableAutoAdvance();

        await manager.start();

        expect(manager.getServicePort()).toBe(8765);
        expect(PortManager.getPort(testDevice.deviceId)).toBe(8765);
        expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("start() does not adopt the default CtrlProxy port for another simulator", async function() {
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = {
          getXctestrunPath: async () => "/tmp/test.xctestrun",
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: fakeWriteRunnerEnvironment,
        } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor
        );
        expect(manager.getServicePort()).toBe(8767);

        fakeExecutor.setCommandResponse("http://localhost:8767/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
        fakeExecutor.setCommandResponse(
          "http://localhost:8765/health",
          createExecResult(JSON.stringify({ status: "ok", deviceId: "OTHER-SIMULATOR" }), "")
        );
        fakeTimer.enableAutoAdvance();

        await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

        expect(manager.getServicePort()).toBe(8767);
        expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
        expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("start() spawns when default hot-reload port is not healthy", async function() {
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = {
          getXctestrunPath: async () => "/tmp/test.xctestrun",
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: fakeWriteRunnerEnvironment,
        } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor
        );

        fakeExecutor.setCommandResponse("http://localhost:8767/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
        fakeExecutor.setCommandResponse("http://localhost:8765/health", createExecResult("", ""));
        fakeTimer.enableAutoAdvance();

        await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

        expect(manager.getServicePort()).toBe(8767);
        expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("start() adopts a custom hot-reload CtrlProxy port from process args", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => {
          throw new Error("should not build when an external CtrlProxy process is reused");
        },
        getRunnerBinaryPath: async () => null,
        verifyRunnerBinaryBeforeLaunch: async () => {},
        writeRunnerEnvironment: fakeWriteRunnerEnvironment,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      fakeExecutor.setCommandResponse("http://localhost:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2469\n", ""));
      fakeExecutor.setCommandResponse(
        "ps -p 2469",
        createExecResult(`xcodebuild test CtrlProxyUITests -destination id=${testDevice.deviceId} CTRL_PROXY_IOS_PORT=8790`, "")
      );
      fakeExecutor.setCommandResponse("http://localhost:8790/health", createExecResult("ok", ""));
      fakeTimer.enableAutoAdvance();

      await manager.start();

      expect(manager.getServicePort()).toBe(8790);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8790);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() preserves an externally managed runner on the current port while it is still starting", async function() {
      const externalProcess: FakeListeningProcess = {
        pid: 2470,
        port: 8765,
        command: `xcodebuild test CtrlProxyUITests -destination id=${testDevice.deviceId} CTRL_PROXY_IOS_PORT=8765`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [externalProcess]);
      const fakeBuilder = {
        getXctestrunPath: async () => {
          throw new Error("should not build when an external CtrlProxy process is reused");
        },
        getRunnerBinaryPath: async () => null,
        verifyRunnerBinaryBeforeLaunch: async () => {},
        writeRunnerEnvironment: fakeWriteRunnerEnvironment,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      fakeExecutor.setCommandResponse("http://localhost:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2470\n", ""));
      fakeExecutor.setCommandResponse(
        "ps -p 2470",
        createExecResult(externalProcess.command, "")
      );
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      expect(externalProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2470")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2470")).toBe(false);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() preserves an externally managed test-without-building runner with inline identity", async function() {
      const externalProcess: FakeListeningProcess = {
        pid: 2471,
        port: 8765,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [externalProcess]);
      const fakeBuilder = {
        getXctestrunPath: async () => {
          throw new Error("should not build when an external CtrlProxy process is reused");
        },
        getRunnerBinaryPath: async () => null,
        verifyRunnerBinaryBeforeLaunch: async () => {},
        writeRunnerEnvironment: fakeWriteRunnerEnvironment,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      fakeExecutor.setCommandResponse("http://localhost:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2471\n", ""));
      fakeExecutor.setCommandResponse(
        "ps -p 2471",
        createExecResult(externalProcess.command, "")
      );
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      expect(externalProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2471")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2471")).toBe(false);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() preserves an externally managed test-without-building runner with environment identity", async function() {
      const externalProcess: FakeListeningProcess = {
        pid: 2472,
        port: 8791,
        ppid: 2468,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8791 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [externalProcess]);
      const fakeBuilder = {
        getXctestrunPath: async () => {
          throw new Error("should not build when an external CtrlProxy process is reused");
        },
        getRunnerBinaryPath: async () => null,
        verifyRunnerBinaryBeforeLaunch: async () => {},
        writeRunnerEnvironment: fakeWriteRunnerEnvironment,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      fakeExecutor.setCommandResponse("http://localhost:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("http://localhost:8791/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2472\n", ""));
      fakeExecutor.setCommandResponse(
        "ps -p 2472",
        createExecResult(`${externalProcess.ppid} ${externalProcess.command}`, "")
      );
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      expect(externalProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2472")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2472")).toBe(false);
      expect(manager.getServicePort()).toBe(8791);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8791);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() ignores xcodebuild CtrlProxy processes for other simulators", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => "/tmp/test.xctestrun",
        getRunnerBinaryPath: async () => null,
        verifyRunnerBinaryBeforeLaunch: async () => {},
        writeRunnerEnvironment: fakeWriteRunnerEnvironment,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      fakeExecutor.setCommandResponse("http://localhost:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2469\n", ""));
      fakeExecutor.setCommandResponse(
        "ps -p 2469",
        createExecResult("xcodebuild test CtrlProxyUITests -destination id=OTHER-SIMULATOR CTRL_PROXY_IOS_PORT=8790", "")
      );
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      expect(manager.getServicePort()).toBe(8765);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("startOnSimulator() delivers the reallocated port to the runner via the xctestrun (EC5)", async function() {
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const writeCalls: { xctestrunPath: string; env: Record<string, string>; deviceId: string }[] = [];
        const fakeBuilder = {
          getXctestrunPath: async () => "/tmp/test.xctestrun",
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: async (xctestrunPath: string, env: Record<string, string>, deviceId: string) => {
            writeCalls.push({ xctestrunPath, env, deviceId });
            return "/tmp/automobile-runner-SIM.xctestrun";
          },
        } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor
        );

        await (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator();

        const spawn = fakeExecutor.getSpawnedProcesses()[0];
        expect(manager.getServicePort()).toBe(8767);

        // The allocated port is injected into the xctestrun (the only channel the
        // in-simulator runner can read) — keyed off the cached source xctestrun.
        expect(writeCalls).toHaveLength(1);
        expect(writeCalls[0].xctestrunPath).toBe("/tmp/test.xctestrun");
        expect(writeCalls[0].env.CTRL_PROXY_IOS_PORT).toBe("8767");
        expect(writeCalls[0].deviceId).toBe(testDevice.deviceId);

        // xcodebuild is pointed at the per-launch copy, not the cached source.
        expect(spawn.command).toBe("xcodebuild");
        expect(spawn.args).toContain("/tmp/automobile-runner-SIM.xctestrun");
        expect(spawn.args).not.toContain("/tmp/test.xctestrun");
        expect(spawn.options?.shell).toBe(false);

        // Host env still carries the identity vars used for daemon-side process
        // discovery/ownership — but NOT the dead SIMCTL_CHILD_* prefixes.
        expect(spawn.options?.env).toMatchObject({
          CTRL_PROXY_IOS_PORT: "8767",
          AUTOMOBILE_DEVICE_ID: testDevice.deviceId,
        });
        expect(Object.keys(spawn.options?.env ?? {}).some(key => key.startsWith("SIMCTL_CHILD_"))).toBe(false);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("startOnSimulator() reallocates when the current simulator port becomes busy before launch", async function() {
      const unavailablePorts = new Set<number>();
      const checkedPorts: number[] = [];
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => {
          checkedPorts.push(port);
          return !unavailablePorts.has(port);
        },
      });
      try {
        const fakeBuilder = {
          getXctestrunPath: async () => "/tmp/test.xctestrun",
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: fakeWriteRunnerEnvironment,
        } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor
        );
        expect(manager.getServicePort()).toBe(8765);

        unavailablePorts.add(8765);

        await (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator();

        const spawn = fakeExecutor.getSpawnedProcesses()[0];
        expect(checkedPorts).toEqual([8765, 8765, 8767]);
        expect(manager.getServicePort()).toBe(8767);
        expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
        expect(spawn.options?.env).toMatchObject({
          CTRL_PROXY_IOS_PORT: "8767",
        });
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("the port the runner reads from the spawned xctestrun equals the client service port (EC6 boundary)", async function() {
      // Boundary model of the simulator process boundary: the daemon (client) and
      // the in-simulator runner agree on the port ONLY if the allocated port is
      // carried in the xctestrun the runner reads. This is the assertion that
      // would have caught #2731 (runner bound 8765 while the client used 8767).
      const productsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlproxy-boundary-"));
      const sourceXctestrun = path.join(
        productsDir,
        "CtrlProxyApp_iphonesimulator26.2-arm64-x86_64.xctestrun"
      );
      await fs.writeFile(sourceXctestrun, BOUNDARY_XCTESTRUN);

      // Use the REAL writeRunnerEnvironment so a real per-launch xctestrun is produced.
      const realBuilder = IOSCtrlProxyBuilder.getInstance({ derivedDataPath: productsDir });
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = {
          getXctestrunPath: async () => sourceXctestrun,
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: (p: string, env: Record<string, string>, id: string) =>
            realBuilder.writeRunnerEnvironment(p, env, id),
        } as unknown as IOSCtrlProxyBuilder;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor
        );

        await (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator();

        // Read back the port the runner WILL read from its own ProcessInfo.environment.
        const spawnArgs = fakeExecutor.getSpawnedProcesses()[0].args;
        const xctestrunArgIndex = spawnArgs.indexOf("-xctestrun");
        expect(xctestrunArgIndex).toBeGreaterThanOrEqual(0);
        const runnerXctestrunPath = spawnArgs[xctestrunArgIndex + 1];
        const root = await parsePlist(await fs.readFile(runnerXctestrunPath, "utf-8")) as Map<string, unknown>;
        const uiTarget = root.get("CtrlProxyUITests") as Map<string, unknown>;
        const env = uiTarget.get("EnvironmentVariables") as Map<string, unknown>;
        const runnerPort = Number(env.get("CTRL_PROXY_IOS_PORT"));

        expect(runnerPort).toBe(8767);
        expect(runnerPort).toBe(manager.getServicePort());
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
        await fs.rm(productsDir, { recursive: true, force: true });
      }
    });

    test("startOnDevice() delivers the allocated port via the xctestrun, not a build setting (EC7)", async function() {
      const physicalDevice: BootedDevice = {
        deviceId: "00008030001E28C11E",
        platform: "ios",
        name: "iPhone"
      };
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const writeCalls: { env: Record<string, string>; deviceId: string }[] = [];
        const fakeBuilder = {
          getXctestrunPath: async () => "/tmp/device.xctestrun",
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: async (_p: string, env: Record<string, string>, deviceId: string) => {
            writeCalls.push({ env, deviceId });
            return "/tmp/automobile-runner-DEV.xctestrun";
          },
        } as unknown as IOSCtrlProxyBuilder;
        const fakeSigning = {
          resolveSigningForDevice: async () => ({
            buildSettings: [],
            allowProvisioningUpdates: false,
            warnings: []
          }),
        } as unknown as XcodeSigningManager;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor,
          fakeSigning
        );
        const internal = manager as unknown as {
          verifyInstalledAppBundle: () => Promise<void>;
          startIproxyTunnel: () => Promise<void>;
          startOnDevice: () => Promise<void>;
        };
        // Bypass tunnel/install verification — not under test here.
        internal.verifyInstalledAppBundle = async () => {};
        internal.startIproxyTunnel = async () => {};

        await internal.startOnDevice();

        const spawn = fakeExecutor.getSpawnedProcesses()[0];
        expect(writeCalls).toHaveLength(1);
        expect(writeCalls[0].env.CTRL_PROXY_IOS_PORT).toBe("8767");
        expect(writeCalls[0].deviceId).toBe(physicalDevice.deviceId);

        // xcodebuild points at the per-launch copy; the bare build-setting token is gone.
        expect(spawn.command).toBe("xcodebuild");
        expect(spawn.args).toContain("/tmp/automobile-runner-DEV.xctestrun");
        expect(spawn.args).not.toContain("CTRL_PROXY_IOS_PORT=8767");
        expect(spawn.options?.shell).toBe(false);
        expect(spawn.options?.detached).toBe(true);

        // Host env still carries identity vars for daemon-side process discovery.
        expect(spawn.options?.env).toMatchObject({
          CTRL_PROXY_IOS_PORT: "8767",
          AUTOMOBILE_DEVICE_ID: physicalDevice.deviceId,
        });
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });


    test("start() terminates a stale owned runner on the intended port before spawning", async function() {
      const staleProcess: FakeListeningProcess = {
        pid: 2222,
        port: 8765,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        alive: true,
        ignoreTerm: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "", "")
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      await manager.start();

      expect(staleProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2222")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2222")).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8765",
      });
    });

    test("start() adopts a direct runner for the current simulator while it is still starting", async function() {
      const runnerProcess: FakeListeningProcess = {
        pid: 2223,
        port: 8765,
        ppid: 2222,
        command: "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        alive: true,
      };
      const parentProcess: FakeListeningProcess = {
        pid: 2222,
        port: 0,
        ppid: 1,
        command: `launchd_sim ${testDevice.deviceId}`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [runnerProcess, parentProcess]);
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: port => port !== 8765,
      });
      try {
        fakeExecutor.setCommandResponse("http://localhost:8765/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("http://localhost:8766/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
        fakeTimer.enableAutoAdvance();
        const fakeBuilder = {
          getXctestrunPath: async () => {
            throw new Error("should not build when an external direct runner is reused");
          },
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: fakeWriteRunnerEnvironment,
        } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor
        );

        await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

        expect(runnerProcess.alive).toBe(true);
        expect(fakeExecutor.wasCommandExecuted("kill -TERM 2223")).toBe(false);
        expect(fakeExecutor.wasCommandExecuted("kill -KILL 2223")).toBe(false);
        expect(manager.getServicePort()).toBe(8765);
        expect(PortManager.getPort(testDevice.deviceId)).toBe(8765);
        expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("start() reclaims a stale daemon-owned xcodebuild even when pgrep finds it", async function() {
      const staleProcess: FakeListeningProcess = {
        pid: 2223,
        port: 8765,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2223\n", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "", "")
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      await manager.start();

      expect(staleProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2223")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2223")).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8765",
      });
    });

    test("start() reclaims a stale daemon-owned xcodebuild with an orphaned shell parent", async function() {
      const staleProcess: FakeListeningProcess = {
        pid: 2225,
        port: 8765,
        ppid: 2224,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
      };
      const orphanedShellProcess: FakeListeningProcess = {
        pid: 2224,
        port: 0,
        ppid: 1,
        command: `/bin/sh -c ${staleProcess.command} 2>&1`,
        environment: staleProcess.environment,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleProcess, orphanedShellProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2225\n", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "", "")
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      await manager.start();

      expect(staleProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2225")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2225")).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8765",
      });
    });

    test("start() reclaims a stale listener by terminating the daemon-managed shell root (#2847)", async function() {
      const staleListener: FakeListeningProcess = {
        pid: 2227,
        port: 8765,
        ppid: 2226,
        command: `/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner`,
        environment: `AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      const daemonXcodebuild: FakeListeningProcess = {
        pid: 2226,
        port: 0,
        ppid: 2225,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      const daemonShell: FakeListeningProcess = {
        pid: 2225,
        port: 0,
        ppid: 1,
        command: `/bin/sh -c ${daemonXcodebuild.command} 2>&1`,
        environment: daemonXcodebuild.environment,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleListener, daemonXcodebuild, daemonShell]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "", "")
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );
      const originalSpawn = fakeExecutor.spawn.bind(fakeExecutor);
      let portWasFreeAtSpawn = false;
      fakeExecutor.spawn = (command, args, options) => {
        portWasFreeAtSpawn = !staleListener.alive;
        return originalSpawn(command, args, options);
      };

      await manager.start();

      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -2225")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2226")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2227")).toBe(true);
      expect(daemonShell.alive).toBe(false);
      expect(daemonXcodebuild.alive).toBe(false);
      expect(staleListener.alive).toBe(false);
      expect(portWasFreeAtSpawn).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("start() reallocates when the intended port is held by a foreign process", async function() {
      const foreignProcess: FakeListeningProcess = {
        pid: 3333,
        port: 8765,
        command: "adb -L tcp:localhost:8765 fork-server server --reply-fd 4",
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [foreignProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "", "")
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      await manager.start();

      expect(foreignProcess.alive).toBe(true);
      expect(manager.getServicePort()).toBe(8767);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8767",
      });
    });

    test("start() reallocates instead of killing another simulator's CtrlProxy runner on the intended port", async function() {
      const otherSimulatorProcess: FakeListeningProcess = {
        pid: 3334,
        port: 8765,
        command: "xcodebuild test CtrlProxyUITests -destination id=OTHER-SIMULATOR CTRL_PROXY_IOS_PORT=8765",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [otherSimulatorProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("3334\n", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "", "")
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      await manager.start();

      expect(otherSimulatorProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 3334")).toBe(false);
      expect(manager.getServicePort()).toBe(8767);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8767",
      });
    });

    test("start() reallocates instead of killing another simulator's direct runner on the intended port", async function() {
      const otherSimulatorProcess: FakeListeningProcess = {
        pid: 3335,
        port: 8765,
        ppid: 3334,
        command: "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      const otherSimulatorParent: FakeListeningProcess = {
        pid: 3334,
        port: 0,
        ppid: 1,
        command: "launchd_sim OTHER-SIMULATOR",
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [otherSimulatorProcess, otherSimulatorParent]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "", "")
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      await manager.start();

      expect(otherSimulatorProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 3335")).toBe(false);
      expect(manager.getServicePort()).toBe(8767);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8767",
      });
    });

    test("start() terminates a stale direct runner identified by environment before spawning", async function() {
      const staleProcess: FakeListeningProcess = {
        pid: 3335,
        port: 8765,
        command: "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        environment: `AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "", "")
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      await manager.start();

      expect(staleProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 3335")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 3335")).toBe(true);
      expect(manager.getServicePort()).toBe(8765);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8765",
      });
    });

    test("start() reallocates instead of killing another simulator's direct runner identified by environment", async function() {
      const otherSimulatorProcess: FakeListeningProcess = {
        pid: 3336,
        port: 8765,
        command: "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        environment: "AUTOMOBILE_DEVICE_ID=OTHER-SIMULATOR",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [otherSimulatorProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(fakeExecutor.getSpawnedProcesses().length > 0 ? "ok" : "", "")
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      await manager.start();

      expect(otherSimulatorProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 3336")).toBe(false);
      expect(manager.getServicePort()).toBe(8767);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8767",
      });
    });

    test("startup orphan reaping terminates orphaned CtrlProxy xcodebuild processes", async function() {
      const orphanProcess: FakeListeningProcess = {
        pid: 4444,
        port: 8765,
        ppid: 1,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [orphanProcess]);
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("4444\n", ""));
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(new IOSCtrlProxyProcessClient(fakeExecutor, fakeTimer), fakeTimer);

      expect(orphanProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 4444")).toBe(true);
    });

    test("startup orphan reaping terminates orphaned CtrlProxy UITest runner processes", async function() {
      const orphanProcess: FakeListeningProcess = {
        pid: 4445,
        port: 8765,
        ppid: 1,
        command: `/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner ${testDevice.deviceId}`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [orphanProcess]);
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("4445\n", ""));
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(new IOSCtrlProxyProcessClient(fakeExecutor, fakeTimer), fakeTimer);

      expect(orphanProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 4445")).toBe(true);
    });

    test("startup orphan reaping terminates daemon-managed shell-rooted runner trees (#2847)", async function() {
      const orphanedRunner: FakeListeningProcess = {
        pid: 4448,
        port: 8765,
        ppid: 4447,
        command: `/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner`,
        environment: `AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      const orphanedXcodebuild: FakeListeningProcess = {
        pid: 4447,
        port: 0,
        ppid: 4446,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      const orphanedShell: FakeListeningProcess = {
        pid: 4446,
        port: 0,
        ppid: 1,
        command: `/bin/sh -c ${orphanedXcodebuild.command} 2>&1`,
        environment: orphanedXcodebuild.environment,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [orphanedRunner, orphanedXcodebuild, orphanedShell]);
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("4447\n4448\n", ""));
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(new IOSCtrlProxyProcessClient(fakeExecutor, fakeTimer), fakeTimer);

      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -4446")).toBe(true);
      expect(orphanedShell.alive).toBe(false);
      expect(orphanedXcodebuild.alive).toBe(false);
      expect(orphanedRunner.alive).toBe(false);
    });

    test("startup orphan reaping preserves CtrlProxy xcodebuild with a live non-orphan parent (#2847)", async function() {
      const liveParent: FakeListeningProcess = {
        pid: 4450,
        port: 0,
        ppid: 4400,
        command: "node dist/src/index.js --daemon-mode",
        alive: true,
      };
      const liveXcodebuild: FakeListeningProcess = {
        pid: 4451,
        port: 0,
        ppid: 4450,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [liveParent, liveXcodebuild]);
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("4451\n", ""));
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(new IOSCtrlProxyProcessClient(fakeExecutor, fakeTimer), fakeTimer);

      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -4451")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 4451")).toBe(false);
      expect(liveXcodebuild.alive).toBe(true);
    });

    test("startup orphan reaping caps candidate process work and logs skipped candidates", async function() {
      const candidates: FakeListeningProcess[] = Array.from(
        { length: MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES + 1 },
        (_, index) => ({
          pid: 6000 + index,
          port: 0,
          ppid: 1,
          command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy-${index}.xctestrun ` +
            `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
            `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
          alive: true,
        })
      );
      const fakeExecutor = new FakeProcessExecutor();
      installListeningProcessFakes(fakeExecutor, candidates);
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(candidates.map(candidate => String(candidate.pid)).join("\n"), "")
      );
      fakeTimer.enableAutoAdvance();
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
          new IOSCtrlProxyProcessClient(fakeExecutor, fakeTimer),
          fakeTimer
        );

        expect(candidates.filter(candidate => candidate.alive)).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("skipped 1 startup CtrlProxy runner candidate")
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("startup orphan reaping filters unrelated xcodebuild candidates before applying its cap", async function() {
      const unrelatedXcodebuilds: FakeListeningProcess[] = Array.from(
        { length: MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES },
        (_, index) => ({
          pid: 6500 + index,
          port: 0,
          ppid: 1,
          command: `xcodebuild test-without-building -xctestrun /tmp/Unrelated-${index}.xctestrun`,
          alive: true,
        })
      );
      const orphanedRunner: FakeListeningProcess = {
        pid: 6600,
        port: 0,
        ppid: 1,
        command: "/tmp/CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner",
        alive: true,
      };
      const fakeExecutor = new FakeProcessExecutor();
      installListeningProcessFakes(fakeExecutor, [...unrelatedXcodebuilds, orphanedRunner]);
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(`${orphanedRunner.pid}\n`, "")
      );
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
        new IOSCtrlProxyProcessClient(fakeExecutor, fakeTimer),
        fakeTimer
      );

      expect(orphanedRunner.alive).toBe(false);
      expect(unrelatedXcodebuilds.every(process => process.alive)).toBe(true);
    });

    test("startup orphan reaping inspects past live CtrlProxy runners before applying its cap", async function() {
      const liveRunners: FakeListeningProcess[] = Array.from(
        { length: MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES },
        (_, index) => ({
          pid: 6700 + index,
          port: 0,
          ppid: 8000 + index,
          command: `/tmp/CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner live-${index}`,
          alive: true,
        })
      );
      const orphanedRunner: FakeListeningProcess = {
        pid: 6800,
        port: 0,
        ppid: 1,
        command: "/tmp/CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner orphan",
        alive: true,
      };
      const fakeExecutor = new FakeProcessExecutor();
      installListeningProcessFakes(fakeExecutor, [...liveRunners, orphanedRunner]);
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult([...liveRunners, orphanedRunner].map(process => String(process.pid)).join("\n"), "")
      );
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
        new IOSCtrlProxyProcessClient(fakeExecutor, fakeTimer),
        fakeTimer
      );

      expect(orphanedRunner.alive).toBe(false);
      expect(liveRunners.every(process => process.alive)).toBe(true);
    });

    test("startup orphan reaping stops at its fake-clock deadline", async function() {
      const candidates: FakeListeningProcess[] = [0, 1].map(index => ({
        pid: 7000 + index,
        port: 0,
        ppid: 1,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy-${index}.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        alive: true,
      }));
      const fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandHandler("ps -p", command => {
        const pid = Number(command.match(/ps -p\s+(\d+)/)?.[1]);
        const process = candidates.find(candidate => candidate.pid === pid && candidate.alive);
        fakeTimer.advanceTime(STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS);
        return createExecResult(process ? `${process.ppid} ${process.command}` : "", "");
      });
      installListeningProcessFakes(fakeExecutor, candidates);
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(candidates.map(candidate => String(candidate.pid)).join("\n"), "")
      );
      fakeTimer.enableAutoAdvance();
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
          new IOSCtrlProxyProcessClient(fakeExecutor, fakeTimer),
          fakeTimer
        );

        expect(candidates.filter(candidate => candidate.alive)).toHaveLength(2);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("startup CtrlProxy runner sweep timed out")
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("startup orphan reaping does not terminate a tree when ancestry traversal exhausts its deadline", async function() {
      const shell: FakeListeningProcess = {
        pid: 7101,
        port: 0,
        ppid: 1,
        command: "/bin/sh -c xcodebuild",
        alive: true,
      };
      const xcodebuild: FakeListeningProcess = {
        pid: 7102,
        port: 0,
        ppid: shell.pid,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
        alive: true,
      };
      const runner: FakeListeningProcess = {
        pid: 7103,
        port: 0,
        ppid: xcodebuild.pid,
        command: "/tmp/CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner",
        alive: true,
      };
      const fakeExecutor = new FakeProcessExecutor();
      installListeningProcessFakes(fakeExecutor, [shell, xcodebuild, runner]);
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult(`${runner.pid}\n`, ""));
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      let nowCallCount = 0;
      const nowSpy = spyOn(fakeTimer, "now").mockImplementation(() => {
        nowCallCount++;
        return nowCallCount >= 4 ? STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS : 0;
      });

      try {
        await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
          new IOSCtrlProxyProcessClient(fakeExecutor, fakeTimer),
          fakeTimer
        );

        expect(runner.alive).toBe(true);
        expect(xcodebuild.alive).toBe(true);
        expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -7101")).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("startup CtrlProxy runner sweep timed out")
        );
      } finally {
        nowSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    test("start waits for startup orphan reaping before probing a simulator runner", async function() {
      const reaping = deferred();
      const reapSpy = spyOn(
        IOSCtrlProxyManager,
        "reapOrphanedRunnerProcessesOnStartup"
      ).mockImplementation(() => reaping.promise);
      const fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandResponse("curl -s", createExecResult("ok", ""));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      try {
        IOSCtrlProxyManager.startOrphanRunnerReapOnStartup();
        const start = manager.start();
        await Promise.resolve();

        expect(fakeExecutor.wasCommandExecuted("curl -s")).toBe(false);
        reaping.resolve();
        await start;
        expect(fakeExecutor.wasCommandExecuted("curl -s")).toBe(true);
      } finally {
        reapSpy.mockRestore();
      }
    });

    test("startup reaping releases simulator start after its deadline when process cleanup hangs", async function() {
      const reaping = deferred();
      const reapSpy = spyOn(
        IOSCtrlProxyManager,
        "reapOrphanedRunnerProcessesOnStartup"
      ).mockImplementation(() => reaping.promise);
      const fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandResponse("curl -s", createExecResult("ok", ""));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      try {
        IOSCtrlProxyManager.startOrphanRunnerReapOnStartup(undefined, fakeTimer);
        const start = manager.start();
        await Promise.resolve();

        expect(fakeExecutor.wasCommandExecuted("curl -s")).toBe(false);
        fakeTimer.advanceTime(STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(fakeExecutor.wasCommandExecuted("curl -s")).toBe(true);

        reaping.resolve();
        await fakeTimer.resolvePromise(start);
      } finally {
        reapSpy.mockRestore();
      }
    });

    test("start() reports the bound PID and command when owned port cleanup cannot free the port", async function() {
      const stuckProcess: FakeListeningProcess = {
        pid: 5555,
        port: 8765,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [stuckProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor
      );

      await expect(manager.start()).rejects.toThrow(
        /port 8765 still held by PID 5555 .*xcodebuild test-without-building/
      );
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);
    });
  });
});
