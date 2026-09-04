import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { BootedDevice, Platform } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

const createBootedDevice = (
  deviceId: string,
  platform: Platform = "android",
  name?: string,
): BootedDevice => ({
  name: name ?? deviceId,
  platform,
  deviceId,
});

describe("device state tools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerUtilityTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
  });

  test("registers getDeviceState and setDeviceState schemas", () => {
    const getTool = ToolRegistry.getTool("getDeviceState");
    const setTool = ToolRegistry.getTool("setDeviceState");

    expect(getTool).toBeDefined();
    expect(getTool?.requiresDevice).toBe(true);
    expect(() => getTool!.schema.parse({ include: ["doNotDisturb"] })).not.toThrow();
    expect(() => getTool!.schema.parse({ include: ["biometrics"] })).not.toThrow();

    expect(setTool).toBeDefined();
    expect(setTool?.requiresDevice).toBe(true);
    expect(() =>
      setTool!.schema.parse({
        doNotDisturb: { enabled: true },
      }),
    ).not.toThrow();
    expect(() =>
      setTool!.schema.parse({
        doNotDisturb: { mode: "priority" },
      }),
    ).not.toThrow();
    expect(() =>
      setTool!.schema.parse({
        biometrics: { enrollment: "not_enrolled" },
      }),
    ).not.toThrow();
    expect(() => setTool!.schema.parse({})).toThrow();

    // #6012: networkCondition is a first-class device-state field.
    expect(() => getTool!.schema.parse({ include: ["networkCondition"] })).not.toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { profile: "3g" } })).not.toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { cancel: true } })).not.toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { profile: "offline" } })).not.toThrow();
    // An empty networkCondition sub-object is not a request.
    expect(() => setTool!.schema.parse({ networkCondition: {} })).toThrow();
    // #6012 audit: falsey-only cancel/reset and TTL-only are NOT requests.
    expect(() => setTool!.schema.parse({ networkCondition: { cancel: false } })).toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { reset: false } })).toThrow();
    expect(() => setTool!.schema.parse({ networkCondition: { expiresInSeconds: 30 } })).toThrow();
    // packetLossPercent is a (backend-unsupported) request, so the schema accepts
    // it — the setter reports it unsupported rather than the schema rejecting it.
    expect(() =>
      setTool!.schema.parse({ networkCondition: { packetLossPercent: 20 } }),
    ).not.toThrow();
    expect(() =>
      setTool!.schema.parse({ networkCondition: { delayMs: 400, expiresInSeconds: 5 } }),
    ).not.toThrow();
  });

  test("threads networkCondition through the setDeviceState handler", async () => {
    // A physical Android device short-circuits to an unsupported result before
    // any adb call, so this proves the handler forwards networkCondition into
    // DeviceState.setState without needing a real device.
    const setTool = ToolRegistry.getTool("setDeviceState");
    const physicalAndroid = createBootedDevice("38290DLJG000XY", "android", "Pixel 8");

    const response = await setTool!.deviceAwareHandler!(physicalAndroid, {
      networkCondition: { profile: "3g" },
    });

    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedProfile: "3g",
    });
  });

  test("does not register a network restore slot for an unsupported (iOS) platform", async () => {
    // #6012 (review #2): the slot's presence is authoritative evidence a device
    // was shaped, so an unsupported platform — where setState applies nothing —
    // must not register one.
    const fakeTimer = new FakeTimer();
    const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    const devicePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      fakeTimer,
      new FakeInstalledAppsRepository(),
      new FakeDeviceManager([], []),
      new DefaultRetryExecutor(fakeTimer),
    );
    DaemonState.getInstance().initialize(sessionManager, devicePool);
    await sessionManager.createSession("ios-session", "sim-ios-1", "ios");

    const setTool = ToolRegistry.getTool("setDeviceState");
    await setTool!.deviceAwareHandler!(createBootedDevice("sim-ios-1", "ios", "iPhone 16"), {
      networkCondition: { profile: "3g" },
      sessionUuid: "ios-session",
    });

    expect(sessionManager.getNetworkCondition("ios-session")).toBeUndefined();
    sessionManager.stopCleanupTimer();
  });

  test("reads networkCondition through the getDeviceState handler on iOS", async () => {
    const getTool = ToolRegistry.getTool("getDeviceState");
    const iosSim = createBootedDevice("12345678-1234-1234-1234-123456789ABC", "ios", "iPhone 16");

    const response = await getTool!.deviceAwareHandler!(iosSim, {
      include: ["networkCondition"],
    });

    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
    });
  });

  test("setActiveDevice binds a refreshed session device in the pool", async () => {
    const fakeTimer = new FakeTimer();
    const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    const fakeDeviceManager = new FakeDeviceManager(
      [],
      [createBootedDevice("sim-new", "ios", "iPhone 16")],
    );
    const devicePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      fakeTimer,
      new FakeInstalledAppsRepository(),
      fakeDeviceManager,
      new DefaultRetryExecutor(fakeTimer),
    );
    DaemonState.getInstance().initialize(sessionManager, devicePool);

    const setActiveDevice = ToolRegistry.getTool("setActiveDevice");
    await setActiveDevice!.handler({
      deviceId: "sim-new",
      platform: "ios",
      sessionUuid: "session-1",
    });

    expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("sim-new");
    expect(devicePool.getDevice("sim-new")?.sessionId).toBe("session-1");
    expect(devicePool.getDevice("sim-new")?.status).toBe("busy");

    sessionManager.stopCleanupTimer();
  });

  test("setActiveDevice rejects devices owned by another live session", async () => {
    const fakeTimer = new FakeTimer();
    const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    const fakeDeviceManager = new FakeDeviceManager(
      [],
      [
        createBootedDevice("sim-a", "ios", "iPhone 15"),
        createBootedDevice("sim-b", "ios", "iPhone 16"),
      ],
    );
    const devicePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      fakeTimer,
      new FakeInstalledAppsRepository(),
      fakeDeviceManager,
      new DefaultRetryExecutor(fakeTimer),
    );
    await devicePool.initializeWithDevices([
      createBootedDevice("sim-a", "ios", "iPhone 15"),
      createBootedDevice("sim-b", "ios", "iPhone 16"),
    ]);
    await devicePool.bindOrReuseDeviceSession("session-a", "sim-a", "ios");
    await devicePool.bindOrReuseDeviceSession("session-b", "sim-b", "ios");
    DaemonState.getInstance().initialize(sessionManager, devicePool);

    const setActiveDevice = ToolRegistry.getTool("setActiveDevice");
    await expect(
      setActiveDevice!.handler({
        deviceId: "sim-b",
        platform: "ios",
        sessionUuid: "session-a",
      }),
    ).rejects.toThrow(/already assigned to session session-b/);

    expect(sessionManager.getSession("session-a")?.assignedDevice).toBe("sim-a");
    expect(devicePool.getDevice("sim-a")?.sessionId).toBe("session-a");
    expect(devicePool.getDevice("sim-b")?.sessionId).toBe("session-b");

    sessionManager.stopCleanupTimer();
  });
});
