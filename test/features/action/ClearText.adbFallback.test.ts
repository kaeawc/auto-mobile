import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ClearText } from "../../../src/features/action/ClearText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import type { BootedDevice, ObserveResult } from "../../../src/models";

describe("ClearText Android ADB fallback", () => {
  const device: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeA11yService: FakeCtrlProxy;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let observedSpy: ReturnType<typeof spyOn> | null = null;

  const focusedFieldObserve = (text: string): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            focused: "true",
            text: text,
            class: "android.widget.EditText",
          },
        },
      },
    },
  });

  const noHierarchyObserve = (): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  const runClearText = (observeResult: ObserveResult) => {
    const clearText = new ClearText(device, fakeAdb as any);
    observedSpy = spyOn(
      clearText as unknown as {
        observedInteraction: (fn: (o: ObserveResult) => Promise<unknown>) => Promise<unknown>;
      },
      "observedInteraction",
    ).mockImplementation(async (fn: (o: ObserveResult) => Promise<unknown>) => fn(observeResult));
    return clearText.execute();
  };

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeA11yService = new FakeCtrlProxy();
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    observedSpy?.mockRestore();
    getInstanceSpy = null;
    observedSpy = null;
  });

  test("clears via the accessibility service and never touches ADB when a11y succeeds", async () => {
    // Default FakeCtrlProxy.requestClearText returns success.
    const result = await runClearText(focusedFieldObserve("hello"));

    expect(result.success).toBe(true);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("falls back to ADB deletes sized to the focused field when a11y clear fails", async () => {
    fakeA11yService.setClearTextResult({
      success: false,
      totalTimeMs: 0,
      error: "no focused node",
    });

    const result = await runClearText(focusedFieldObserve("hello"));

    expect(result.success).toBe(true);
    // MOVE_END once, then exactly one KEYCODE_DEL per character (5).
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
    ]);
  });

  test("issues no key events when the focused field is already empty", async () => {
    fakeA11yService.setClearTextResult({
      success: false,
      totalTimeMs: 0,
      error: "no focused node",
    });

    const result = await runClearText(focusedFieldObserve(""));

    expect(result.success).toBe(true);
    // A zero-length field must not spam MOVE_END/DEL key events.
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("uses the 200-delete default when no view hierarchy is available", async () => {
    fakeA11yService.setClearTextResult({
      success: false,
      totalTimeMs: 0,
      error: "no focused node",
    });

    const result = await runClearText(noHierarchyObserve());

    expect(result.success).toBe(true);
    const commands = fakeAdb.getExecutedCommands();
    expect(commands[0]).toBe("shell input keyevent KEYCODE_MOVE_END");
    const deletes = commands.filter((cmd) => cmd === "shell input keyevent KEYCODE_DEL");
    expect(deletes.length).toBe(200);
  });
});
