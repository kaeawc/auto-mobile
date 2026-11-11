import { describe, expect, test } from "bun:test";
import {
  AdbAndroidAutoScreenDriver,
  OVERFLOW_MENU_LABEL,
  parseScreenNodes,
} from "../../../src/features/androidAuto/AdbAndroidAutoScreenDriver";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const DUMP = "cat /data/local/tmp/automobile-android-auto.xml";

function node(attributes: Record<string, string>, children = ""): string {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  return `<node ${attrs}>${children}</node>`;
}

function screen(...nodes: string[]): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node(
    { text: "", bounds: "[0,0][1080,2400]" },
    nodes.join(""),
  )}</hierarchy>`;
}

function result(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search) => stdout.includes(search),
  };
}

const VERSION_ROW = node({ text: "Version", bounds: "[0,1800][1080,1900]" });
const UNKNOWN_SOURCES_ON = node(
  { text: "", bounds: "[0,600][1080,760]" },
  node({ text: "Unknown sources", bounds: "[40,620][800,700]" }) +
    node({ text: "", checkable: "true", checked: "true", bounds: "[900,630][1040,730]" }),
);

function setup(screens: string[]) {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponseSequence(DUMP, screens.map(result));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const driver = new AdbAndroidAutoScreenDriver(adb, "emulator-5554", timer, {
    settleMs: 10,
    findAttempts: 2,
    maxScrolls: 2,
  });
  const actions = () =>
    adb
      .getExecutedCommands()
      .filter((command) => command.startsWith("shell input"))
      .map((command) => command.replace("shell ", ""));
  return { driver, actions, commands: () => adb.getExecutedCommands() };
}

describe("AdbAndroidAutoScreenDriver", () => {
  test("parses text, content-desc, switches and bounds from a uiautomator dump", async () => {
    const nodes = await parseScreenNodes(
      `UI hierchary dumped to: /dev/tty${screen(UNKNOWN_SOURCES_ON)}`,
    );
    expect(nodes.find((entry) => entry.text === "Unknown sources")?.bounds).toEqual({
      left: 40,
      top: 620,
      right: 800,
      bottom: 700,
    });
    expect(nodes.filter((entry) => entry.checkable)).toHaveLength(1);
    expect(await parseScreenNodes("ERROR: could not get idle state.")).toEqual([]);
  });

  test("taps the centre of the node whose text matches", async () => {
    const { driver, actions } = setup([screen(VERSION_ROW)]);
    await driver.tapText("Version");
    expect(actions()).toEqual(["input tap 540 1850"]);
  });

  test("opens the overflow menu by its content description", async () => {
    const { driver, actions } = setup([
      screen(
        node({ "content-desc": OVERFLOW_MENU_LABEL, text: "", bounds: "[980,100][1060,180]" }),
      ),
    ]);
    await driver.openOverflowMenu();
    expect(actions()).toEqual(["input tap 1020 140"]);
  });

  test("re-reads the screen before reporting a missing text as an actionable error", async () => {
    const { driver, actions } = setup([screen(), screen()]);
    const tapping = driver.tapText("Developer settings");
    await expect(tapping).rejects.toBeInstanceOf(ActionableError);
    await expect(tapping).rejects.toThrow(
      '"Developer settings" is not on the phone screen after 2 reads',
    );
    expect(actions()).toEqual([]);
  });

  test("removes the previous dump first, so a failed dump reads as empty, not stale", async () => {
    const { driver, actions, commands } = setup(["", screen(VERSION_ROW)]);
    await driver.tapText("Version");
    expect(actions()).toEqual(["input tap 540 1850"]);
    const dumpCycle = commands().filter((command) => !command.startsWith("shell input"));
    expect(dumpCycle.slice(0, 3)).toEqual([
      "shell rm -f /data/local/tmp/automobile-android-auto.xml",
      "shell uiautomator dump /data/local/tmp/automobile-android-auto.xml",
      "shell cat /data/local/tmp/automobile-android-auto.xml 2>/dev/null || true",
    ]);
  });

  test("scrolls up until the text appears", async () => {
    const { driver, actions } = setup([screen(), screen(VERSION_ROW)]);
    await driver.scrollToText("Version");
    expect(actions()).toEqual(["input swipe 540 1920 540 720 300"]);
  });

  test("a text that never scrolls into view is an actionable error after the bounded scrolls", async () => {
    const { driver, actions } = setup([screen()]);
    await expect(driver.scrollToText("Version")).rejects.toThrow("after 2 scrolls");
    expect(actions()).toHaveLength(2);
  });

  test("reads the switch on the label's row", async () => {
    const { driver } = setup([screen(UNKNOWN_SOURCES_ON)]);
    expect(await driver.isSwitchOn("Unknown sources")).toBe(true);
  });

  test("a row with no switch is an actionable error rather than a guessed off", async () => {
    const { driver } = setup([screen(VERSION_ROW)]);
    await expect(driver.isSwitchOn("Version")).rejects.toThrow(
      'No switch was found on the "Version" row',
    );
  });

  test("presses back with a key event", async () => {
    const { driver, actions } = setup([screen()]);
    await driver.pressBack();
    expect(actions()).toEqual(["input keyevent KEYCODE_BACK"]);
  });
});
