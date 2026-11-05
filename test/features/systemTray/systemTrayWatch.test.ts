import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { ActionableError } from "../../../src/models";
import { SystemTray } from "../../../src/features/systemTray/SystemTray";
import { AndroidNotificationUIDetector } from "../../../src/features/systemTray/AndroidNotificationUIDetector";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../../src/features/systemTray/systemTrayHelpers";
import { capturedLauncherHierarchy } from "../../helpers/capturedLauncherHierarchy";
import { buildObserveResult, viewHierarchyFromFixture } from "../../helpers/observeFixture";
import phoneCapture from "../../fixtures/observe/ctrlproxy-headerless-two-notification-group-collapsed.json";
import {
  watchClearAll,
  watchNodes,
  watchNotifications,
  watchStreamRoot,
} from "../../../src/features/systemTray/helpers/watchHierarchy";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createExecResult } from "../../../src/utils/execResult";
import { systemTrayResultSchema } from "../../../src/server/interactionToolOutputSchemas";

// Fake service inventory, not a captured expanded-notification hierarchy.
const shellInventory = [
  "Current Notification Manager state:",
  "  Notification List:",
  "    NotificationRecord(0x1: pkg=com.android.shell user=UserHandle{0} id=1 tag=null key=0|com.android.shell|1|null|2000: Notification(channel=shell flags=0))",
  "  Snoozed notifications:",
].join("\n");
const emptyInventory =
  "Current Notification Manager state:\n  Notification List:\n  Snoozed notifications:";

const watch: BootedDevice = {
  deviceId: "fake-watch",
  name: "watch",
  platform: "android",
  formFactor: "watch",
};
// Scrolls the stream toward its top (a downward finger swipe on the 384px fake screen).
const REWIND_SWIPE = "shell input swipe 192 96 192 288 500";
let hierarchy: ViewHierarchyResult;
let stream: ObserveResult;
let emptyStream: ObserveResult;
// A fake closed screen, not a captured watch-face hierarchy.
const closed = buildObserveResult({
  updatedAt: 0,
  screenSize: { width: 384, height: 384 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: { hierarchy: { node: { $: { bounds: "[0,0][384,384]" } } } },
});

beforeAll(async () => {
  hierarchy = await capturedLauncherHierarchy("wear/systemtray/notification-stream.xml");
  stream = { ...closed, viewHierarchy: hierarchy };
  // Model removal by pruning the captured stream container; this is not a second device capture.
  const emptyHierarchy = structuredClone(hierarchy);
  const root = watchStreamRoot(emptyHierarchy);
  if (!root) {
    throw new Error("Captured watch stream root is missing");
  }
  for (const node of watchNodes(root)) {
    if (node.$?.["resource-id"] === "com.google.android.clockwork.sysui:id/trayview_container") {
      node.node = [];
    }
  }
  emptyStream = { ...closed, viewHierarchy: emptyHierarchy };
});
afterEach(resetSystemTrayDependencies);

function setup(read: (commands: string[]) => ObserveResult = () => stream) {
  const adb = new FakeAdbExecutor();
  const observer = new FakeObserveScreen();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  observer.setObserveResult(() => read(adb.getExecutedCommands()));
  setSystemTrayDependencies({
    adbFactory: () => adb,
    observeScreenFactory: () => observer,
    timer,
    appLabelResolver: async () => "Shell",
    appInventoryFactory: () => ({
      executeDetailedResult: async () => ({
        successful: true,
        apps: {
          profiles: {},
          system: [
            { packageName: "com.android.shell", userIds: [0], foreground: false, recent: false },
          ],
        },
      }),
    }),
  });
  return { adb, timer, tray: new SystemTray(watch) };
}

describe("Wear notification stream capture", () => {
  test("detects the stream without a phone shade or window-title hint", () => {
    const detector = new AndroidNotificationUIDetector(watch, {
      executeAdbCommand: async () => ({ stdout: "", stderr: "" }),
      getDeviceTimestampMs: async () => 0,
    });
    expect(detector.isTrayOpen(hierarchy)).toBe(true);
    expect(detector.isTrayOpen(closed.viewHierarchy)).toBe(false);
    const phone = new AndroidNotificationUIDetector(
      { ...watch, formFactor: "phone" },
      {
        executeAdbCommand: async () => ({ stdout: "", stderr: "" }),
        getDeviceTimestampMs: async () => 0,
      },
    );
    expect(phone.isTrayOpen(hierarchy)).toBe(false);
  });

  test("lists app, title, body and clickable card bounds from the capture", async () => {
    const { tray } = setup();
    const result = await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(result.isError).toBe(false);
    expect(systemTrayResultSchema.safeParse(result.payload).success).toBe(true);
    expect(result.payload.notifications).toMatchObject([
      {
        appLabel: "Shell",
        title: "Wear",
        body: "-i",
        bounds: { left: 19, top: 92, right: 365, bottom: 260 },
      },
    ]);
  });

  test.each([{ title: "Wear", body: "-i" }, { appId: "com.android.shell" }])(
    "finds the card using %j",
    async (notification) => {
      const { tray } = setup();
      const result = await tray.execute({ action: "find", notification, awaitTimeout: 500 });
      expect(result.isError).toBe(false);
      expect(result.payload.bounds).toEqual({ left: 19, top: 92, right: 365, bottom: 260 });
    },
  );

  test("returns a typed miss using only the fake timer", async () => {
    const { tray, timer } = setup();
    const result = await tray.execute({
      action: "find",
      notification: { title: "missing" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({
      isError: true,
      payload: { code: "notification_not_found", success: false },
    });
    expect(timer.getSleepHistory()).toContain(250);
  });

  test("opens with the slow bottom-edge gesture and restores a closed screen after find", async () => {
    const { tray, adb } = setup((commands) =>
      commands.includes("shell input keyevent 4")
        ? closed
        : commands.some((command) => command.startsWith("shell input swipe"))
          ? stream
          : closed,
    );
    await tray.execute({ action: "find", notification: { title: "Wear" }, awaitTimeout: 500 });
    expect(adb.getExecutedCommands()).toContain("shell input swipe 192 370 192 119 900");
    expect(adb.getExecutedCommands()).toContain("shell input keyevent 4");
    expect(adb.getExecutedCommands().some((command) => command.includes("statusbar"))).toBe(false);
  });

  test("taps the card centre to expand and refuses to invent an expanded target", async () => {
    const { tray, adb } = setup();
    await expect(
      tray.execute({ action: "tap", notification: { title: "Wear" }, awaitTimeout: 500 }),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(
      adb.getExecutedCommands().filter((command) => command.startsWith("shell input tap")),
    ).toEqual(["shell input tap 192 176"]);
  });

  test("taps Clear all at its clickable parent's centre, then returns to the previous screen", async () => {
    const { tray, adb } = setup((commands) =>
      commands.includes("shell input tap 192 335") || commands.includes("shell input keyevent 4")
        ? closed
        : commands.some((command) => command.startsWith("shell input swipe"))
          ? stream
          : closed,
    );
    adb.setCommandResponseSequence("shell dumpsys notification --noredact", [
      createExecResult(shellInventory, ""),
      createExecResult(emptyInventory, ""),
    ]);
    const result = await tray.execute({
      action: "clearAll",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({ isError: false, payload: { success: true } });
    expect(adb.getExecutedCommands()).toContain("shell input tap 192 335");
  });

  test("does not use global Clear all for a mixed-app inventory", async () => {
    const { tray, adb } = setup();
    adb.setCommandResponse(
      "shell dumpsys notification --noredact",
      createExecResult(
        shellInventory.replace(
          "  Snoozed notifications:",
          "    NotificationRecord(0x2: pkg=com.other user=UserHandle{0} id=2 tag=null key=0|com.other|2|null|2001: Notification(channel=other flags=0))\n  Snoozed notifications:",
        ),
        "",
      ),
    );
    const result = await tray.execute({
      action: "clearAll",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({ isError: true, payload: { code: "dismissal_unconfirmed" } });
    expect(adb.getExecutedCommands()).not.toContain("shell input tap 192 335");
    expect(adb.getExecutedCommands()).toContain("shell input swipe 192 176 364 176 300");
  });

  test("does not claim dismissal when the captured card remains", async () => {
    const { tray, timer } = setup();
    expect(
      await tray.execute({ action: "dismiss", notification: { title: "Wear" }, awaitTimeout: 500 }),
    ).toMatchObject({ isError: true, payload: { code: "dismissal_unconfirmed" } });
    expect(timer.getSleepHistory()).toEqual([250, 250]);
  });

  test("confirms a removed card in a readable stream after the injected dismiss swipe", async () => {
    const { tray, adb, timer } = setup((commands) =>
      commands.includes("shell input swipe 192 176 364 176 300") ? emptyStream : stream,
    );
    expect(
      await tray.execute({
        action: "dismiss",
        notification: { appId: "com.android.shell" },
        awaitTimeout: 500,
      }),
    ).toMatchObject({ isError: false, payload: { dismissedCount: 1, success: true } });
    expect(adb.getExecutedCommands()).not.toContain("shell input tap 192 335");
    expect(timer.getSleepHistory()).toEqual([250, 250]);
  });

  test("does not claim Clear all succeeded when the active inventory remains", async () => {
    const { tray, adb } = setup();
    adb.setCommandResponse(
      "shell dumpsys notification --noredact",
      createExecResult(shellInventory, ""),
    );
    expect(
      await tray.execute({
        action: "clearAll",
        notification: { appId: "com.android.shell" },
        awaitTimeout: 500,
      }),
    ).toMatchObject({ isError: true, payload: { success: false, dismissedCount: 0 } });
  });

  test("preserves an already-open stream after find, only rewinding it to the top", async () => {
    const { tray, adb, timer } = setup();
    await tray.execute({
      action: "find",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(adb.getExecutedCommands()).toEqual([REWIND_SWIPE]);
    expect(timer.getSleepHistory()).toEqual([250]);
  });

  test("rewinds an already-open stream scrolled past its cards before listing", async () => {
    const { tray, adb } = setup((commands) =>
      commands.includes(REWIND_SWIPE) ? stream : emptyStream,
    );
    const result = await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(result.isError).toBe(false);
    expect(result.payload.notifications).toMatchObject([{ title: "Wear", body: "-i" }]);
    expect(adb.getExecutedCommands().filter((command) => command === REWIND_SWIPE)).toHaveLength(2);
  });

  test("never treats a notification titled Clear all as the stream footer", async () => {
    const footerless = structuredClone(hierarchy);
    const root = watchStreamRoot(footerless);
    if (!root) {
      throw new Error("Captured watch stream root is missing");
    }
    for (const node of watchNodes(root)) {
      const children = Array.isArray(node.node) ? node.node : [];
      node.node = children.filter(
        (child) =>
          !(Array.isArray(child.node) ? child.node : []).some((n) => n.$?.text === "Clear all"),
      );
      if (node.$?.text === "Wear") {
        node.$.text = "Clear all";
        node.$["content-desc"] = "Clear all";
      }
    }
    const view = { ...closed, viewHierarchy: footerless };
    expect(watchNotifications(footerless)).toMatchObject([{ title: "Clear all" }]);
    expect(watchClearAll(footerless)).toBeUndefined();
    expect(watchClearAll(hierarchy)?.bounds).toEqual({
      left: 0,
      top: 287,
      right: 384,
      bottom: 383,
    });

    const { tray, adb } = setup(() => view);
    adb.setCommandResponse(
      "shell dumpsys notification --noredact",
      createExecResult(shellInventory, ""),
    );
    const result = await tray.execute({
      action: "clearAll",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(adb.getExecutedCommands()).not.toContain("shell input tap 192 176");
    expect(adb.getExecutedCommands()).toContain("shell input swipe 192 176 364 176 300");
    expect(result.payload.code).toBe("dismissal_unconfirmed");
  });

  test("phone find payload stays byte-identical with absent or explicit phone form factor", async () => {
    const phoneObservation = {
      ...closed,
      screenSize: { width: 1080, height: 2400 },
      viewHierarchy: viewHierarchyFromFixture(phoneCapture.viewHierarchy),
    };
    const { adb } = setup(() => phoneObservation);
    const args = { action: "find", notification: { title: "Delta" }, awaitTimeout: 500 } as const;
    const expected = JSON.stringify({
      payload: {
        message: "Found notification in system tray",
        match: { title: { text: "Delta", matchType: "exact" } },
        observation: phoneObservation,
        success: true,
      },
      isError: false,
    });
    for (const formFactor of [undefined, "phone"] as const) {
      const actual = await new SystemTray({ ...watch, formFactor }).execute(args);
      expect(JSON.stringify(actual)).toBe(expected);
    }
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
