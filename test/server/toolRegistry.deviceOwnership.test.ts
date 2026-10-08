import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry, type AuditRunnerInput } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";

/**
 * A device another live session holds runs device-aware tools only for its holder, as `input/*`
 * already enforces (#10698). An end-to-end run found `rotate` sent with the desktop observer's
 * sessionUuid (or none) and `deviceId` of an agent-held emulator running on it. Watching stays
 * allowed on any device (#10730). The real `rotate`, `tapOn`, `sendKeys` and `observe`
 * registrations run through the real ToolRegistry target resolution; a fake audit runner stands
 * in for the device handler so an admitted call records its target instead of touching a device.
 */
describe("ToolRegistry device ownership for tool calls (#10698, #10730)", () => {
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const agent = "agent-session";
  const observer = "d0000000-0000-4000-8000-000000000001";

  let ran: Array<{ name: string; deviceId: string }>;
  let originalDeviceSessionManager: unknown;
  let originalToolCallRepository: unknown;
  let originalNavigationRecorder: unknown;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler(args);

  async function refusal(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      await call(name, args);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  beforeEach(async () => {
    ran = [];
    ToolRegistry.clearTools();
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      auditRunner: {
        async run(input: AuditRunnerInput) {
          ran.push({ name: input.name, deviceId: input.device.deviceId });
          return { success: true };
        },
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
    });
    const fakeDeviceSessionManager = new FakeDeviceSessionManager();
    fakeDeviceSessionManager.setConnectedDevices([held, free]);
    originalDeviceSessionManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", fakeDeviceSessionManager);
    originalToolCallRepository = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall(): Promise<void> {} });
    originalNavigationRecorder = Reflect.get(ToolRegistry, "navigationToolCallRecorder");
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", { record: () => undefined });

    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [held, free]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "tool-call-ownership", {
        timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession(agent, held.deviceId, "android");
    sessionManager.setDeviceReadiness(agent, "automationReady");

    registerInteractionTools();
    registerObserveTools();
  });

  afterEach(() => {
    restorePipeline();
    Reflect.set(ToolRegistry, "deviceSessionManager", originalDeviceSessionManager);
    Reflect.set(ToolRegistry, "toolCallRepository", originalToolCallRepository);
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", originalNavigationRecorder);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  const mutatingCalls: Array<[string, Record<string, unknown>]> = [
    ["rotate", { orientation: "landscape" }],
    ["tapOn", { text: "OK", action: "tap" }],
    ["sendKeys", { text: "hello" }],
  ];

  for (const [name, args] of mutatingCalls) {
    test(`${name} from another session's sessionUuid is refused before any device work`, async () => {
      const error = await refusal(name, {
        ...args,
        platform: "android",
        sessionUuid: observer,
        deviceId: held.deviceId,
      });
      expect(error).toBeInstanceOf(InputDeviceOwnedError);
      expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect((error as Error).message).toBe(
        `${name} refused: device '${held.deviceId}' is held by another session. ` +
          `Session ${observer} does not hold it; acquire the device (setActiveDevice) and call ` +
          `the tool with that session's sessionUuid, or wait for the holder to release it.`,
      );
      expect(ran).toEqual([]);
      expect(sessionManager.getSessionForDevice(held.deviceId)).toBe(agent);
    });

    test(`a sessionless ${name} on a held device is refused`, async () => {
      const error = await refusal(name, { ...args, platform: "android", deviceId: held.deviceId });
      expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect((error as Error).message).toContain("The request carried no sessionUuid;");
      expect(ran).toEqual([]);
    });
  }

  test("the holder's own rotate runs on its device", async () => {
    await call("rotate", { orientation: "landscape", sessionUuid: agent, deviceId: held.deviceId });
    expect(ran).toEqual([{ name: "rotate", deviceId: held.deviceId }]);
  });

  test("a sessionless rotate on an unheld device still runs", async () => {
    await call("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: free.deviceId,
    });
    expect(ran).toEqual([{ name: "rotate", deviceId: free.deviceId }]);
  });

  test("observe on a device another session holds is allowed (watching is not use)", async () => {
    await call("observe", { platform: "android", deviceId: held.deviceId });
    expect(ran).toEqual([{ name: "observe", deviceId: held.deviceId }]);
  });

  test("the refusal reaches the client with the typed code", async () => {
    const error = await refusal("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: held.deviceId,
    });
    const shaped = shapeToolCallError(error, { toolName: "rotate", source: "MCP" });
    expect(JSON.parse(shaped.content[0].text)).toEqual({
      success: false,
      error: (error as Error).message,
      code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      deviceId: held.deviceId,
      retryable: false,
    });
  });
});
