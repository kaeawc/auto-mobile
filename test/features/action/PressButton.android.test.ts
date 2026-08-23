import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../../src/models";

describe("PressButton Android keycode dispatch", () => {
  const androidDevice: BootedDevice = {
    deviceId: "android-device",
    platform: "android",
    name: "Pixel",
  };

  let fakeAdb: FakeAdbExecutor;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
  });

  const press = (button: string) => {
    const pressButton = new PressButton(androidDevice, fakeAdb);
    return (pressButton as any).executeAndroidButtonPress(button) as Promise<{
      success: boolean;
      button: string;
      keyCode: number;
      error?: string;
    }>;
  };

  // In-place hardware buttons dispatch straight to an ADB keyevent (no global action).
  test.each<[string, number]>([
    ["menu", 82],
    ["power", 26],
    ["volume_up", 24],
    ["volume_down", 25],
  ])("dispatches keyevent %i for %s", async (button, keyCode) => {
    const result = await press(button);

    expect(result).toEqual({ success: true, button, keyCode });
    expect(fakeAdb.getExecutedCommands()).toEqual([`shell input keyevent ${keyCode}`]);
    expect(fakeAdb.getCommandCalls()).toEqual([
      {
        command: `shell input keyevent ${keyCode}`,
        timeoutMs: undefined,
        maxBuffer: undefined,
        noRetry: true,
        signal: undefined,
      },
    ]);
  });

  test("normalizes the button name case before resolving the keycode", async () => {
    const result = await press("MENU");

    expect(result).toEqual({ success: true, button: "MENU", keyCode: 82 });
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input keyevent 82"]);
  });

  test("rejects an unknown button without dispatching a keyevent", async () => {
    const result = await press("definitely_not_a_button");

    expect(result.success).toBe(false);
    expect(result.keyCode).toBe(-1);
    expect(result.error).toContain("Unsupported button");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  // Navigation buttons fall back to an ADB keyevent when the a11y global action
  // is unavailable. This pins the keycode each navigation button maps to — e.g.
  // "back" must be 4 (KEYCODE_BACK), never 3 (KEYCODE_HOME).
  test.each<[string, number]>([
    ["back", 4],
    ["home", 3],
    ["recent", 187],
  ])("falls back to keyevent %i for navigation button %s", async (button, keyCode) => {
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async () => {
        throw new Error("global action unavailable");
      },
    } as unknown as AndroidCtrlProxyClient);

    const result = await press(button);

    expect(result).toEqual({ success: true, button, keyCode });
    expect(fakeAdb.getExecutedCommands()).toEqual([`shell input keyevent ${keyCode}`]);
  });

  test("rejects a stale context instead of falling back from a failed global action to ADB", async () => {
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async () => ({ success: false, error: "global action unavailable" }),
      validateFrameContext: async () => ({
        success: false,
        error: "Stale frame context; observe a fresh frame before retrying",
      }),
    } as unknown as AndroidCtrlProxyClient);

    const pressButton = new PressButton(androidDevice, fakeAdb);
    const result = await (pressButton as any).executeAndroidButtonPress("back", 500, "epoch:2");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Stale frame context");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("validates a context before dispatching an ADB-only hardware button", async () => {
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      validateFrameContext: async () => ({
        success: false,
        error: "Stale frame context; observe a fresh frame before retrying",
      }),
    } as unknown as AndroidCtrlProxyClient);

    const pressButton = new PressButton(androidDevice, fakeAdb);
    const result = await (pressButton as any).executeAndroidButtonPress(
      "volume_up",
      500,
      "epoch:3",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Stale frame context");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });
});
