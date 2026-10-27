import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toolIsError, toolStructured, toolText } from "../helpers/toolResponse";
import { appLifecycleResultSchema } from "../../src/server/appToolOutputSchemas";
import {
  appLifecycleSchema,
  registerAppTools,
  resetInstalledAppResourceRefresh,
  setInstalledAppResourceRefresh,
} from "../../src/server/appTools";
import type { AppLifecycleResult, BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models";
import type { AppLifecycleExecutionOptions } from "../../src/features/action/AppLifecycle";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "fake", name: "Fake", platform: "android" };
const appId = "com.example.app";
const args = { appId, action: "killBackgrounded" };
const successful: AppLifecycleResult = {
  success: true,
  supported: true,
  platform: "android",
  appId,
  action: "killBackgrounded",
  mechanism: "am-kill",
  pidBefore: 123,
  pidAfter: null,
  processReclaimed: true,
};

describe("appLifecycle registration and handler", () => {
  let refreshes: string[];
  beforeEach(() => {
    ToolRegistry.clearTools();
    refreshes = [];
    setInstalledAppResourceRefresh({
      invalidate: (id) => {
        refreshes.push(id);
      },
      notify: async () => {},
    });
    registerAppTools();
  });
  afterEach(() => {
    ToolRegistry.clearTools();
    resetInstalledAppResourceRefresh();
  });
  const handler = () => ToolRegistry.getTool("appLifecycle")!.deviceAwareHandler!;
  test("registered by default with output schema and strict input/action validation", () => {
    const tool = ToolRegistry.getTool("appLifecycle")!;
    expect(tool.defaultEnabled).toBe(true);
    expect(tool.outputSchema).toBe(appLifecycleResultSchema);
    expect(
      appLifecycleSchema.parse({ appId: " com.example.app ", action: "background" }),
    ).toMatchObject({ appId, action: "background" });
    for (const bad of [
      { ...args, unknown: true },
      { ...args, userId: 10 },
      { ...args, action: "foreground" },
      { ...args, action: "forceStop" },
      { ...args, appId: " " },
    ]) {
      expect(appLifecycleSchema.safeParse(bad).success).toBe(false);
    }
  });
  test("trimMemory takes an onTrimMemory level and forwards it (#14090)", async () => {
    expect(
      appLifecycleSchema.parse({ appId, action: "trimMemory", level: "COMPLETE" }),
    ).toMatchObject({ action: "trimMemory", level: "COMPLETE" });
    expect(
      appLifecycleSchema.safeParse({ appId, action: "trimMemory", level: "HIDDEN" }).success,
    ).toBe(false);
    let received: AppLifecycleExecutionOptions | undefined;
    ToolRegistry.clearTools();
    registerAppTools({
      appLifecycle: {
        createAppLifecycle: () => ({
          execute: async (_appId, action, options) => {
            received = options;
            return {
              ...successful,
              action,
              mechanism: "am-send-trim-memory",
              trimLevel: "COMPLETE",
              message: "Sent onTrimMemory(COMPLETE)",
            };
          },
        }),
      },
    });
    const response = await handler()(device, { appId, action: "trimMemory", level: "COMPLETE" });
    expect(received?.trimLevel).toBe("COMPLETE");
    expect(appLifecycleResultSchema.safeParse(toolStructured(response)).success).toBe(true);
    expect(toolStructured(response)).toMatchObject({ message: "Sent onTrimMemory(COMPLETE)" });
    expect(refreshes).toEqual([]);
  });
  test("structured success forwards options and refreshes only after actual mutation", async () => {
    const controller = new AbortController();
    ToolRegistry.clearTools();
    registerAppTools({
      appLifecycle: {
        createAppLifecycle: (receivedDevice) => ({
          execute: async (receivedAppId, action, options) => {
            expect(receivedDevice).toEqual(device);
            expect(receivedAppId).toBe(appId);
            expect(action).toBe("killBackgrounded");
            expect(options?.signal).toBe(controller.signal);
            options?.onMutation?.();
            return successful;
          },
        }),
      },
    });
    const response = await handler()(device, args, undefined, controller.signal);
    expect(toolStructured(response)).toMatchObject(successful);
    expect(appLifecycleResultSchema.safeParse(toolStructured(response)).success).toBe(true);
    expect(refreshes).toEqual([device.deviceId]);
  });
  for (const failure of [
    {
      ...successful,
      success: false,
      errorCode: "app_in_foreground" as const,
      error: "call background first",
    },
    {
      ...successful,
      success: false,
      supported: false,
      mechanism: "unsupported" as const,
      error: "iOS unsupported",
    },
  ]) {
    test(`typed ${failure.error} result returns message without refresh`, async () => {
      ToolRegistry.clearTools();
      registerAppTools({
        appLifecycle: {
          createAppLifecycle: () => ({ execute: async () => failure }),
        },
      });
      const response = await handler()(device, args);
      expect(toolStructured(response)).toMatchObject({ success: false, message: failure.error });
      expect(toolIsError(response)).toBe(true);
      expect(toolText(response)).toBe(JSON.stringify({ ...failure, message: failure.error }));
      expect(refreshes).toEqual([]);
    });
  }
  test("already backgrounded success has no resource mutation", async () => {
    ToolRegistry.clearTools();
    registerAppTools({
      appLifecycle: {
        createAppLifecycle: () => ({
          execute: async () => ({
            ...successful,
            action: "background",
            mechanism: "home",
            pid: 123,
          }),
        }),
      },
    });
    await handler()(device, { appId, action: "background" });
    expect(refreshes).toEqual([]);
  });
  test("not-reclaimed advisory message is preserved", async () => {
    ToolRegistry.clearTools();
    registerAppTools({
      appLifecycle: {
        createAppLifecycle: () => ({
          execute: async () => ({
            ...successful,
            processReclaimed: false,
            pidAfter: 123,
            message: "Process was not reclaimed",
          }),
        }),
      },
    });
    expect(toolStructured(await handler()(device, args))).toMatchObject({
      message: "Process was not reclaimed",
      success: true,
    });
  });
  test("typed kill failure after dispatch refreshes and does not throw", async () => {
    ToolRegistry.clearTools();
    registerAppTools({
      appLifecycle: {
        createAppLifecycle: () => ({
          execute: async (_app, _action, options) => {
            options?.onMutation?.();
            return {
              ...successful,
              success: false,
              errorCode: "kill_failed",
              error: "kill failed",
            };
          },
        }),
      },
    });
    expect(toolStructured(await handler()(device, args))).toMatchObject({
      message: "kill failed",
      success: false,
    });
    expect(refreshes).toEqual([device.deviceId]);
  });
  test("abort before dispatch never creates executor or refreshes", async () => {
    let created = false;
    ToolRegistry.clearTools();
    registerAppTools({
      appLifecycle: {
        createAppLifecycle: () => {
          created = true;
          return { execute: async () => successful };
        },
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(handler()(device, args, undefined, controller.signal)).rejects.toThrow();
    expect(created).toBe(false);
    expect(refreshes).toEqual([]);
  });
  test("abort after mutation propagates and refreshes", async () => {
    const controller = new AbortController();
    ToolRegistry.clearTools();
    registerAppTools({
      appLifecycle: {
        createAppLifecycle: () => ({
          execute: async (_app, _action, options?: AppLifecycleExecutionOptions) => {
            options?.onMutation?.();
            controller.abort();
            return successful;
          },
        }),
      },
    });
    await expect(handler()(device, args, undefined, controller.signal)).rejects.toThrow();
    expect(refreshes).toEqual([device.deviceId]);
  });
  test("ActionableError is rethrown intact; unexpected errors are wrapped", async () => {
    const error = new ActionableError("Home verification failed");
    ToolRegistry.clearTools();
    registerAppTools({
      appLifecycle: {
        createAppLifecycle: () => ({
          execute: async () => {
            throw error;
          },
        }),
      },
    });
    await expect(handler()(device, args)).rejects.toBe(error);
    ToolRegistry.clearTools();
    registerAppTools({
      appLifecycle: {
        createAppLifecycle: () => ({
          execute: async () => {
            throw new Error("unexpected");
          },
        }),
      },
    });
    await expect(handler()(device, args)).rejects.toBeInstanceOf(ActionableError);
  });
});
