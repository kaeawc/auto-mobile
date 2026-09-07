import { beforeEach, describe, expect, test } from "bun:test";
import {
  Window,
  parseActiveWindowModern,
  parseFirstVisibleModernWindow,
  DEFAULT_GET_ACTIVE_TIMEOUT_MS,
} from "../../../src/features/observe/Window";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { PressButton } from "../../../src/features/action/PressButton";
import { ExecResult } from "../../../src/models/ExecResult";
import { BootedDevice } from "../../../src/models/DeviceInfo";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import type { Timer } from "../../../src/utils/SystemTimer";

/**
 * Deterministic clock whose `now()` returns each scripted value in order (the
 * last value repeats once exhausted). Lets a test assert that sequential
 * sub-reads each receive the REMAINING share of one budget rather than the full
 * timeout, without depending on wall-clock elapsement inside the fake adb.
 */
function scriptedClock(nowValues: number[]): Timer {
  let index = 0;
  return {
    now: () => nowValues[Math.min(index++, nowValues.length - 1)],
    async sleep(): Promise<void> {},
    setTimeout: () => 0 as unknown as NodeJS.Timeout,
    clearTimeout: () => {},
    setInterval: () => 0 as unknown as NodeJS.Timeout,
    clearInterval: () => {},
  };
}

/**
 * Deadline-bounding + AbortSignal-propagation coverage for Window.getActive
 * (issue #6289). Every device sub-read (initial `dumpsys window windows`, the
 * API-level probe, and the API-27 legacy `dumpsys window` fallback) must be
 * bounded by the caller budget AND cancel on abort, and an abort during ANY
 * sub-read must PROPAGATE OUT rather than resolving a synthetic empty window.
 */
describe("Window.getActive deadline + abort plumbing (#6289)", () => {
  let fakeAdb: FakeAdbExecutor;
  let device: BootedDevice;
  let window: Window;

  const execResult = (stdout: string): ExecResult => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  });

  beforeEach(async () => {
    device = { deviceId: "abort-device", name: "Abort Device", platform: "android" };
    fakeAdb = new FakeAdbExecutor();
    // These tests assert cancellation PROPAGATION, so the fake rejects reads that
    // are handed an already-aborted signal (as the real AdbClient does).
    fakeAdb.setThrowOnAbortedSignal();
    window = new Window(device, new FakeAdbClientFactory(fakeAdb));
    await window.clearCache();
  });

  test("bounds every read with the caller budget and threads the signal", async () => {
    fakeAdb.setDefaultResponse(
      execResult("imeControlTarget in display# 0 Window{1 u0 com.example.app/.Main}"),
    );
    const controller = new AbortController();

    await window.getActive(true, undefined, { signal: controller.signal, timeoutMs: 1234 });

    const dumpsysCall = fakeAdb
      .getCommandCalls()
      .find((c) => c.command.includes("dumpsys window windows"));
    expect(dumpsysCall?.timeoutMs).toBe(1234);
    expect(dumpsysCall?.signal).toBeDefined();
    expect(dumpsysCall?.signal?.aborted).toBe(false);

    const apiCall = fakeAdb.getApiLevelCalls()[0];
    expect(apiCall?.timeoutMs).toBe(1234);
    expect(apiCall?.signal).toBeDefined();
  });

  test("applies the default read deadline when the caller supplies none", async () => {
    fakeAdb.setDefaultResponse(
      execResult("imeControlTarget in display# 0 Window{1 u0 com.example.app/.Main}"),
    );

    await window.getActive(true);

    const dumpsysCall = fakeAdb
      .getCommandCalls()
      .find((c) => c.command.includes("dumpsys window windows"));
    expect(dumpsysCall?.timeoutMs).toBe(DEFAULT_GET_ACTIVE_TIMEOUT_MS);
  });

  test("propagates an abort during the initial dumpsys read (not a synthetic empty window)", async () => {
    fakeAdb.setDefaultResponse(execResult("anything"));
    const controller = new AbortController();
    controller.abort();

    await expect(window.getActive(true, undefined, { signal: controller.signal })).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
  });

  test("propagates an abort that arrives during the API-level probe", async () => {
    // The initial dumpsys returns, then cancellation lands before the API-level
    // probe: getAndroidApiLevel must reject and getActive must propagate it.
    fakeAdb.setDefaultResponse(execResult("no parseable focus here"));
    const controller = new AbortController();
    fakeAdb.abortAfterCommand("dumpsys window windows", controller);

    await expect(window.getActive(true, undefined, { signal: controller.signal })).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
    // The API-level probe was reached and received the combined signal.
    expect(fakeAdb.getApiLevelCalls().length).toBe(1);
  });

  test("propagates an abort during the API-27 legacy dumpsys fallback", async () => {
    // API <= 27 routes through the separate `dumpsys window` fallback when the
    // primary output carries no focus. Cancellation lands after the API-level
    // probe but before that fallback read; the abort must propagate out.
    fakeAdb.setAndroidApiLevel(27);
    fakeAdb.setDefaultResponse(execResult("no focus, no ty=1 windows"));
    const controller = new AbortController();
    fakeAdb.abortAfterApiLevel(controller);

    await expect(window.getActive(true, undefined, { signal: controller.signal })).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
    // The legacy `dumpsys window` fallback was reached with the combined signal.
    const legacyCall = fakeAdb
      .getCommandCalls()
      .find((c) => c.command.includes('dumpsys window"') || c.command === 'shell "dumpsys window"');
    expect(legacyCall).toBeDefined();
    expect(legacyCall?.signal?.aborted).toBe(true);
  });

  test("spends ONE budget across the API-27 sub-reads instead of the full timeout each", async () => {
    // On API <= 27 the three sub-reads run sequentially. With a single 1000ms
    // budget and a clock that advances 100 -> 300 -> 500ms across them, each read
    // must receive only the REMAINING time (900, 700, 500), never a fresh 1000.
    const clock = scriptedClock([0, 100, 300, 500]);
    window = new Window(device, new FakeAdbClientFactory(fakeAdb), clock);
    await window.clearCache();
    fakeAdb.setAndroidApiLevel(27);
    fakeAdb.setDefaultResponse(execResult("no focus, no ty=1 windows"));

    await window.getActive(true, undefined, { timeoutMs: 1000 });

    const dumpsysCall = fakeAdb
      .getCommandCalls()
      .find((c) => c.command.includes("dumpsys window windows"));
    expect(dumpsysCall?.timeoutMs).toBe(900);

    const apiCall = fakeAdb.getApiLevelCalls()[0];
    expect(apiCall?.timeoutMs).toBe(700);

    const legacyCall = fakeAdb
      .getCommandCalls()
      .find((c) => c.command.includes('dumpsys window"') || c.command === 'shell "dumpsys window"');
    expect(legacyCall?.timeoutMs).toBe(500);
  });

  test("clamps an exhausted budget to a positive timeout (never 0, which arms no deadline)", async () => {
    // If the budget is already spent when a sub-read starts, it must still be
    // handed a positive timeout: passing 0 would leave the read unbounded.
    const clock = scriptedClock([0, 5000]);
    window = new Window(device, new FakeAdbClientFactory(fakeAdb), clock);
    await window.clearCache();
    fakeAdb.setDefaultResponse(
      execResult("imeControlTarget in display# 0 Window{1 u0 com.example.app/.Main}"),
    );

    await window.getActive(true, undefined, { timeoutMs: 1000 });

    const dumpsysCall = fakeAdb
      .getCommandCalls()
      .find((c) => c.command.includes("dumpsys window windows"));
    expect(dumpsysCall?.timeoutMs).toBe(1);
  });

  test("a non-abort device failure still degrades to an empty window", async () => {
    // Without an abort, the existing best-effort behavior is unchanged.
    fakeAdb.setDefaultError(new Error("device offline"));

    const result = await window.getActive(true);

    expect(result).toEqual({ appId: "", activityName: "", layoutSeqSum: 0 });
  });
});

describe("BaseVisualChange forwards its clock into the internal Window (#6289)", () => {
  const execResult = (stdout: string): ExecResult => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  });

  test("the internal Window derives sub-read budgets from the parent-injected timer", async () => {
    // A subclass built with a FakeTimer/scripted clock but WITHOUT replacing its
    // window must still let that clock shrink the internal Window's sequential
    // sub-read budgets; otherwise BaseVisualChange's Window would run on wall
    // time and the shared-deadline behavior would be untestable deterministically.
    const clock = scriptedClock([0, 100, 300, 500]);
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setAndroidApiLevel(27);
    fakeAdb.setDefaultResponse(execResult("no focus, no ty=1 windows"));
    const device: BootedDevice = {
      deviceId: "timer-wiring",
      name: "Wiring",
      platform: "android",
    };

    // PressButton is a concrete BaseVisualChange; pass a factory + the clock and
    // reach the Window it constructed internally (not a replaced fake).
    const pressButton = new PressButton(
      device,
      new FakeAdbClientFactory(fakeAdb) as unknown as null,
      clock,
    );
    const internalWindow = (pressButton as unknown as { window: Window }).window;
    await internalWindow.clearCache();

    await internalWindow.getActive(true, undefined, { timeoutMs: 1000 });

    const dumpsysCall = fakeAdb
      .getCommandCalls()
      .find((c) => c.command.includes("dumpsys window windows"));
    expect(dumpsysCall?.timeoutMs).toBe(900);
    const apiCall = fakeAdb.getApiLevelCalls()[0];
    expect(apiCall?.timeoutMs).toBe(700);
  });
});

describe("parseActiveWindowModern block-bounding + launcher awareness (#6289)", () => {
  test("does not associate a later visible window's fields with an earlier hidden app", () => {
    // API 29-30 style capture with no parseable imeControlTarget: a hidden
    // com.old window appears BEFORE a visible launcher. The block-crossing regex
    // used to pair com.old's header with the launcher's visibility fields and
    // report the backgrounded app as foreground.
    const stdout = `
      Window #1 Window{aaaa u0 com.old/com.old.MainActivity}:
        mViewVisibility=0x8 mHaveFrame=true mObscured=true
        isOnScreen=false
        isVisible=false
      Window #2 Window{bbbb u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}:
        mViewVisibility=0x0 mHaveFrame=true mObscured=false
        isOnScreen=true
        isVisible=true
    `;

    expect(parseActiveWindowModern(stdout)).toEqual({
      appId: "com.google.android.apps.nexuslauncher",
      activityName: "com.google.android.apps.nexuslauncher.NexusLauncherActivity",
    });
    // The dedicated block-bounded helper agrees.
    expect(parseFirstVisibleModernWindow(stdout)?.appId).toBe(
      "com.google.android.apps.nexuslauncher",
    );
  });

  test("still skips SystemUI overlays when choosing the visible foreground", () => {
    const stdout = `
      Window #1 Window{aaaa u0 com.android.systemui/com.android.systemui.ScrimView}:
        mViewVisibility=0x0 mHaveFrame=true
        isOnScreen=true
        isVisible=true
      Window #2 Window{bbbb u0 com.example.app/com.example.app.MainActivity}:
        mViewVisibility=0x0 mHaveFrame=true
        isOnScreen=true
        isVisible=true
    `;

    expect(parseFirstVisibleModernWindow(stdout)?.appId).toBe("com.example.app");
  });
});
