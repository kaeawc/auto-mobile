import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setDeviceToolsDependencies, resetDeviceToolsDependencies, registerDeviceTools, startDeviceSchema } from "../../src/server/deviceTools";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";

const AUTOLOCK_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
] as const;

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
    });

    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    clearAutolockEnv();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
  });

  async function callStartDevice(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = ToolRegistry.getTool("startDevice");
    if (!tool) {throw new Error("startDevice not registered");}
    const result = await tool.handler(args);
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
    daemonSessionManager = new SessionManager(timer);
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

  it("reuses the returned sessionId for repeated startDevice calls when autolock is disabled", async () => {
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer);
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
