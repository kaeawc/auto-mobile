import { beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { AndroidDemoModeStatusBarController } from "../../src/features/utility/AndroidDemoModeStatusBarController";
import { InMemoryDemoAllowedReceipts } from "../../src/features/utility/DemoAllowedReceipts";
import { StatusBarOverrideRegistry } from "../../src/features/utility/StatusBarOverrideRegistry";
import type { BootedDevice, ExecResult } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";
import { createStatusBarHandler, type StatusBarArgs } from "../../src/server/statusBarTools";
import { statusBarResultSchema } from "../../src/server/statusBarToolOutputSchemas";
import { readUnknownStructuredField } from "../../src/utils/toolUtils";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeStatusBarController } from "../fakes/FakeStatusBarController";
import { FakeTimer } from "../fakes/FakeTimer";

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const okExec = (): ExecResult => ({
  stdout: "",
  stderr: "",
  toString: () => "",
  trim: () => "",
  includes: () => false,
});

const PHYSICAL_IOS: BootedDevice = {
  name: "iPhone",
  platform: "ios",
  deviceId: "00008110-001A2B3C4D5E6F70",
};

interface ToolResult {
  structuredContent: Record<string, unknown>;
  isError?: true;
}

describe("statusBar tool (#14105)", () => {
  let controller: FakeStatusBarController;
  let registry: StatusBarOverrideRegistry;
  let manager: SessionManager;
  let handler: ReturnType<typeof createStatusBarHandler>;

  const call = async (device: BootedDevice, args: Partial<StatusBarArgs>): Promise<ToolResult> => {
    const result = (await handler(device, args as StatusBarArgs)) as ToolResult;
    expect(() => statusBarResultSchema.parse(result.structuredContent)).not.toThrow();
    return result;
  };

  beforeEach(() => {
    controller = new FakeStatusBarController();
    registry = new StatusBarOverrideRegistry();
    manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    handler = createStatusBarHandler({
      controllerFor: (device) => (device === PHYSICAL_IOS ? null : controller),
      registry,
      sessionManager: () => manager,
    });
  });

  test("an override under a session is applied and owned by that session", async () => {
    await manager.createSession("session-1", ANDROID.deviceId, "android");
    const result = await call(ANDROID, {
      action: "override",
      time: "9:41",
      batteryLevel: 100,
      sessionUuid: "session-1",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      success: true,
      status: "applied",
      applied: ["time", "batteryLevel"],
      override: { time: "9:41", batteryLevel: 100 },
    });
    expect(controller.overrides).toEqual([{ time: "9:41", batteryLevel: 100 }]);
    expect(registry.get(ANDROID.deviceId)?.sessionId).toBe("session-1");
  });

  test("a sessionless override is applied but owned by no session", async () => {
    await call(ANDROID, { action: "override", wifiBars: 3 });
    expect(registry.get(ANDROID.deviceId)?.sessionId).toBeNull();
  });

  test("a session that does not hold the device is refused before any device command", async () => {
    await manager.createSession("session-1", "emulator-5556", "android");
    await expect(
      call(ANDROID, { action: "override", time: "9:41", sessionUuid: "session-1" }),
    ).rejects.toThrow("session is released, releasing, rebound, or replaced");
    expect(controller.overrides).toEqual([]);
    expect(registry.get(ANDROID.deviceId)).toBeNull();
  });

  test("fields the platform cannot set make the result partial", async () => {
    controller.unsupportedFields.add("operatorName");
    const result = await call(ANDROID, { action: "override", time: "9:41", operatorName: "X" });
    expect(result.structuredContent).toMatchObject({
      status: "partial",
      applied: ["time"],
      unsupported: ["operatorName"],
    });
  });

  test("override without fields, or clear/get with fields, is an error", async () => {
    const empty = await call(ANDROID, { action: "override" });
    expect(empty.isError).toBe(true);
    const clearWithFields = await call(ANDROID, { action: "clear", time: "9:41" });
    expect(clearWithFields.isError).toBe(true);
    expect(controller.overrides).toEqual([]);
    expect(controller.clears).toBe(0);
  });

  test("clear restores the live status bar and forgets the override", async () => {
    await call(ANDROID, { action: "override", time: "9:41" });
    const result = await call(ANDROID, { action: "clear" });
    expect(result.structuredContent).toMatchObject({ status: "cleared", override: null });
    expect(controller.clears).toBe(1);
    expect(registry.get(ANDROID.deviceId)).toBeNull();
  });

  test("get returns the recorded override and the platform readback", async () => {
    await manager.createSession("session-1", ANDROID.deviceId, "android");
    await call(ANDROID, { action: "override", time: "9:41", sessionUuid: "session-1" });
    const result = await call(ANDROID, { action: "get" });
    expect(result.structuredContent).toMatchObject({
      status: "current",
      override: { time: "9:41" },
      ownerSessionId: "session-1",
      raw: "readback",
    });
  });

  test("physical iOS returns a typed unsupported result", async () => {
    const result = await call(PHYSICAL_IOS, { action: "override", time: "9:41" });
    expect(result.structuredContent).toMatchObject({ success: false, status: "unsupported" });
  });
  describe("a rejected override records nothing (#17054)", () => {
    test("reject-then-get on a real demo-mode controller reports no override", async () => {
      const adbCalls: string[][] = [];
      const android = new AndroidDemoModeStatusBarController(
        {
          execute: async (args: string[]) => {
            adbCalls.push(args);
            return okExec();
          },
        },
        ANDROID.deviceId,
        new InMemoryDemoAllowedReceipts(),
      );
      handler = createStatusBarHandler({
        controllerFor: () => android,
        registry,
        sessionManager: () => manager,
      });
      await manager.createSession("session-1", ANDROID.deviceId, "android");
      await expect(
        call(ANDROID, { action: "override", time: "1234", sessionUuid: "session-1" }),
      ).rejects.toThrow("H:MM");
      adbCalls.length = 0;
      const result = await call(ANDROID, { action: "get" });
      expect(result.structuredContent).toMatchObject({
        message: "No status bar override recorded",
        override: null,
        ownerSessionId: null,
      });
      expect(registry.get(ANDROID.deviceId)).toBeNull();
    });

    test("a sessionless rejection leaves the store empty", async () => {
      controller.overrideError = new ActionableError("adb shell am broadcast failed: boom");
      await expect(call(ANDROID, { action: "override", wifiBars: 3 })).rejects.toThrow("boom");
      const result = await call(ANDROID, { action: "get" });
      expect(result.structuredContent).toMatchObject({ override: null, ownerSessionId: null });
    });

    test("a rejection keeps the previously applied override, unmerged", async () => {
      await manager.createSession("session-1", ANDROID.deviceId, "android");
      await call(ANDROID, { action: "override", time: "9:41", sessionUuid: "session-1" });
      controller.overrideError = new ActionableError("refused");
      await expect(
        call(ANDROID, { action: "override", batteryLevel: 5, sessionUuid: "session-1" }),
      ).rejects.toThrow("refused");
      const result = await call(ANDROID, { action: "get" });
      expect(readUnknownStructuredField(result, "override")).toEqual({ time: "9:41" });
      expect(readUnknownStructuredField(result, "ownerSessionId")).toBe("session-1");
    });

    test("a rejection by another caller keeps the earlier owner", async () => {
      await manager.createSession("session-1", ANDROID.deviceId, "android");
      await call(ANDROID, { action: "override", time: "9:41", sessionUuid: "session-1" });
      controller.overrideError = new ActionableError("refused");
      await expect(call(ANDROID, { action: "override", wifiBars: 1 })).rejects.toThrow("refused");
      expect(registry.get(ANDROID.deviceId)?.sessionId).toBe("session-1");
      expect(registry.get(ANDROID.deviceId)?.overrides).toEqual({ time: "9:41" });
    });

    test("get reports only the fields the platform applied", async () => {
      controller.unsupportedFields.add("operatorName");
      const set = await call(ANDROID, { action: "override", time: "9:41", operatorName: "X" });
      expect(set.structuredContent).toMatchObject({ override: { time: "9:41" } });
      const result = await call(ANDROID, { action: "get" });
      expect(readUnknownStructuredField(result, "override")).toEqual({ time: "9:41" });
    });

    test("an override that applied nothing records nothing", async () => {
      controller.unsupportedFields.add("operatorName");
      const set = await call(ANDROID, { action: "override", operatorName: "X" });
      expect(set.structuredContent).toMatchObject({ applied: [], override: null });
      expect(registry.get(ANDROID.deviceId)).toBeNull();
    });
  });
});
