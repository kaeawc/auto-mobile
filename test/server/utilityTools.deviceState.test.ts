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
    expect(() => setTool!.schema.parse({})).toThrow();
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
