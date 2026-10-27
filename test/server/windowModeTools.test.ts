import { describe, expect, test } from "bun:test";
import { createWindowModeHandler, windowModeSchema } from "../../src/server/windowModeTools";
import { windowModeResultSchema } from "../../src/server/windowModeToolOutputSchemas";
import { ActionableError, type BootedDevice } from "../../src/models";
import type { WindowModeController } from "../../src/features/windowing/WindowModeController";
import type {
  WindowModeRestore,
  WindowModeResult,
  WindowModeTarget,
} from "../../src/features/windowing/WindowModeTypes";
import { toolJson } from "../helpers/toolResponse";

const android: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
const ios: BootedDevice = { name: "iPhone", deviceId: "sim-1", platform: "ios" };
const APP = "dev.jasonpearson.automobile.playground";
const BOUNDS = { left: 120, top: 300, right: 960, bottom: 1500 };
const RECEIPT = {
  deviceId: "emulator-5554",
  bootId: "0f3c2a5e-8f0b-4c1d-9a6e-2b7d4e1c9f30",
  entries: [{ key: "enable_freeform_support" as const, value: null }],
};

class FakeWindowModeController implements WindowModeController {
  readonly calls: Array<{ appId: string; mode?: WindowModeTarget; restore?: WindowModeRestore }> =
    [];
  result: WindowModeResult = {
    appId: APP,
    matched: true,
    previous: {
      taskId: 14,
      windowingMode: "fullscreen",
      bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
    },
    current: { taskId: 14, windowingMode: "freeform", bounds: BOUNDS },
    method: "am start ... --windowingMode 5",
    attempts: [{ command: "am start ... --windowingMode 5", outcome: "reached" }],
    settingsChanged: ["enable_freeform_support"],
    restore: { mode: "fullscreen", settings: RECEIPT },
  };

  async setMode(request: { appId: string; mode: WindowModeTarget }): Promise<WindowModeResult> {
    this.calls.push({ appId: request.appId, mode: request.mode });
    return this.result;
  }

  async restore(request: { appId: string; restore: WindowModeRestore }): Promise<WindowModeResult> {
    this.calls.push({ appId: request.appId, restore: request.restore });
    return this.result;
  }
}

function setup() {
  const controller = new FakeWindowModeController();
  return { controller, handler: createWindowModeHandler(() => controller) };
}

function payload(response: unknown): Record<string, unknown> {
  const json = toolJson(response);
  expect(windowModeResultSchema.safeParse(json).success).toBe(true);
  return json;
}

describe("windowMode input schema", () => {
  test.each([
    { appId: APP, mode: "fullscreen" },
    { appId: APP, mode: { pip: "enter" } },
    { appId: APP, mode: { freeform: {} } },
    { appId: APP, mode: { freeform: { bounds: BOUNDS } } },
    { appId: APP, mode: { splitScreen: { with: "com.android.settings", position: "secondary" } } },
    { appId: APP, restore: { mode: "fullscreen", settings: RECEIPT } },
  ])("accepts %j", (args) => {
    expect(windowModeSchema.safeParse(args).success).toBe(true);
  });

  test.each([
    { mode: "fullscreen" },
    { appId: APP, mode: "minimized" },
    { appId: APP, mode: { pip: "toggle" } },
    { appId: APP, mode: { freeform: { bounds: { left: 500, top: 0, right: 100, bottom: 10 } } } },
    { appId: APP, mode: { splitScreen: { ratio: 0.5 } } },
    {
      appId: APP,
      restore: {
        settings: { ...RECEIPT, entries: [{ key: "animator_duration_scale", value: "1" }] },
      },
    },
    {
      appId: APP,
      restore: {
        settings: { ...RECEIPT, entries: [{ key: "enable_freeform_support", value: "1; reboot" }] },
      },
    },
  ])("rejects %j", (args) => {
    expect(windowModeSchema.safeParse(args).success).toBe(false);
  });
});

describe("windowMode handler", () => {
  test("reports the mode, task and bounds read back, with the restore receipt", async () => {
    const { controller, handler } = setup();
    const response = await handler(android, { appId: APP, mode: { freeform: { bounds: BOUNDS } } });

    expect(controller.calls).toEqual([{ appId: APP, mode: { freeform: { bounds: BOUNDS } } }]);
    expect("isError" in response).toBe(false);
    expect(payload(response)).toMatchObject({
      success: true,
      appId: APP,
      windowingMode: "freeform",
      taskId: 14,
      bounds: BOUNDS,
      previous: { windowingMode: "fullscreen" },
      settingsChanged: ["enable_freeform_support"],
      restore: { mode: "fullscreen", settings: RECEIPT },
    });
  });

  test("an unreached mode is an error response that still carries the receipt", async () => {
    const { controller, handler } = setup();
    controller.result = {
      ...controller.result,
      matched: false,
      current: controller.result.previous,
      reason: `${APP} did not enter freeform.`,
      restore: { settings: RECEIPT },
    };

    const response = await handler(android, { appId: APP, mode: { freeform: {} } });

    expect("isError" in response && response.isError).toBe(true);
    const result = payload(response);
    expect(result.success).toBe(false);
    expect(result.message).toContain("did not enter freeform");
    expect(result.restore).toEqual({ settings: RECEIPT });
  });

  test("restore is routed to the controller's restore", async () => {
    const { controller, handler } = setup();
    await handler(android, { appId: APP, restore: { settings: RECEIPT } });
    expect(controller.calls).toEqual([{ appId: APP, restore: { settings: RECEIPT } }]);
  });

  test("requires exactly one of mode and restore", async () => {
    const { handler } = setup();
    await expect(handler(android, { appId: APP })).rejects.toThrow(
      "exactly one of mode or restore",
    );
    await expect(
      handler(android, { appId: APP, mode: "fullscreen", restore: { mode: "fullscreen" } }),
    ).rejects.toThrow(ActionableError);
  });

  test("is Android-only", async () => {
    const { handler } = setup();
    await expect(handler(ios, { appId: APP, mode: "fullscreen" })).rejects.toThrow("Android-only");
  });
});
