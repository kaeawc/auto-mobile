import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AndroidDemoModeStatusBarController,
  androidDemoClock,
} from "../../../src/features/utility/AndroidDemoModeStatusBarController";
import { InMemoryDemoAllowedReceipts } from "../../../src/features/utility/DemoAllowedReceipts";
import { defaultStatusBarControllerFactory } from "../../../src/features/utility/StatusBarControllerFactory";
import { SimctlStatusBarController } from "../../../src/features/utility/SimctlStatusBarController";
import type { BootedDevice, ExecResult } from "../../../src/models";

const execResult = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

const simulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "11111111-2222-3333-4444-555555555555",
};

class RecordingSimctl {
  calls: string[][] = [];
  stdout = "";
  async executeCommandArgs(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    return execResult(this.stdout);
  }
}

class RecordingAdb {
  calls: string[][] = [];
  stdout = "";
  async execute(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    return execResult(this.stdout);
  }
}

const demo = (...extras: string[]) => [
  "shell",
  "am",
  "broadcast",
  "-a",
  "com.android.systemui.demo",
  ...extras,
];

describe("SimctlStatusBarController (#14105)", () => {
  test("override sends one simctl status_bar override with every requested flag", async () => {
    const simctl = new RecordingSimctl();
    const controller = new SimctlStatusBarController(simulator, simctl);
    const outcome = await controller.override({
      time: "9:41",
      batteryLevel: 100,
      batteryState: "charged",
      cellularBars: 4,
      wifiBars: 3,
      dataNetwork: "5g",
      operatorName: "AutoMobile",
    });
    expect(simctl.calls).toEqual([
      [
        "status_bar",
        simulator.deviceId,
        "override",
        "--time",
        "9:41",
        "--batteryLevel",
        "100",
        "--batteryState",
        "charged",
        "--cellularMode",
        "active",
        "--cellularBars",
        "4",
        "--wifiMode",
        "active",
        "--wifiBars",
        "3",
        "--dataNetwork",
        "5g",
        "--operatorName",
        "AutoMobile",
      ],
    ]);
    expect(outcome.unsupported).toEqual([]);
    expect(outcome.applied).toEqual([
      "time",
      "batteryLevel",
      "batteryState",
      "cellularBars",
      "wifiBars",
      "dataNetwork",
      "operatorName",
    ]);
  });

  test("hideNotifications is reported unsupported and alone sends no command", async () => {
    const simctl = new RecordingSimctl();
    const outcome = await new SimctlStatusBarController(simulator, simctl).override({
      hideNotifications: true,
    });
    expect(simctl.calls).toEqual([]);
    expect(outcome).toEqual({ applied: [], unsupported: ["hideNotifications"] });
  });

  test("clear and read use status_bar clear and list", async () => {
    const simctl = new RecordingSimctl();
    simctl.stdout = "Current Status Bar Overrides:\n Time: 9:41\n";
    const controller = new SimctlStatusBarController(simulator, simctl);
    await controller.clear();
    expect(await controller.read()).toBe("Current Status Bar Overrides:\n Time: 9:41");
    expect(simctl.calls).toEqual([
      ["status_bar", simulator.deviceId, "clear"],
      ["status_bar", simulator.deviceId, "list"],
    ]);
  });
});

const DUMPSYS_BATTERY = ["shell", "dumpsys", "battery"];
const powerFixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-power", name), "utf8");

/** Answers `dumpsys battery` with a captured dump and everything else with empty output. */
class BatteryDumpAdb extends RecordingAdb {
  constructor(private readonly dump: string) {
    super();
  }
  override async execute(args: string[]): Promise<ExecResult> {
    await super.execute(args);
    return execResult(args.join(" ") === DUMPSYS_BATTERY.join(" ") ? this.dump : "");
  }
}

describe("AndroidDemoModeStatusBarController battery refresh on clear (#19189)", () => {
  test("forces a battery broadcast at the real level, then hands the battery back", async () => {
    const adb = new BatteryDumpAdb(powerFixture("dumpsys-battery-phone-api37.txt"));
    await new AndroidDemoModeStatusBarController(
      adb,
      "d",
      new InMemoryDemoAllowedReceipts(),
    ).clear();
    expect(adb.calls).toEqual([
      demo("-e", "command", "exit"),
      DUMPSYS_BATTERY,
      ["shell", "dumpsys", "battery", "set", "-f", "level", "100"],
      ["shell", "dumpsys", "battery", "reset"],
    ]);
  });

  test("keeps an active dumpsys battery fake instead of resetting it", async () => {
    const adb = new BatteryDumpAdb(
      powerFixture("dumpsys-battery-faked-unplugged-level-15-phone-api34.txt"),
    );
    await new AndroidDemoModeStatusBarController(
      adb,
      "d",
      new InMemoryDemoAllowedReceipts(),
    ).clear();
    expect(adb.calls.slice(1)).toEqual([
      DUMPSYS_BATTERY,
      ["shell", "dumpsys", "battery", "set", "-f", "level", "15"],
    ]);
  });

  test("an unreadable battery dump leaves clear successful without touching the battery", async () => {
    const adb = new BatteryDumpAdb("Can't find service: battery\n");
    await new AndroidDemoModeStatusBarController(
      adb,
      "d",
      new InMemoryDemoAllowedReceipts(),
    ).clear();
    expect(adb.calls).toEqual([demo("-e", "command", "exit"), DUMPSYS_BATTERY]);
  });
});

describe("AndroidDemoModeStatusBarController (#14105)", () => {
  test("override allows demo mode, enters it, then sends one broadcast per command", async () => {
    const adb = new RecordingAdb();
    const outcome = await new AndroidDemoModeStatusBarController(
      adb,
      "d",
      new InMemoryDemoAllowedReceipts(),
    ).override({
      time: "9:41",
      batteryLevel: 100,
      batteryState: "charging",
      wifiBars: 3,
      cellularBars: 4,
      dataNetwork: "lte",
      hideNotifications: true,
    });
    expect(adb.calls).toEqual([
      ["shell", "settings", "get", "global", "sysui_demo_allowed"],
      ["shell", "settings", "put", "global", "sysui_demo_allowed", "1"],
      demo("-e", "command", "enter"),
      demo("-e", "command", "clock", "-e", "hhmm", "0941"),
      demo("-e", "command", "battery", "-e", "level", "100", "-e", "plugged", "true"),
      demo("-e", "command", "network", "-e", "wifi", "show", "-e", "level", "3"),
      demo(
        "-e",
        "command",
        "network",
        "-e",
        "mobile",
        "show",
        "-e",
        "level",
        "4",
        "-e",
        "datatype",
        "lte",
      ),
      demo("-e", "command", "notifications", "-e", "visible", "false"),
    ]);
    expect(outcome.unsupported).toEqual([]);
    const applied: string[] = [...outcome.applied];
    expect(applied.sort()).toEqual(
      [
        "time",
        "batteryLevel",
        "batteryState",
        "wifiBars",
        "cellularBars",
        "dataNetwork",
        "hideNotifications",
      ].sort(),
    );
  });

  test("clear restores the sysui_demo_allowed value captured before the first override (#14741)", async () => {
    const adb = new RecordingAdb();
    adb.stdout = "0\n";
    const receipts = new InMemoryDemoAllowedReceipts();
    await new AndroidDemoModeStatusBarController(adb, "emulator-5554", receipts).override({
      time: "9:41",
    });
    expect(adb.calls.slice(0, 2)).toEqual([
      ["shell", "settings", "get", "global", "sysui_demo_allowed"],
      ["shell", "settings", "put", "global", "sysui_demo_allowed", "1"],
    ]);
    // A second override must not re-capture the "1" the first one wrote.
    adb.stdout = "1\n";
    await new AndroidDemoModeStatusBarController(adb, "emulator-5554", receipts).override({
      time: "9:42",
    });
    expect(adb.calls.filter((c) => c[1] === "settings" && c[2] === "get")).toHaveLength(1);
    adb.calls.length = 0;
    // A fresh controller (a later tool call) still restores it.
    await new AndroidDemoModeStatusBarController(adb, "emulator-5554", receipts).clear();
    expect(adb.calls).toEqual([
      demo("-e", "command", "exit"),
      ["shell", "settings", "put", "global", "sysui_demo_allowed", "0"],
      DUMPSYS_BATTERY,
    ]);
  });

  test("an unset prior setting is deleted on clear, and clear without an override restores nothing", async () => {
    const adb = new RecordingAdb();
    adb.stdout = "null\n";
    const receipts = new InMemoryDemoAllowedReceipts();
    const controller = new AndroidDemoModeStatusBarController(adb, "d1", receipts);
    await controller.override({ time: "9:41" });
    adb.calls.length = 0;
    await controller.clear();
    expect(adb.calls.at(-2)).toEqual([
      "shell",
      "settings",
      "delete",
      "global",
      "sysui_demo_allowed",
    ]);
    adb.calls.length = 0;
    await controller.clear();
    expect(adb.calls).toEqual([demo("-e", "command", "exit"), DUMPSYS_BATTERY]);
  });

  test("operatorName has no demo-mode command and is reported unsupported", async () => {
    const adb = new RecordingAdb();
    const outcome = await new AndroidDemoModeStatusBarController(
      adb,
      "d",
      new InMemoryDemoAllowedReceipts(),
    ).override({
      operatorName: "Carrier",
      dataNetwork: "wifi",
    });
    expect(outcome).toEqual({ applied: ["dataNetwork"], unsupported: ["operatorName"] });
    expect(adb.calls.at(-1)).toEqual(demo("-e", "command", "network", "-e", "wifi", "show"));
  });

  test("an unparseable Android time is refused before any device command", async () => {
    const adb = new RecordingAdb();
    await expect(
      new AndroidDemoModeStatusBarController(adb, "d", new InMemoryDemoAllowedReceipts()).override({
        time: "noon",
      }),
    ).rejects.toThrow("H:MM or HH:MM");
    expect(adb.calls).toEqual([]);
  });

  test("clear exits demo mode and read reports the demo-allowed setting", async () => {
    const adb = new RecordingAdb();
    adb.stdout = "1\n";
    const controller = new AndroidDemoModeStatusBarController(
      adb,
      "d",
      new InMemoryDemoAllowedReceipts(),
    );
    await controller.clear();
    expect(await controller.read()).toBe("sysui_demo_allowed=1");
    expect(adb.calls).toEqual([
      demo("-e", "command", "exit"),
      DUMPSYS_BATTERY,
      ["shell", "settings", "get", "global", "sysui_demo_allowed"],
    ]);
  });
});

describe("androidDemoClock", () => {
  test("maps H:MM and HH:MM to hhmm and rejects anything else", () => {
    expect(androidDemoClock("9:41")).toBe("0941");
    expect(androidDemoClock("23:05")).toBe("2305");
    expect(androidDemoClock("24:00")).toBeNull();
    expect(androidDemoClock("9:60")).toBeNull();
    expect(androidDemoClock("9.41")).toBeNull();
  });
});

describe("defaultStatusBarControllerFactory", () => {
  test("a physical iOS device has no status bar controller", () => {
    expect(
      defaultStatusBarControllerFactory({
        name: "iPhone",
        platform: "ios",
        deviceId: "00008110-001A2B3C4D5E6F70",
      }),
    ).toBeNull();
  });
});
