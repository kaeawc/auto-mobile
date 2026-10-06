import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { ActionableError } from "../../src/models/ActionableError";

/**
 * #9945: in daemon mode a `deviceId` sent alongside a `sessionUuid` is a routing
 * hint that must name the session's own device (#8602), for EVERY device-aware
 * tool and not just `observe`. The check lives at the shared target-resolution
 * point (`resolveNormalExecutionTarget`), so a plain `registerDeviceAware` tool
 * gets it with no per-tool wiring.
 */
describe("ToolRegistry daemon session/deviceId routing contract (#9945)", () => {
  const androidA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };
  const androidB: BootedDevice = {
    name: "Pixel B",
    deviceId: "emulator-5556",
    platform: "android",
  };
  const sessionUuid = "session-on-a";

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;
  let originalToolCallRepository: unknown;
  let sessionManager: SessionManager;
  let restoreInventory: () => void;
  let seenDevices: string[];

  const routingSchema = z.object({
    sessionUuid: z.string().optional(),
    deviceId: z.string().optional(),
    device: z.string().optional(),
    platform: z.enum(["android", "ios"]).optional(),
  });

  function registerProbe(name: string): void {
    ToolRegistry.registerDeviceAware(name, `${name} probe`, routingSchema, async (device) => {
      seenDevices.push(device.deviceId);
      return { success: true };
    });
  }

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler(args);

  beforeEach(async () => {
    seenDevices = [];
    ToolRegistry.clearTools();
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);
    originalDeviceSessionManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", fakeDeviceSessionManager);
    originalToolCallRepository = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", {
      async recordToolCall(): Promise<void> {},
    });

    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA, androidB]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-routing", {
        timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession(sessionUuid, androidA.deviceId, "android");
    sessionManager.setDeviceReadiness(sessionUuid, "automationReady");
  });

  afterEach(() => {
    restoreInventory();
    Reflect.set(ToolRegistry, "deviceSessionManager", originalDeviceSessionManager);
    Reflect.set(ToolRegistry, "toolCallRepository", originalToolCallRepository);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("a device-aware tool rejects another device's deviceId and never runs the handler", async () => {
    registerProbe("tapProbe");
    let rejection: unknown;
    try {
      await call("tapProbe", { sessionUuid, deviceId: androidB.deviceId });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ActionableError);
    expect((rejection as ActionableError).message).toBe(
      `tapProbe deviceId '${androidB.deviceId}' does not match session '${sessionUuid}' device '${androidA.deviceId}'.`,
    );
    expect(seenDevices).toEqual([]);
    // The session stays on its own device; nothing was rebound to the hint.
    expect(sessionManager.getSession(sessionUuid)?.assignedDevice).toBe(androidA.deviceId);
  });

  test("the error text for observe is unchanged (same rule, tool name interpolated)", async () => {
    registerProbe("observe");
    await expect(call("observe", { sessionUuid, deviceId: androidB.deviceId })).rejects.toThrow(
      `observe deviceId '${androidB.deviceId}' does not match session '${sessionUuid}' device '${androidA.deviceId}'.`,
    );
  });

  test("a deviceId that matches the session's device still runs on it", async () => {
    registerProbe("tapProbe");
    await call("tapProbe", { sessionUuid, deviceId: androidA.deviceId });
    expect(seenDevices).toEqual([androidA.deviceId]);
  });

  test("a session call with no deviceId still runs on the session's device", async () => {
    registerProbe("tapProbe");
    await call("tapProbe", { sessionUuid });
    expect(seenDevices).toEqual([androidA.deviceId]);
  });

  test("a device label drops a stray deviceId, so multi-device plan steps are not rejected", async () => {
    registerProbe("tapProbe");
    sessionManager.setDeviceLabels(sessionUuid, { A: sessionUuid });
    await call("tapProbe", { sessionUuid, device: "A", deviceId: androidB.deviceId });
    expect(seenDevices).toEqual([androidA.deviceId]);
  });

  test("tools registered outside the device-aware pipeline may name any device", async () => {
    // setActiveDevice, startDevice, killDevice, listDevices and the other
    // `ToolRegistry.register` tools never reach target resolution.
    const seen: unknown[] = [];
    ToolRegistry.register("namesOtherDevice", "probe", routingSchema, async (args) => {
      seen.push(args.deviceId);
      return { success: true };
    });
    await call("namesOtherDevice", { sessionUuid, deviceId: androidB.deviceId });
    expect(seen).toEqual([androidB.deviceId]);
  });

  test("a deviceId without a session is still honored", async () => {
    registerProbe("tapProbe");
    await call("tapProbe", { deviceId: androidB.deviceId });
    expect(seenDevices).toEqual([androidB.deviceId]);
  });
});
