import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidWindowModeController } from "../../../src/features/windowing/WindowModeController";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FULL_SCREEN, FakeWindowingDevice } from "../../fakes/FakeWindowingDevice";

const APP = "dev.jasonpearson.automobile.playground";
const OTHER = "com.android.settings";
const DEVICE_ID = "emulator-5554";
const FREEFORM_BOUNDS = { left: 120, top: 300, right: 960, bottom: 1500 };
const TOP_HALF = { left: 0, top: 0, right: 1080, bottom: 1194 };
const BOTTOM_HALF = { left: 0, top: 1206, right: 1080, bottom: 2400 };
const PIP_BOUNDS = { left: 651, top: 1789, right: 1038, bottom: 2007 };

let device: FakeWindowingDevice;
let timer: FakeTimer;
let controller: AndroidWindowModeController;

beforeEach(() => {
  device = new FakeWindowingDevice();
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  controller = new AndroidWindowModeController({
    adb: device,
    backStack: device,
    timer,
    deviceId: DEVICE_ID,
  });
});

/** The device honors `am start --windowingMode N` for the started package. */
function honorWindowingModeLaunch(
  modes: Record<string, { mode: string; bounds?: typeof FULL_SCREEN }>,
) {
  device.on(/-n '([^/]+)\/\.MainActivity' --windowingMode (\d)$/, (match) => {
    const target = modes[match[2]];
    if (target) {
      device.setWindow(match[1], target.mode, target.bounds);
    } else {
      device.bringToFront(match[1]);
    }
  });
}

describe("freeform", () => {
  test("turns on the freeform settings with a receipt, enters freeform and applies bounds", async () => {
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    device.settings.set("force_resizable_activities", "0");
    honorWindowingModeLaunch({
      "5": { mode: "freeform", bounds: { left: 0, top: 0, right: 800, bottom: 1200 } },
    });
    device.on(/^am task resize (\d+) (\d+) (\d+) (\d+) (\d+)$/, ([, , l, t, r, b]) => {
      device.setWindow(APP, "freeform", { left: +l, top: +t, right: +r, bottom: +b });
    });

    const result = await controller.setMode({
      appId: APP,
      mode: { freeform: { bounds: FREEFORM_BOUNDS } },
    });

    expect(result.matched).toBe(true);
    expect(result.current).toEqual({
      taskId: 100,
      windowingMode: "freeform",
      bounds: FREEFORM_BOUNDS,
    });
    expect(result.previous).toEqual({
      taskId: 100,
      windowingMode: "fullscreen",
      bounds: FULL_SCREEN,
    });
    expect(result.method).toContain("--windowingMode 5");
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["reached", "reached"]);
    expect(result.attempts[1].command).toBe("am task resize 100 120 300 960 1500");
    expect(result.settingsChanged).toEqual([
      "enable_freeform_support",
      "force_resizable_activities",
    ]);
    expect(device.settings.get("enable_freeform_support")).toBe("1");
    expect(result.restore).toEqual({
      mode: "fullscreen",
      settings: {
        deviceId: DEVICE_ID,
        bootId: device.bootId,
        entries: [
          { key: "enable_freeform_support", value: null },
          { key: "force_resizable_activities", value: "0" },
        ],
      },
    });
  });

  test("falls back to the WM Shell desktop command when the launch does not change the mode", async () => {
    device.apiLevel = 36;
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    device.settings.set("enable_freeform_support", "1");
    device.settings.set("force_resizable_activities", "1");
    honorWindowingModeLaunch({});
    device.on(/WMShell desktopmode moveToDesktop (\d+)$/, () => {
      device.setWindow(APP, "freeform", FREEFORM_BOUNDS);
    });

    const result = await controller.setMode({ appId: APP, mode: { freeform: {} } });

    expect(result.matched).toBe(true);
    expect(result.method).toBe(
      "dumpsys activity service SystemUIService WMShell desktopmode moveToDesktop 100",
    );
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["not_reached", "reached"]);
    expect(result.settingsChanged).toEqual([]);
    expect(result.restore).toEqual({ mode: "fullscreen" });
  });

  test("reports why when no candidate reaches freeform, keeping the settings receipt", async () => {
    device.apiLevel = 30;
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    honorWindowingModeLaunch({});

    const result = await controller.setMode({ appId: APP, mode: { freeform: {} } });

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("did not enter freeform");
    // API 30 has no desktop-mode shell command, so only the launch was tried.
    expect(result.attempts).toHaveLength(1);
    expect(result.restore?.settings?.entries).toHaveLength(2);
    expect(result.restore?.mode).toBeUndefined();
  });

  test("a clamped resize is not a match", async () => {
    device.addTask(APP, "freeform", { left: 0, top: 0, right: 800, bottom: 1200 });
    device.on(/^am task resize/, () => {
      device.setWindow(APP, "freeform", { left: 120, top: 300, right: 700, bottom: 1500 });
    });

    const result = await controller.setMode({
      appId: APP,
      mode: { freeform: { bounds: FREEFORM_BOUNDS } },
    });

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("bounds were not applied");
    expect(result.restore?.mode).toEqual({
      freeform: { bounds: { left: 0, top: 0, right: 800, bottom: 1200 } },
    });
  });
});

describe("picture-in-picture", () => {
  test("brings the app forward, presses HOME and reads pinned back", async () => {
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    device.addTask(OTHER, "fullscreen", FULL_SCREEN);
    honorWindowingModeLaunch({ "1": { mode: "fullscreen", bounds: FULL_SCREEN } });
    device.on(/^input keyevent KEYCODE_HOME$/, () => {
      device.setWindow(APP, "pinned", PIP_BOUNDS);
    });

    const result = await controller.setMode({ appId: APP, mode: { pip: "enter" } });

    expect(result.matched).toBe(true);
    expect(result.method).toBe("input keyevent KEYCODE_HOME");
    expect(result.current).toEqual({ taskId: 100, windowingMode: "pinned", bounds: PIP_BOUNDS });
    expect(result.attempts.map((attempt) => attempt.command)).toEqual([
      expect.stringContaining("--windowingMode 1"),
      "input keyevent KEYCODE_HOME",
    ]);
    expect(result.restore).toEqual({ mode: "fullscreen" });
  });

  test("explains PiP support when HOME leaves the app fullscreen", async () => {
    device.addTask(APP, "fullscreen", FULL_SCREEN);

    const result = await controller.setMode({ appId: APP, mode: { pip: "enter" } });

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("supportsPictureInPicture");
    expect(result.attempts).toEqual([
      { command: "input keyevent KEYCODE_HOME", outcome: "not_reached" },
    ]);
  });

  test("exit relaunches the pinned app fullscreen", async () => {
    device.addTask(APP, "pinned", PIP_BOUNDS);
    honorWindowingModeLaunch({ "1": { mode: "fullscreen", bounds: FULL_SCREEN } });

    const result = await controller.setMode({ appId: APP, mode: { pip: "exit" } });

    expect(result.matched).toBe(true);
    expect(result.current?.windowingMode).toBe("fullscreen");
    expect(result.restore).toEqual({ mode: { pip: "enter" } });
  });

  test("needs a running task", async () => {
    await expect(controller.setMode({ appId: APP, mode: { pip: "enter" } })).rejects.toThrow(
      ActionableError,
    );
  });
});

describe("split screen", () => {
  test("API 34: launches the partner, moves it to the side stage and falls back to the bare WM Shell command", async () => {
    device.installApp(OTHER);
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    honorWindowingModeLaunch({ "1": { mode: "fullscreen", bounds: FULL_SCREEN } });
    device.on(/WMShell splitscreen moveToSideStage/, () => "Invalid command: splitscreen");
    device.on(/WMShell moveToSideStage (\d+) (\d)$/, ([, , position]) => {
      expect(position).toBe("1");
      device.setWindow(OTHER, "multi-window", BOTTOM_HALF);
      device.setWindow(APP, "multi-window", TOP_HALF);
    });

    const result = await controller.setMode({ appId: APP, mode: { splitScreen: { with: OTHER } } });

    expect(result.matched).toBe(true);
    expect(result.current).toEqual({
      taskId: 100,
      windowingMode: "multi-window",
      bounds: TOP_HALF,
    });
    expect(result.partner).toEqual({
      appId: OTHER,
      taskId: 101,
      windowingMode: "multi-window",
      bounds: BOTTOM_HALF,
    });
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      "reached",
      "reached",
      "failed",
      "reached",
    ]);
    expect(result.method).toBe(
      "dumpsys activity service SystemUIService WMShell moveToSideStage 101 1",
    );
    expect(result.restore).toEqual({ mode: "fullscreen" });
  });

  test("API 34: switches sides when the app landed on the wrong one", async () => {
    device.addTask(OTHER, "fullscreen", FULL_SCREEN);
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    device.on(/WMShell splitscreen moveToSideStage/, () => {
      device.setWindow(OTHER, "multi-window", TOP_HALF);
      device.setWindow(APP, "multi-window", BOTTOM_HALF);
    });
    device.on(/WMShell splitscreen switchSplitPosition$/, () => {
      device.setWindow(OTHER, "multi-window", BOTTOM_HALF);
      device.setWindow(APP, "multi-window", TOP_HALF);
    });

    const result = await controller.setMode({ appId: APP, mode: { splitScreen: { with: OTHER } } });

    expect(result.matched).toBe(true);
    expect(result.current?.bounds).toEqual(TOP_HALF);
    expect(result.method).toContain("moveToSideStage");
    expect(result.attempts.at(-1)?.command).toContain("switchSplitPosition");
  });

  test("API 34 requires the second app", async () => {
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    await expect(controller.setMode({ appId: APP, mode: { splitScreen: {} } })).rejects.toThrow(
      "splitScreen.with is required",
    );
  });

  test("API 30: docks the app as primary and opens the partner as secondary", async () => {
    device.apiLevel = 30;
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    device.installApp(OTHER);
    honorWindowingModeLaunch({
      "3": { mode: "split-screen-primary", bounds: TOP_HALF },
      "4": { mode: "split-screen-secondary", bounds: BOTTOM_HALF },
    });

    const result = await controller.setMode({ appId: APP, mode: { splitScreen: { with: OTHER } } });

    expect(result.matched).toBe(true);
    expect(result.current?.windowingMode).toBe("split-screen-primary");
    expect(result.partner?.windowingMode).toBe("split-screen-secondary");
    expect(result.method).toContain(`-n '${APP}/.MainActivity' --windowingMode 3`);
  });

  test("leaving shell split for fullscreen uses exitSplitScreen, and the receipt names the partner", async () => {
    device.addTask(OTHER, "multi-window", BOTTOM_HALF);
    device.addTask(APP, "multi-window", TOP_HALF);
    device.on(/WMShell splitscreen exitSplitScreen (\d+)$/, () => {
      device.setWindow(OTHER, "fullscreen", FULL_SCREEN);
      device.setWindow(APP, "fullscreen", FULL_SCREEN);
    });

    const result = await controller.setMode({ appId: APP, mode: "fullscreen" });

    expect(result.matched).toBe(true);
    expect(result.method).toBe(
      "dumpsys activity service SystemUIService WMShell splitscreen exitSplitScreen 101",
    );
    expect(result.restore).toEqual({ mode: { splitScreen: { with: OTHER, position: "primary" } } });
  });
});

describe("restore", () => {
  test("puts the window back, then writes the settings back", async () => {
    device.addTask(APP, "freeform", FREEFORM_BOUNDS);
    device.settings.set("enable_freeform_support", "1");
    honorWindowingModeLaunch({ "1": { mode: "fullscreen", bounds: FULL_SCREEN } });

    const result = await controller.restore({
      appId: APP,
      restore: {
        mode: "fullscreen",
        settings: {
          deviceId: DEVICE_ID,
          bootId: device.bootId,
          entries: [{ key: "enable_freeform_support", value: null }],
        },
      },
    });

    expect(result.matched).toBe(true);
    expect(result.current?.windowingMode).toBe("fullscreen");
    expect(result.settingsRestored).toEqual(["enable_freeform_support"]);
    expect(device.settings.has("enable_freeform_support")).toBe(false);
    expect(result.restore).toBeUndefined();
  });

  test("restoring into freeform keeps the receipt for the settings that restore turned on", async () => {
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    honorWindowingModeLaunch({ "5": { mode: "freeform", bounds: FREEFORM_BOUNDS } });

    const result = await controller.restore({
      appId: APP,
      restore: { mode: { freeform: { bounds: FREEFORM_BOUNDS } } },
    });

    expect(result.matched).toBe(true);
    expect(result.restore?.mode).toBeUndefined();
    expect(result.restore?.settings?.entries.map((entry) => entry.key)).toEqual([
      "enable_freeform_support",
      "force_resizable_activities",
    ]);
  });

  test("refuses a receipt from another boot without writing", async () => {
    device.addTask(APP, "fullscreen", FULL_SCREEN);
    device.settings.set("enable_freeform_support", "1");

    await expect(
      controller.restore({
        appId: APP,
        restore: {
          settings: {
            deviceId: DEVICE_ID,
            bootId: "11111111-2222-4333-8444-555555555555",
            entries: [{ key: "enable_freeform_support", value: "0" }],
          },
        },
      }),
    ).rejects.toThrow("earlier boot");
    expect(device.settings.get("enable_freeform_support")).toBe("1");
    expect(device.commands.some((command) => command.includes("settings put"))).toBe(false);
  });

  test("refuses a receipt entry the schema would not produce", async () => {
    await expect(
      controller.restore({
        appId: APP,
        restore: {
          settings: {
            deviceId: DEVICE_ID,
            bootId: device.bootId,
            entries: [{ key: "enable_freeform_support", value: "1; reboot" }],
          },
        },
      }),
    ).rejects.toThrow("unsupported entry");
    expect(device.commands.some((command) => command.includes("settings put"))).toBe(false);
  });

  test("refuses a receipt from another device", async () => {
    await expect(
      controller.restore({
        appId: APP,
        restore: { settings: { deviceId: "emulator-5556", bootId: device.bootId, entries: [] } },
      }),
    ).rejects.toThrow("belongs to device emulator-5556");
  });
});
