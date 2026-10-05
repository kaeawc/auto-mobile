import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appLifecycleSchema,
  appLifecycleResultSchema,
  registerAppTools,
  resetAppLifecycleToolDependencies,
  setAppLifecycleToolDependencies,
  resetInstalledAppResourceRefresh,
  setInstalledAppResourceRefresh,
} from "../../src/server/appTools";
import type { AppLifecycleResult, BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models";
import type { AppLifecycleExecutionOptions } from "../../src/features/action/AppLifecycle";
import { ToolRegistry } from "../../src/server/toolRegistry";

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
    resetAppLifecycleToolDependencies();
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
    resetAppLifecycleToolDependencies();
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
  test("structured success forwards options and refreshes only after actual mutation", async () => {
    const controller = new AbortController();
    setAppLifecycleToolDependencies({
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
    });
    const response = await handler()(device, args, undefined, controller.signal);
    expect(response.structuredContent).toMatchObject(successful);
    expect(appLifecycleResultSchema.safeParse(response.structuredContent).success).toBe(true);
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
      setAppLifecycleToolDependencies({
        createAppLifecycle: () => ({ execute: async () => failure }),
      });
      const response = await handler()(device, args);
      expect(response.structuredContent).toMatchObject({ success: false, message: failure.error });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toBe(JSON.stringify({ ...failure, message: failure.error }));
      expect(refreshes).toEqual([]);
    });
  }
  test("already backgrounded success has no resource mutation", async () => {
    setAppLifecycleToolDependencies({
      createAppLifecycle: () => ({
        execute: async () => ({
          ...successful,
          action: "background",
          mechanism: "home",
          pid: 123,
        }),
      }),
    });
    await handler()(device, { appId, action: "background" });
    expect(refreshes).toEqual([]);
  });
  test("not-reclaimed advisory message is preserved", async () => {
    setAppLifecycleToolDependencies({
      createAppLifecycle: () => ({
        execute: async () => ({
          ...successful,
          processReclaimed: false,
          pidAfter: 123,
          message: "Process was not reclaimed",
        }),
      }),
    });
    expect((await handler()(device, args)).structuredContent).toMatchObject({
      message: "Process was not reclaimed",
      success: true,
    });
  });
  test("typed kill failure after dispatch refreshes and does not throw", async () => {
    setAppLifecycleToolDependencies({
      createAppLifecycle: () => ({
        execute: async (_app, _action, options) => {
          options?.onMutation?.();
          return { ...successful, success: false, errorCode: "kill_failed", error: "kill failed" };
        },
      }),
    });
    expect((await handler()(device, args)).structuredContent).toMatchObject({
      message: "kill failed",
      success: false,
    });
    expect(refreshes).toEqual([device.deviceId]);
  });
  test("abort before dispatch never creates executor or refreshes", async () => {
    let created = false;
    setAppLifecycleToolDependencies({
      createAppLifecycle: () => {
        created = true;
        return { execute: async () => successful };
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
    setAppLifecycleToolDependencies({
      createAppLifecycle: () => ({
        execute: async (_app, _action, options?: AppLifecycleExecutionOptions) => {
          options?.onMutation?.();
          controller.abort();
          return successful;
        },
      }),
    });
    await expect(handler()(device, args, undefined, controller.signal)).rejects.toThrow();
    expect(refreshes).toEqual([device.deviceId]);
  });
  test("ActionableError is rethrown intact; unexpected errors are wrapped", async () => {
    const error = new ActionableError("Home verification failed");
    setAppLifecycleToolDependencies({
      createAppLifecycle: () => ({
        execute: async () => {
          throw error;
        },
      }),
    });
    await expect(handler()(device, args)).rejects.toBe(error);
    setAppLifecycleToolDependencies({
      createAppLifecycle: () => ({
        execute: async () => {
          throw new Error("unexpected");
        },
      }),
    });
    await expect(handler()(device, args)).rejects.toBeInstanceOf(ActionableError);
  });
});
