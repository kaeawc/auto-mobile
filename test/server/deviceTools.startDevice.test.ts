import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "node:events";
import { setDeviceToolsDependencies, resetDeviceToolsDependencies, registerDeviceTools, startDeviceSchema } from "../../src/server/deviceTools";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import {
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../../src/utils/deviceTimeouts";
import {
  MAX_RUNNER_READINESS_TIMEOUT_MS,
  MIN_RUNNER_READINESS_TIMEOUT_MS,
} from "../../src/utils/runnerReadinessConfig";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import * as os from "os";

const AUTOLOCK_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
] as const;

class FakeExitChildProcess extends EventEmitter {
  readonly pid = 4242;
  readonly exitCode: number | null | undefined = undefined;
  readonly signalCode: NodeJS.Signals | null | undefined = undefined;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function clearAutolockEnv(): void {
  for (const key of AUTOLOCK_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("startDevice handler", () => {
  let fakeDeviceUtils: FakeDeviceUtils;
  let fakeMatcher: FakeDeviceMatcher;
  let daemonSessionManager: SessionManager | undefined;

  beforeEach(() => {
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeMatcher = new FakeDeviceMatcher();
    daemonSessionManager = undefined;

    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceUtils,
      deviceMatcherFactory: () => fakeMatcher,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      timer: new FakeTimer(),
    });

    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    clearAutolockEnv();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
  });

  async function callStartDevice(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const tool = ToolRegistry.getTool("startDevice");
    if (!tool) {throw new Error("startDevice not registered");}
    const result = await tool.handler(args, undefined, signal);
    return JSON.parse(typeof result === "string" ? result : (result as any).content?.[0]?.text ?? "{}");
  }

  const androidDevice: BootedDevice = {
    name: "Pixel_7_API_34",
    platform: "android",
    deviceId: "emulator-5554",
    osVersion: "14",
    formFactor: "phone",
    screenWidth: 1080,
    screenHeight: 2400,
  };

  const androidImage: DeviceInfo = {
    name: "Pixel_7_API_34",
    platform: "android",
    isRunning: false,
    osVersion: "14",
    formFactor: "phone",
    screenWidth: 1080,
    screenHeight: 2400,
  };

  const iosDevice: BootedDevice = {
    name: "iPhone 15",
    platform: "ios",
    deviceId: "ABCD-1234",
    iosVersion: "17.2",
    osVersion: "17.2",
    formFactor: "phone",
  };

  it("matches a booted device by criteria", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    const result = await callStartDevice({ platform: "android" });

    expect(result.deviceId).toBe("emulator-5554");
    expect(result.name).toBe("Pixel_7_API_34");
    expect(result.platform).toBe("android");
    expect(result.isReady).toBe(true);
    expect(result.source).toBe("booted");
    expect(result.osVersion).toBe("14");
    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe("string");
  });

  it("does not reach runner readiness or session binding after an externally cancelled boot", async () => {
    const controller = new AbortController();
    let resolveImages!: (images: DeviceInfo[]) => void;
    let markImageListingStarted!: () => void;
    const imageListingStarted = new Promise<void>(resolve => {
      markImageListingStarted = resolve;
    });
    const pendingImages = new Promise<DeviceInfo[]>(resolve => {
      resolveImages = resolve;
    });
    let runnerReadinessCalls = 0;
    let sessionIdCalls = 0;
    fakeDeviceUtils.listDeviceImages = async () => {
      markImageListingStarted();
      return pendingImages;
    };
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        runnerReadinessCalls++;
      },
      idGenerator: {
        next: () => {
          sessionIdCalls++;
          return `session-${sessionIdCalls}`;
        },
      },
    });
    registerDeviceTools();

    const start = callStartDevice({ platform: "android" }, controller.signal);
    await imageListingStarted;
    controller.abort();

    await expect(start).rejects.toThrow("startDevice cancelled while listing device images");
    resolveImages([androidImage]);
    await Promise.resolve();

    expect(runnerReadinessCalls).toBe(0);
    expect(sessionIdCalls).toBe(0);
  });

  it("sources the fallback sessionId from the injected IdGenerator", async () => {
    // Daemon is not initialized here, so the session UUID is minted directly by
    // the injected generator rather than the pool — proving the randomUUID() call
    // was routed onto the IdGenerator seam (issue #3511).
    setDeviceToolsDependencies({ idGenerator: new CountingIdGenerator("session") });
    registerDeviceTools();

    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    const result = await callStartDevice({ platform: "android" });

    expect(result.sessionId).toBe("session-1");
  });

  it("fails closed on an unusable iOS runner override, before touching the cached runner (#4221)", async () => {
    // Use the DEFAULT ensureCtrlProxyReady (not the beforeEach stub) so the real
    // fail-closed check runs. It sits at the top of that function, before any
    // manager access, so a directory-valued override rejects without booting a
    // real CtrlProxy.
    resetDeviceToolsDependencies();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceUtils,
      deviceMatcherFactory: () => fakeMatcher,
      notifyResourcesChanged: async () => {},
      timer: new FakeTimer(),
      // deliberately no ensureCtrlProxyReady -> default closure with the check
    });
    registerDeviceTools();

    fakeDeviceUtils.setBootedDevices("ios", [iosDevice]);
    fakeMatcher.setBootedResult(iosDevice);

    const original = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = os.tmpdir(); // a directory
    try {
      await expect(callStartDevice({ platform: "ios" })).rejects.toThrow(/BUNDLE_PATH.*unusable|directory|runnable .ipa/);
    } finally {
      if (original === undefined) {
        delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
      } else {
        process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = original;
      }
    }
  });

  it("waits for readiness before returning a matched booted device", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    const result = await callStartDevice({ platform: "android", timeoutMs: 42_000 });

    expect(result.deviceId).toBe("emulator-5554");
    expect(result.source).toBe("booted");
    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      "waitForDeviceReady:Pixel_7_API_34:42000",
    );
  });

  it("falls through to image when no booted device matches", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(androidImage);

    const result = await callStartDevice({ platform: "android" });

    expect(result.deviceId).toBeDefined();
    expect(result.source).toBe("cold-boot");
    expect(fakeDeviceUtils.wasMethodCalled("startDevice")).toBe(true);
  });

  it("tracks the process handle for a public Android cold boot", async () => {
    const recoveryKeys = [
      "AUTOMOBILE_ANDROID_REBOOT_ON_DEATH",
      "AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH",
    ] as const;
    const originalRecoveryEnv = new Map(
      recoveryKeys.map(key => [key, process.env[key]])
    );
    for (const key of recoveryKeys) {
      delete process.env[key];
    }

    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils
    );
    DaemonState.getInstance().initialize(daemonSessionManager, pool);

    const coldBootImage = { ...androidImage, deviceId: androidDevice.deviceId };
    const childProcess = new FakeExitChildProcess();
    fakeDeviceUtils.setDeviceImages("android", [coldBootImage]);
    fakeDeviceUtils.setMockChildProcess(
      coldBootImage.name,
      childProcess as unknown as ChildProcess
    );
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(coldBootImage);

    try {
      const result = await callStartDevice({ platform: "android" });
      expect(daemonSessionManager.getSession(result.sessionId as string)).not.toBeNull();

      childProcess.emit("exit", 1, null);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      expect(daemonSessionManager.getSession(result.sessionId as string)).toBeNull();
      expect(pool.getDevice(androidDevice.deviceId)).toBeNull();
    } finally {
      for (const key of recoveryKeys) {
        const original = originalRecoveryEnv.get(key);
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }
    }
  });

  it("reserves a public cold boot before resource notifications", async () => {
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const readyDeviceIds: string[] = [];
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
      undefined,
      undefined,
      undefined,
      undefined,
      deviceId => readyDeviceIds.push(deviceId)
    );
    DaemonState.getInstance().initialize(daemonSessionManager, pool);

    const coldBootImage = { ...androidImage, deviceId: androidDevice.deviceId };
    fakeDeviceUtils.setDeviceImages("android", [coldBootImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(coldBootImage);

    let releaseResources!: () => void;
    const resourcesStarted = new Promise<void>(resolve => {
      releaseResources = resolve;
    });
    let signalResourcesStarted!: () => void;
    const waitForResources = new Promise<void>(resolve => {
      signalResourcesStarted = resolve;
    });
    setDeviceToolsDependencies({
      idGenerator: new CountingIdGenerator("session"),
      notifyResourcesChanged: async () => {
        signalResourcesStarted();
        await resourcesStarted;
      },
    });

    const start = callStartDevice({ platform: "android" });
    await waitForResources;
    try {
      expect(readyDeviceIds).toEqual(["emulator-5554"]);
      expect(pool.getDevice("emulator-5554")?.status).toBe("busy");
      expect(pool.getDevice("emulator-5554")?.sessionId).toBe("session-1");
      expect(daemonSessionManager.getSession("session-1")).not.toBeNull();
    } finally {
      releaseResources();
      const result = await start;
      expect(result.sessionId).toBe("session-1");
    }
  });

  it("reserves a pooled device while runner readiness is in flight", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.initializeWithDevices([androidDevice]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    let releaseReadiness!: () => void;
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    let readinessStarted!: () => void;
    const waitForReadiness = new Promise<void>((resolve) => {
      readinessStarted = resolve;
    });
    setDeviceToolsDependencies({
      timer,
      idGenerator: new CountingIdGenerator("session"),
      ensureCtrlProxyReady: async () => {
        readinessStarted();
        await readinessGate;
      },
    });
    registerDeviceTools();

    const start = callStartDevice({ platform: "android" });
    await waitForReadiness;
    expect(pool.getIdleDevices()).toEqual([]);
    await expect(pool.assignDeviceToSession("competing-session", "android")).rejects.toThrow(
      /Timed out waiting for device/,
    );
    expect(pool.getDevice(androidDevice.deviceId)?.sessionId).toBeNull();

    releaseReadiness();
    const result = await start;
    expect(result.sessionId).toBe("session-1");
    expect(pool.getDevice(androidDevice.deviceId)?.sessionId).toBe("session-1");
  });

  it("releases a pooled-device reservation when runner readiness fails", async () => {
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    await pool.initializeWithDevices([androidDevice]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);
    setDeviceToolsDependencies({
      timer,
      ensureCtrlProxyReady: async () => {
        throw new Error("runner unavailable");
      },
    });
    registerDeviceTools();

    await expect(callStartDevice({ platform: "android" })).rejects.toThrow("runner unavailable");

    expect(pool.getIdleDevices().map((device) => device.id)).toEqual([androidDevice.deviceId]);
    expect(pool.getDevice(androidDevice.deviceId)?.sessionId).toBeNull();
  });

  it("cold-boots without a process handle (adopted device: startDevice returns null)", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(androidImage);
    // startEmulator adopts an already-running/starting AVD it did not spawn, so
    // it returns null (#3938). The response must still build — bootAndRespond
    // reads childProcess?.pid, which must tolerate a null handle without throwing.
    fakeDeviceUtils.setMockChildProcess(androidImage.name, null);

    const result = await callStartDevice({ platform: "android" });

    expect(result.source).toBe("cold-boot");
    expect(result.processId).toBeUndefined();
  });

  it("cancels the boot (kills the start handle) when cold-boot readiness fails", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(androidImage);

    // A freshly-spawned device hands back a real handle; readiness then fails.
    // The boot must be torn back down via handle.kill() rather than left
    // mid-boot (issue #3952).
    let killed = false;
    fakeDeviceUtils.setMockChildProcess(androidImage.name, {
      kill: (): boolean => { killed = true; return true; },
      pid: 4242,
    } as any);
    fakeDeviceUtils.setWaitForDeviceReadyError(new Error("readiness timeout"));

    await expect(callStartDevice({ platform: "android" })).rejects.toThrow("readiness timeout");
    expect(killed).toBe(true);
  });

  it("does not kill an adopted device (null handle) when readiness fails", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(androidImage);

    // Adopted device: startDevice returned null, so there is nothing to kill.
    // The failure must still propagate without a null-deref crash (issue #3952).
    fakeDeviceUtils.setMockChildProcess(androidImage.name, null);
    fakeDeviceUtils.setWaitForDeviceReadyError(new Error("readiness timeout"));

    await expect(callStartDevice({ platform: "android" })).rejects.toThrow("readiness timeout");
  });

  it("cancels an unowned cold boot when runner readiness fails", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(androidImage);
    let killed = false;
    fakeDeviceUtils.setMockChildProcess(androidImage.name, {
      kill: (): boolean => {
        killed = true;
        return true;
      },
      pid: 4242,
    } as any);
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        throw new Error("runner unavailable");
      },
    });
    registerDeviceTools();

    await expect(callStartDevice({ platform: "android" })).rejects.toThrow(
      "runner unavailable",
    );
    expect(killed).toBe(true);
  });

  it("does not kill a shared cold boot after its process ownership transfers", async () => {
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    DaemonState.getInstance().initialize(daemonSessionManager, pool);

    const coldBootImage = { ...androidImage, deviceId: androidDevice.deviceId };
    const childProcess = new FakeExitChildProcess();
    fakeDeviceUtils.setDeviceImages("android", [coldBootImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(coldBootImage);
    fakeDeviceUtils.setMockChildProcess(
      coldBootImage.name,
      childProcess as unknown as ChildProcess,
    );

    const originalStartDevice = fakeDeviceUtils.startDevice.bind(fakeDeviceUtils);
    let startCount = 0;
    fakeDeviceUtils.startDevice = async (...args) => {
      startCount++;
      const handle = await originalStartDevice(...args);
      return startCount === 1 ? handle : null;
    };

    const originalWaitForDeviceReady = fakeDeviceUtils.waitForDeviceReady.bind(fakeDeviceUtils);
    let releaseOwnerReadiness!: () => void;
    const ownerReadinessGate = new Promise<void>((resolve) => {
      releaseOwnerReadiness = resolve;
    });
    let signalOwnerReadiness!: () => void;
    const ownerReadinessStarted = new Promise<void>((resolve) => {
      signalOwnerReadiness = resolve;
    });
    fakeDeviceUtils.waitForDeviceReady = async (device, timeoutMs, handle) => {
      if (handle === childProcess) {
        signalOwnerReadiness();
        await ownerReadinessGate;
      }
      return await originalWaitForDeviceReady(device, timeoutMs, handle);
    };

    const ownerStart = callStartDevice({ platform: "android" });
    await ownerReadinessStarted;
    const adopterResult = await callStartDevice({ platform: "android" });

    releaseOwnerReadiness();
    await expect(ownerStart).rejects.toThrow(/Freshly started device .* assigned to session/);

    expect(adopterResult.sessionId).toBeDefined();
    expect(childProcess.killed).toBe(false);
    expect(pool.getDevice(androidDevice.deviceId)?.sessionId).toBe(adopterResult.sessionId);
  });

  it("does not kill a transferred cold boot when autolock rejects the later owner", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    DaemonState.getInstance().initialize(daemonSessionManager, pool);

    const coldBootImage = { ...androidImage, deviceId: androidDevice.deviceId };
    const childProcess = new FakeExitChildProcess();
    fakeDeviceUtils.setDeviceImages("android", [coldBootImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(coldBootImage);
    fakeDeviceUtils.setMockChildProcess(
      coldBootImage.name,
      childProcess as unknown as ChildProcess,
    );

    const originalStartDevice = fakeDeviceUtils.startDevice.bind(fakeDeviceUtils);
    let startCount = 0;
    fakeDeviceUtils.startDevice = async (...args) => {
      startCount++;
      const handle = await originalStartDevice(...args);
      return startCount === 1 ? handle : null;
    };

    const originalWaitForDeviceReady = fakeDeviceUtils.waitForDeviceReady.bind(fakeDeviceUtils);
    let releaseOwnerReadiness!: () => void;
    const ownerReadinessGate = new Promise<void>((resolve) => {
      releaseOwnerReadiness = resolve;
    });
    let signalOwnerReadiness!: () => void;
    const ownerReadinessStarted = new Promise<void>((resolve) => {
      signalOwnerReadiness = resolve;
    });
    fakeDeviceUtils.waitForDeviceReady = async (device, timeoutMs, handle) => {
      if (handle === childProcess) {
        signalOwnerReadiness();
        await ownerReadinessGate;
      }
      return await originalWaitForDeviceReady(device, timeoutMs, handle);
    };

    const ownerStart = callStartDevice({ platform: "android", __mcpSessionId: "owner" });
    await ownerReadinessStarted;
    const adopterResult = await callStartDevice({ platform: "android", __mcpSessionId: "adopter" });

    releaseOwnerReadiness();
    await expect(ownerStart).rejects.toThrow(/Freshly started device .* assigned to session/);

    expect(adopterResult.sessionId).toBeDefined();
    expect(childProcess.killed).toBe(false);
    expect(pool.getDevice(androidDevice.deviceId)?.sessionId).toBe(adopterResult.sessionId);
  });

  it("passes timeout to the cold boot start operation", async () => {
    fakeDeviceUtils.setBootedDevices("ios", []);
    fakeDeviceUtils.setDeviceImages("ios", [{
      name: "iPhone 15",
      platform: "ios",
      deviceId: "ABCD-1234",
      isRunning: false,
      osVersion: "17.2",
    }]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult({
      name: "iPhone 15",
      platform: "ios",
      deviceId: "ABCD-1234",
      isRunning: false,
      osVersion: "17.2",
    });

    const result = await callStartDevice({ platform: "ios", timeoutMs: 30_000 });

    expect(result.source).toBe("cold-boot");
    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      "startDevice:iPhone 15:30000",
    );
    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      "waitForDeviceReady:iPhone 15:30000",
    );
  });

  it("passes the default timeout to cold boot when timeout is omitted", async () => {
    fakeDeviceUtils.setBootedDevices("ios", []);
    const iosImage: DeviceInfo = {
      name: "iPhone 15",
      platform: "ios",
      deviceId: "ABCD-1234",
      isRunning: false,
      osVersion: "17.2",
    };
    fakeDeviceUtils.setDeviceImages("ios", [iosImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(iosImage);

    const result = await callStartDevice({ platform: "ios" });

    expect(result.source).toBe("cold-boot");
    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      `startDevice:iPhone 15:${DEFAULT_DEVICE_READY_TIMEOUT_MS}`,
    );
    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      `waitForDeviceReady:iPhone 15:${DEFAULT_DEVICE_READY_TIMEOUT_MS}`,
    );
  });

  it("finds device by direct deviceId", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);

    const result = await callStartDevice({
      platform: "android",
      deviceId: "emulator-5554",
    });

    expect(result.deviceId).toBe("emulator-5554");
    expect(result.source).toBe("booted");
  });

  it("waits for readiness before returning a direct deviceId match", async () => {
    fakeDeviceUtils.setBootedDevices("ios", [iosDevice]);

    const result = await callStartDevice({
      platform: "ios",
      deviceId: "ABCD-1234",
      timeoutMs: 30_000,
    });

    expect(result.deviceId).toBe("ABCD-1234");
    expect(result.source).toBe("booted");
    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      "waitForDeviceReady:iPhone 15:30000",
    );
  });

  it("rejects a running-device identity mismatch before runner readiness", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeDeviceUtils.waitForDeviceReady = async () => ({
      ...androidDevice,
      deviceId: "emulator-5556",
    });

    await expect(callStartDevice({
      platform: "android",
      deviceId: "emulator-5554",
    })).rejects.toThrow(/requested=.*emulator-5554.*resolved=.*emulator-5556/);
  });

  it("rejects an iOS cold-boot UDID mismatch before binding a session", async () => {
    const image: DeviceInfo = {
      name: "iPhone 15",
      platform: "ios",
      deviceId: "REQUESTED-UDID",
      isRunning: false,
    };
    fakeDeviceUtils.setDeviceImages("ios", [image]);
    fakeMatcher.setImageResult(image);
    fakeDeviceUtils.waitForDeviceReady = async () => ({
      name: image.name,
      platform: "ios",
      deviceId: "OTHER-UDID",
    });

    await expect(callStartDevice({
      platform: "ios",
      deviceId: "REQUESTED-UDID",
    })).rejects.toThrow(/phase=pool-match.*UDID differs/);
  });

  it("passes the request runner budget and shared total deadline to readiness", async () => {
    const readinessRequests: Array<{
      totalDeadlineMs: number;
      readinessTimeoutMs: number;
      requestedIdentity: string;
    }> = [];
    const timer = new FakeTimer();
    timer.advanceTime(1_000);
    setDeviceToolsDependencies({
      timer,
      ensureCtrlProxyReady: async request => {
        readinessRequests.push(request);
      },
    });
    registerDeviceTools();
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    await callStartDevice({
      platform: "android",
      deviceId: androidDevice.deviceId,
      timeoutMs: 60_000,
      runnerReadinessTimeoutMs: 15_000,
    });

    expect(readinessRequests).toEqual([expect.objectContaining({
      totalDeadlineMs: 61_000,
      readinessTimeoutMs: 15_000,
      requestedIdentity: "platform=android deviceId=emulator-5554",
    })]);
  });

  it("uses an explicit total timeout for readiness when no phase override is supplied", async () => {
    const readinessRequests: Array<{
      totalDeadlineMs: number;
      readinessTimeoutMs: number;
    }> = [];
    const timer = new FakeTimer();
    timer.advanceTime(1_000);
    setDeviceToolsDependencies({
      timer,
      ensureCtrlProxyReady: async request => {
        readinessRequests.push(request);
      },
    });
    registerDeviceTools();
    fakeDeviceUtils.setBootedDevices("ios", [iosDevice]);
    fakeMatcher.setBootedResult(iosDevice);

    await callStartDevice({
      platform: "ios",
      deviceId: iosDevice.deviceId,
      timeoutMs: 300_000,
    });

    expect(readinessRequests).toEqual([expect.objectContaining({
      totalDeadlineMs: 301_000,
      readinessTimeoutMs: 300_000,
    })]);
  });

  it("boots image when deviceId matches an image name", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);

    const result = await callStartDevice({
      platform: "android",
      deviceId: "Pixel_7_API_34",
    });

    expect(result.source).toBe("cold-boot");
    expect(fakeDeviceUtils.wasMethodCalled("startDevice")).toBe(true);
  });

  it("throws when deviceId not found", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", []);

    await expect(
      callStartDevice({ platform: "android", deviceId: "nonexistent" })
    ).rejects.toThrow(/not found/);
  });

  it("throws when no device matches criteria", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(null);

    await expect(
      callStartDevice({ platform: "android", minOsVersion: "99" })
    ).rejects.toThrow(/No android device matching criteria/);
  });

  it("skips booted devices when preferRunning is false", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setImageResult(androidImage);

    const result = await callStartDevice({
      platform: "android",
      preferRunning: false,
    });

    expect(result.source).toBe("cold-boot");
    expect(fakeDeviceUtils.wasMethodCalled("startDevice")).toBe(true);
  });

  it("waits for readiness before returning a matched running image", async () => {
    const runningImage: DeviceInfo = {
      ...androidImage,
      deviceId: "emulator-5554",
      isRunning: true,
    };
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeDeviceUtils.setDeviceImages("android", [runningImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(runningImage);

    const result = await callStartDevice({
      platform: "android",
      preferRunning: false,
      timeoutMs: 15_000,
    });

    expect(result.deviceId).toBe("emulator-5554");
    expect(result.source).toBe("booted");
    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      "waitForDeviceReady:Pixel_7_API_34:15000",
    );
  });

  it("returns structured metadata with screen size", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    const result = await callStartDevice({ platform: "android" });

    expect(result.formFactor).toBe("phone");
    expect(result.screenSize).toEqual({ width: 1080, height: 2400 });
  });

  it("handles iOS devices correctly", async () => {
    fakeDeviceUtils.setBootedDevices("ios", [iosDevice]);
    fakeMatcher.setBootedResult(iosDevice);

    const result = await callStartDevice({ platform: "ios" });

    expect(result.deviceId).toBe("ABCD-1234");
    expect(result.platform).toBe("ios");
    expect(result.osVersion).toBe("17.2");
  });

  it("requires iOS deviceId for cold boot", async () => {
    const iosImageNoId: DeviceInfo = {
      name: "iPhone 15",
      platform: "ios",
      isRunning: false,
    };
    fakeDeviceUtils.setBootedDevices("ios", []);
    fakeDeviceUtils.setDeviceImages("ios", [iosImageNoId]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(iosImageNoId);

    await expect(
      callStartDevice({ platform: "ios" })
    ).rejects.toThrow(/UDID/);
  });

  it("accepts legacy nested device payloads", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    const result = await callStartDevice({
      device: {
        name: "Pixel_7_API_34",
        platform: "android",
      },
    });

    expect(result.deviceId).toBe("emulator-5554");
    expect(result.source).toBe("booted");
  });

  it("prefers top-level values over legacy nested device payload values", () => {
    const parsed = startDeviceSchema.parse({
      platform: "ios",
      device: {
        platform: "android",
        name: "Pixel_7_API_34",
      },
    });

    expect(parsed.platform).toBe("ios");
    expect(parsed.name).toBe("Pixel_7_API_34");
  });

  it("bounds runner readiness timeout overrides", () => {
    expect(() => startDeviceSchema.parse({
      platform: "android",
      runnerReadinessTimeoutMs: MIN_RUNNER_READINESS_TIMEOUT_MS - 1,
    })).toThrow();
    expect(() => startDeviceSchema.parse({
      platform: "android",
      runnerReadinessTimeoutMs: MAX_RUNNER_READINESS_TIMEOUT_MS + 1,
    })).toThrow();
    expect(() => startDeviceSchema.parse({
      platform: "android",
      timeoutMs: MAX_DEVICE_READY_TIMEOUT_MS + 1,
    })).toThrow();
  });

  it("prefers deviceId over name when enriching booted device metadata", async () => {
    const bootedDuplicateName: BootedDevice = {
      name: "iPhone 15",
      platform: "ios",
      deviceId: "UDID-17-2",
    };

    fakeDeviceUtils.setBootedDevices("ios", [bootedDuplicateName]);
    fakeDeviceUtils.setDeviceImages("ios", [
      {
        name: "iPhone 15",
        platform: "ios",
        deviceId: "UDID-18-0",
        isRunning: false,
        osVersion: "18.0",
      },
      {
        name: "iPhone 15",
        platform: "ios",
        deviceId: "UDID-17-2",
        isRunning: true,
        osVersion: "17.2",
      },
    ]);
    fakeMatcher.setBootedResult({
      ...bootedDuplicateName,
      osVersion: "17.2",
    });

    const result = await callStartDevice({ platform: "ios" });

    expect(result.deviceId).toBe("UDID-17-2");
    expect(result.osVersion).toBe("17.2");
  });

  it("registers the generated autolock session for the MCP session", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(daemonSessionManager, "daemon-session", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([androidDevice]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);

    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    const result = await callStartDevice({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
    });

    expect(typeof result.sessionId).toBe("string");
    expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBe(result.sessionId);
  });

  it("rejects stale pooled platform metadata before session binding", async () => {
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    await pool.initializeWithDevices([{
      ...iosDevice,
      deviceId: androidDevice.deviceId,
    }]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    await expect(callStartDevice({
      platform: "android",
      deviceId: androidDevice.deviceId,
    })).rejects.toThrow(/phase=pool-match.*stale pool identity conflicts/);
    expect(pool.getDevice(androidDevice.deviceId)?.sessionId).toBeNull();
  });

  it("rejects a stale same-platform pool identity before session reuse", async () => {
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    fakeDeviceUtils.setBootedDevices("android", [{
      ...androidDevice,
      name: "Old_Pixel_AVD",
    }]);
    await pool.initializeWithDevices([{
      ...androidDevice,
      name: "Old_Pixel_AVD",
    }]);
    await pool.bindOrReuseDeviceSession(
      "stale-session",
      androidDevice.deviceId,
      "android",
    );
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    await expect(callStartDevice({
      platform: "android",
      deviceId: androidDevice.deviceId,
    })).rejects.toThrow(/phase=pool-match.*stale pool identity conflicts/);
    expect(pool.getDevice(androidDevice.deviceId)?.sessionId).toBe("stale-session");
  });

  it("reuses the returned sessionId for repeated startDevice calls when autolock is disabled", async () => {
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(daemonSessionManager, "daemon-session", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([iosDevice]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);

    fakeDeviceUtils.setBootedDevices("ios", [iosDevice]);
    fakeMatcher.setBootedResult(iosDevice);

    const result = await callStartDevice({ platform: "ios" });
    const repeated = await callStartDevice({ platform: "ios" });

    expect(typeof result.sessionId).toBe("string");
    expect(repeated.sessionId).toBe(result.sessionId);
    const session = daemonSessionManager.getSession(result.sessionId as string);
    expect(session).not.toBeNull();
    expect(session!.assignedDevice).toBe(iosDevice.deviceId);
    expect(session!.platform).toBe("ios");
    expect(pool.getDevice(iosDevice.deviceId)?.sessionId).toBe(result.sessionId);
    expect(pool.getDevice(iosDevice.deviceId)?.status).toBe("busy");
  });
});
