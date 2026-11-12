import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import { clearResolvedHomePackageCache } from "../../../src/features/observe/androidLauncherPackages";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { displayInventoryOutcome } from "../../../src/models/DeviceInfo";
import type { TapCoordinatesRequest } from "../../../src/utils/interfaces/TapCoordinatesRequest";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { buildObserveResult } from "../../helpers/observeFixture";
import { carAppTemplateObservation } from "../../helpers/carAppTemplateFixtures";

const android: BootedDevice = { deviceId: "aaos-34", platform: "android", name: "AAOS" };
const SETTINGS = "com.android.car.settings";

function screen(text: string, updatedAt: number): ObserveResult {
  return buildObserveResult({
    updatedAt,
    screenSize: { width: 1280, height: 720 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: {
      packageName: SETTINGS,
      hierarchy: { node: { text, "resource-id": `${SETTINGS}:id/title` } },
    },
  });
}

let timer: FakeTimer;

beforeEach(() => {
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  clearResolvedHomePackageCache();
});

afterEach(() => {
  clearResolvedHomePackageCache();
});

interface Harness {
  action: PressButton;
  adb: FakeAdbExecutor;
  observe: FakeObserveScreen;
  globalActions: string[];
  resolved: string[];
  taps: TapCoordinatesRequest[];
}

/** The screen changes once a key is sent (global action or `input keyevent`), or only on a tap. */
function harness(
  device: BootedDevice = android,
  {
    displayId = 4,
    panelKey = "passenger",
    before,
    after,
    changeOnTapOnly = false,
  }: {
    displayId?: number;
    panelKey?: string;
    before?: ObserveResult;
    after?: ObserveResult;
    changeOnTapOnly?: boolean;
  } = {},
): Harness {
  const adb = new FakeAdbExecutor();
  const globalActions: string[] = [];
  const resolved: string[] = [];
  const taps: TapCoordinatesRequest[] = [];
  const window = new FakeWindow();
  window.configureCachedActiveWindow(null);
  window.configureActiveWindow({ appId: SETTINGS, activityName: ".Settings", layoutSeqSum: 1 });
  const observe = new FakeObserveScreen();
  const sent = () =>
    globalActions.length > 0 || adb.getExecutedCommands().some((c) => c.includes("keyevent"));
  const pre = before ?? screen("Bluetooth", 1);
  const post = after ?? screen("Settings", 2);
  observe.setObserveResult(() => (taps.length > 0 || (!changeOnTapOnly && sent()) ? post : pre));
  const action = new PressButton(device, adb, timer, {
    window,
    observeScreen: observe,
    awaitIdle: new FakeAwaitIdle(),
    globalActionClient: {
      requestGlobalAction: async (name) => {
        globalActions.push(name);
        return { success: true, action: name, totalTimeMs: 0 };
      },
    },
    frameContextClient: {
      validateFrameContext: async () => ({ success: true, totalTimeMs: 0 }),
    },
    templateBackTapClient: {
      requestTapCoordinates: async (request) => {
        taps.push(request);
        return { success: true, totalTimeMs: 0 };
      },
    },
    displayResolver: async (display) => {
      resolved.push(display);
      return { key: panelKey, displayId };
    },
  });
  return { action, adb, observe, globalActions, resolved, taps };
}

function keyeventArgv(adb: FakeAdbExecutor): string[][] {
  return adb.getExecutedArgv().filter((argv) => argv.includes("keyevent"));
}

describe("PressButton display (#17643)", () => {
  test("without display the press keeps the global action and an unscoped observation", async () => {
    const { action, adb, observe, globalActions, resolved } = harness();
    const result = await action.execute("back");
    expect(result.success).toBe(true);
    expect(globalActions).toEqual(["back"]);
    expect(keyeventArgv(adb)).toEqual([]);
    expect(resolved).toEqual([]);
    expect(observe.getExecuteOptions().every((options) => options.display === undefined)).toBe(
      true,
    );
  });

  test("an explicit display sends input -d to that display and verifies there", async () => {
    const { action, adb, observe, globalActions, resolved } = harness(android, {
      panelKey: "virtual:emu:1234562",
    });
    const result = await action.execute("back", { display: "virtual:emu:1234562" });
    expect(resolved).toEqual(["virtual:emu:1234562"]);
    expect(globalActions).toEqual([]);
    expect(keyeventArgv(adb)).toEqual([["shell", "input", "-d", "4", "keyevent", "4"]]);
    const reads = observe.getExecuteOptions();
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every((options) => options.display === "virtual:emu:1234562")).toBe(true);
    expect(result.success).toBe(true);
    expect(result.keyCode).toBe(4);
  });

  test("active is resolved once: the key and every read target the same concrete panel", async () => {
    const { action, adb, observe, resolved } = harness(android, { panelKey: "passenger" });
    const result = await action.execute("back", { display: "active" });
    expect(resolved).toEqual(["active"]);
    expect(keyeventArgv(adb)).toEqual([["shell", "input", "-d", "4", "keyevent", "4"]]);
    expect(observe.getExecuteOptions().map((options) => options.display)).not.toContain("active");
    expect(observe.getExecuteOptions().every((options) => options.display === "passenger")).toBe(
      true,
    );
    expect(result.success).toBe(true);
  });

  test("active on an unreadable inventory presses display 0 with unscoped reads", async () => {
    // Its fallback panel key is not a caller selector, so the reads must not re-check it (#16741).
    const unreadable: BootedDevice = {
      ...android,
      [displayInventoryOutcome]: { kind: "unreadable", reason: "dumpsys display timed out" },
    };
    const { action, adb, observe, resolved } = harness(unreadable, { displayId: 0, panelKey: "0" });
    const result = await action.execute("back", { display: "active" });
    expect(resolved).toEqual(["active"]);
    expect(keyeventArgv(adb)).toEqual([["shell", "input", "-d", "0", "keyevent", "4"]]);
    expect(observe.getExecuteOptions().length).toBeGreaterThanOrEqual(1);
    expect(observe.getExecuteOptions().every((options) => options.display === undefined)).toBe(
      true,
    );
    expect(result.success).toBe(true);
  });

  test("an explicit selector on an unreadable inventory keeps its scoped reads", async () => {
    const unreadable: BootedDevice = {
      ...android,
      [displayInventoryOutcome]: { kind: "unreadable", reason: "dumpsys display timed out" },
    };
    const { action, observe } = harness(unreadable, { displayId: 0, panelKey: "main" });
    await action.execute("back", { display: "inner" });
    expect(observe.getExecuteOptions().every((options) => options.display === "main")).toBe(true);
  });

  test("an unchanged targeted display fails the press with no visual change", async () => {
    const same = screen("Bluetooth", 1);
    const { action } = harness(android, { before: same, after: same });
    const result = await action.execute("back", { display: "4" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("No visual change observed");
  });

  test("a key hold keeps --duration after the display flag", async () => {
    const { action, adb } = harness();
    adb.setAndroidApiLevel(35);
    const result = await action.execute("select", { display: "4", durationMs: 600 });
    expect(result.success).toBe(true);
    expect(keyeventArgv(adb)).toEqual([
      ["shell", "input", "-d", "4", "keyevent", "--duration", "600", "23"],
    ]);
  });

  test("an explicit display 0 is still targeted, since untargeted keys go to the focused display", async () => {
    const { action, adb, observe, globalActions } = harness(android, {
      displayId: 0,
      panelKey: "main",
    });
    const result = await action.execute("back", { display: "inner" });
    expect(result.success).toBe(true);
    expect(globalActions).toEqual([]);
    expect(keyeventArgv(adb)).toEqual([["shell", "input", "-d", "0", "keyevent", "4"]]);
    expect(observe.getExecuteOptions().every((options) => options.display === "main")).toBe(true);
  });

  test("home on a secondary display skips the default-display launcher check", async () => {
    const { action, adb } = harness();
    const result = await action.execute("home", { display: "4" });
    expect(result.success).toBe(true);
    expect(keyeventArgv(adb)).toEqual([["shell", "input", "-d", "4", "keyevent", "3"]]);
    expect(adb.getExecutedCommands().some((command) => command.includes("dumpsys"))).toBe(false);
  });

  test("an unchanged home on a secondary display keeps the no-visual-change failure", async () => {
    const same = screen("Bluetooth", 1);
    const { action } = harness(android, { before: same, after: same });
    const result = await action.execute("home", { display: "4" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("No visual change observed");
  });

  test("an unchanged home on a display already showing its launcher is accepted (#17647)", async () => {
    const launcher = buildObserveResult({
      updatedAt: 1,
      screenSize: { width: 1280, height: 720 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: {
        packageName: "com.android.launcher3",
        hierarchy: { node: { text: "Apps", "resource-id": "com.android.launcher3:id/apps" } },
      },
    });
    const { action, adb } = harness(android, { before: launcher, after: launcher });
    const result = await action.execute("home", { display: "4" });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(keyeventArgv(adb)).toEqual([["shell", "input", "-d", "4", "keyevent", "3"]]);
  });

  test("the template Back fallback taps on the targeted display", async () => {
    const pane = carAppTemplateObservation("pane");
    const menu = carAppTemplateObservation("menu", { updatedAt: 2 });
    const { action, taps } = harness(android, { before: pane, after: menu, changeOnTapOnly: true });
    const result = await action.execute("back", { display: "4" });
    expect(taps.map((tap) => tap.displayId)).toEqual([4]);
    expect(result.success).toBe(true);
    expect(result.backFallback).toBe("toolbar_nav_icon");
  });

  test("display is refused on iOS before anything is sent", async () => {
    const ios: BootedDevice = { deviceId: "sim", platform: "ios", name: "iPhone" };
    const { action, resolved } = harness(ios);
    await expect(action.execute("home", { display: "inner" })).rejects.toThrow(
      "pressButton display applies to Android only",
    );
    expect(resolved).toEqual([]);
  });
});
