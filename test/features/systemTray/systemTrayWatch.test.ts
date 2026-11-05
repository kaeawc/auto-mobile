import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type {
  BootedDevice,
  ExecResult,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
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
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { systemTrayResultSchema } from "../../../src/server/interactionToolOutputSchemas";
import { serverConfig } from "../../../src/utils/ServerConfig";

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

const DUMPSYS = "shell dumpsys notification --noredact";

// Serves the active notification inventory from the commands run so far, so it can follow dismissals.
class InventoryAdb extends FakeAdbExecutor {
  constructor(private readonly inventoryFor: (commands: string[]) => string) {
    super();
  }

  override executeCommand(command: string, options?: AdbExecuteOptions): Promise<ExecResult> {
    if (command === DUMPSYS) {
      this.setCommandResponse(
        DUMPSYS,
        createExecResult(this.inventoryFor(this.getExecutedCommands()), ""),
      );
    }
    return super.executeCommand(command, options);
  }
}

// Fake service inventories, not captured dumps.
const record = (pkg: string, id: number, title: string) =>
  [
    `    NotificationRecord(0x${id}: pkg=${pkg} user=UserHandle{0} id=${id} tag=null key=0|${pkg}|${id}|null|${2000 + id}: Notification(channel=c flags=0))`,
    "      extras={",
    `        android.title=String (${title})`,
    "      }",
  ].join("\n");
const inventory = (...records: string[]) =>
  [
    "Current Notification Manager state:",
    "  Notification List:",
    ...records,
    "  Snoozed notifications:",
  ].join("\n");
// Titled like the captured card ("Wear") unless a test models a differently titled notification.
const shell = (id: number, title = "Wear") => record("com.android.shell", id, title);
const otherApp = record("com.other", 9, "Ping");

function setup(
  read: (commands: string[]) => ObserveResult = () => stream,
  inventoryFor?: (commands: string[]) => string,
) {
  const adb = inventoryFor ? new InventoryAdb(inventoryFor) : new FakeAdbExecutor();
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
  return { adb, observer, timer, tray: new SystemTray(watch) };
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

  // Rewrites one captured card text to model an ongoing card that updates in place.
  function withText(from: string, to: string): ObserveResult {
    const edited = structuredClone(hierarchy);
    const root = watchStreamRoot(edited);
    for (const node of root ? watchNodes(root) : []) {
      if (node.$?.text === from) {
        node.$.text = to;
        node.$["content-desc"] = node.$["content-desc"] ? to : "";
      }
    }
    return { ...closed, viewHierarchy: edited };
  }

  test("does not treat an updated body on a card that refused the swipe as removal", async () => {
    const progress = withText("-i", "50%");
    const { tray } = setup((commands) =>
      commands.includes("shell input swipe 192 176 364 176 300") ? progress : stream,
    );
    expect(
      await tray.execute({ action: "dismiss", notification: { title: "Wear" }, awaitTimeout: 500 }),
    ).toMatchObject({ isError: true, payload: { code: "dismissal_unconfirmed" } });
  });

  test("counts individually dismissed cards together with the footer clear", async () => {
    const other = withText("Wear", "Other");
    const { tray } = setup(
      (commands) => (commands.includes("shell input swipe 192 176 364 176 300") ? other : stream),
      (commands) =>
        commands.includes("shell input tap 192 335")
          ? inventory()
          : commands.includes("shell input swipe 192 176 364 176 300")
            ? inventory(shell(2))
            : inventory(shell(1), shell(2), otherApp),
    );
    const result = await tray.execute({
      action: "clearAll",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 2000,
    });
    expect(result).toMatchObject({ isError: false, payload: { dismissedCount: 2, success: true } });
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

// Scrolls a dismissed first card off the fake stream (a horizontal swipe across its centre).
const DISMISS_SWIPE = "shell input swipe 192 176 364 176 300";
const CAPTURED_CARD_BOUNDS = "[19,92][365,260]";

function streamNodes(view: ViewHierarchyResult | undefined): ViewHierarchyNode[] {
  const root = watchStreamRoot(view);
  if (!root) {
    throw new Error("Captured watch stream root is missing");
  }
  return watchNodes(root);
}

const childNodes = (node: ViewHierarchyNode): ViewHierarchyNode[] => node.node ?? [];

function shiftBounds(bounds: string, dy: number): string {
  return bounds.replace(
    /\[(\d+),(\d+)\]/g,
    (_, x: string, y: string) => `[${x},${Number(y) + dy}]`,
  );
}

// Models a second, identical notification below the captured card; not a second device capture.
function withDuplicateCard(): ObserveResult {
  const edited = structuredClone(hierarchy);
  const parent = streamNodes(edited).find((node) =>
    childNodes(node).some((child) => child.$?.bounds === CAPTURED_CARD_BOUNDS),
  );
  if (!parent) {
    throw new Error("Captured watch card wrapper is missing");
  }
  const wrapper = childNodes(parent).find((child) => child.$?.bounds === CAPTURED_CARD_BOUNDS);
  const copy = structuredClone(wrapper);
  for (const node of copy ? watchNodes(copy) : []) {
    const bounds = node.$?.bounds;
    if (node.$ && typeof bounds === "string") {
      node.$.bounds = shiftBounds(bounds, 180);
    }
  }
  if (copy) {
    parent.node = [...childNodes(parent), copy];
  }
  return { ...closed, viewHierarchy: edited };
}

// Models the stream with the Clear all footer pruned, as when it is scrolled out of view.
function withoutFooter(view: ObserveResult): ObserveResult {
  const edited = structuredClone(view.viewHierarchy);
  for (const node of streamNodes(edited)) {
    node.node = childNodes(node).filter(
      (child) => !childNodes(child).some((grandchild) => grandchild.$?.text === "Clear all"),
    );
  }
  return { ...closed, viewHierarchy: edited };
}

// Rewrites the captured body on every read, like an ongoing progress notification.
function withChangingBody(base: () => ObserveResult = () => stream): () => ObserveResult {
  let reads = 0;
  return () => {
    reads++;
    const edited = structuredClone(base().viewHierarchy);
    for (const node of streamNodes(edited)) {
      if (node.$?.text === "-i") {
        node.$.text = `${reads}%`;
      }
    }
    return { ...closed, viewHierarchy: edited };
  };
}

// Rewrites the captured body, modelling a different notification with the same app and title.
function withBody(body: string): ObserveResult {
  const edited = structuredClone(hierarchy);
  for (const node of streamNodes(edited)) {
    if (node.$?.text === "-i") {
      node.$.text = body;
    }
  }
  return { ...closed, viewHierarchy: edited };
}

// Retitles the captured card, modelling a different notification from the same app.
function retitled(title: string): ObserveResult {
  const edited = structuredClone(hierarchy);
  for (const node of streamNodes(edited)) {
    if (node.$?.text === "Wear") {
      node.$.text = title;
      node.$["content-desc"] = title;
    }
  }
  return { ...closed, viewHierarchy: edited };
}

const forwardSwipes = (commands: string[]) =>
  commands.filter((command) => command === "shell input swipe 192 288 192 96 500").length;

const dismissSwipes = (commands: string[]) =>
  commands.filter((command) => command === DISMISS_SWIPE).length;

describe("Wear duplicate-card dismissal", () => {
  test("the modelled stream holds two identical cards", () => {
    const cards = watchNotifications(withDuplicateCard().viewHierarchy);
    expect(cards.map((card) => [card.appLabel, card.title, card.body])).toEqual([
      ["Shell", "Wear", "-i"],
      ["Shell", "Wear", "-i"],
    ]);
  });

  test("confirms dismissing one of two identical cards when the other survives", async () => {
    const duplicates = withDuplicateCard();
    const { tray } = setup((commands) => (dismissSwipes(commands) === 0 ? duplicates : stream));
    expect(
      await tray.execute({ action: "dismiss", notification: { title: "Wear" }, awaitTimeout: 500 }),
    ).toMatchObject({ isError: false, payload: { dismissedCount: 1, success: true } });
  });

  test("still refuses a dismissal when both identical cards remain", async () => {
    const duplicates = withDuplicateCard();
    const { tray } = setup(() => duplicates);
    expect(
      await tray.execute({ action: "dismiss", notification: { title: "Wear" }, awaitTimeout: 500 }),
    ).toMatchObject({ isError: true, payload: { code: "dismissal_unconfirmed" } });
  });

  test("a mixed-app clearAll dismisses both identical cards one by one", async () => {
    const duplicates = withDuplicateCard();
    const { tray, adb } = setup(
      (commands) => [duplicates, stream][dismissSwipes(commands)] ?? emptyStream,
      (commands) =>
        [inventory(shell(1), shell(2), otherApp), inventory(shell(2), otherApp)][
          dismissSwipes(commands)
        ] ?? inventory(otherApp),
    );
    const result = await tray.execute({
      action: "clearAll",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 2000,
    });
    expect(result).toMatchObject({ isError: false, payload: { dismissedCount: 2, success: true } });
    expect(dismissSwipes(adb.getExecutedCommands())).toBe(2);
    expect(adb.getExecutedCommands()).not.toContain("shell input tap 192 335");
  });

  test("confirms a dismissal by the app's inventory when an identical card scrolls into view", async () => {
    const duplicates = withDuplicateCard();
    const { tray } = setup(
      () => duplicates,
      (commands) =>
        dismissSwipes(commands) === 0
          ? inventory(shell(1), shell(2), shell(3))
          : inventory(shell(2), shell(3)),
    );
    expect(
      await tray.execute({
        action: "dismiss",
        notification: { appId: "com.android.shell", title: "Wear" },
        awaitTimeout: 500,
      }),
    ).toMatchObject({ isError: false, payload: { dismissedCount: 1, success: true } });
  });

  test("does not confirm a refused card when another notification of the app expires meanwhile", async () => {
    const { tray } = setup(
      () => stream,
      (commands) =>
        dismissSwipes(commands) === 0
          ? inventory(shell(1), shell(2, "Expiring"))
          : inventory(shell(1)),
    );
    expect(
      await tray.execute({
        action: "dismiss",
        notification: { appId: "com.android.shell", title: "Wear" },
        awaitTimeout: 500,
      }),
    ).toMatchObject({ isError: true, payload: { code: "dismissal_unconfirmed" } });
  });

  test("does not confirm a refused card that rewrote its title while the inventory kept it", async () => {
    const renamed = retitled("Renamed");
    const { tray } = setup(
      (commands) => (dismissSwipes(commands) === 0 ? stream : renamed),
      (commands) => inventory(shell(1, dismissSwipes(commands) === 0 ? "Wear" : "Renamed")),
    );
    expect(
      await tray.execute({
        action: "dismiss",
        notification: { appId: "com.android.shell", title: "Wear" },
        awaitTimeout: 500,
      }),
    ).toMatchObject({ isError: true, payload: { code: "dismissal_unconfirmed" } });
  });
});

describe("Wear stream scroll progress with changing text", () => {
  test("rewinding stops once card positions stop moving although the body keeps updating", async () => {
    const { tray, adb, timer } = setup(withChangingBody());
    const result = await tray.execute({
      action: "find",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 2000,
    });
    expect(result.isError).toBe(false);
    // Each swipe settles, then re-reads without scrolling and sees the body still changing; two
    // such ambiguous pages in a row end the rewind.
    expect(adb.getExecutedCommands()).toEqual([REWIND_SWIPE, REWIND_SWIPE]);
    expect(timer.getSleepHistory()).toEqual([250, 250, 250, 250]);
  });

  test("rewinding passes a different ongoing card at the same snapped bounds", async () => {
    let reads = 0;
    const { tray, adb } = setup((commands) => {
      reads++;
      const swipes = commands.filter((command) => command === REWIND_SWIPE).length;
      return swipes === 0 ? withBody("C") : swipes === 1 ? withBody(`B ${reads}%`) : withBody("A");
    });
    const result = await tray.execute({
      action: "find",
      notification: { title: "Wear", body: "A" },
      awaitTimeout: 2000,
    });
    expect(result).toMatchObject({ isError: false, payload: { body: "A" } });
    expect(adb.getExecutedCommands()).toEqual([REWIND_SWIPE, REWIND_SWIPE, REWIND_SWIPE]);
  });

  test("fails rather than scanning from mid-stream when rewind cannot reach the top", async () => {
    const { tray, adb } = setup((commands) =>
      withBody(`card ${commands.filter((command) => command === REWIND_SWIPE).length}`),
    );
    const result = await tray.execute({
      action: "find",
      notification: { title: "Wear", body: "nowhere" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({
      isError: true,
      payload: { code: "notification_not_found", success: false },
    });
    expect(result.payload.message).toContain("back to its top");
    expect(adb.getExecutedCommands().every((command) => command === REWIND_SWIPE)).toBe(true);
  });

  test("rewinding passes same-app, same-title cards whose bodies differ at snapped bounds", async () => {
    const [top, middle, bottom] = ["A", "B", "C"].map(withBody);
    const { tray, adb } = setup(
      (commands) =>
        [bottom, middle][commands.filter((command) => command === REWIND_SWIPE).length] ?? top,
    );
    const result = await tray.execute({
      action: "find",
      notification: { title: "Wear", body: "A" },
      awaitTimeout: 2000,
    });
    expect(result).toMatchObject({ isError: false, payload: { body: "A" } });
    expect(adb.getExecutedCommands()).toEqual([REWIND_SWIPE, REWIND_SWIPE, REWIND_SWIPE]);
  });

  test("a forward list keeps a different ongoing card that updates while it is read", async () => {
    let reads = 0;
    const done = withoutFooter(withBody("A done"));
    const { tray } = setup((commands) => {
      reads++;
      if (
        commands.includes("shell input keyevent 4") ||
        !commands.some((command) => command.startsWith("shell input swipe 192 370"))
      ) {
        return closed;
      }
      const swipes = forwardSwipes(commands);
      return swipes === 0 ? done : swipes === 1 ? withoutFooter(withBody(`B ${reads}%`)) : stream;
    });
    const result = await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 2000,
    });
    expect(result.isError).toBe(false);
    expect(result.payload.notifications).toMatchObject([
      { body: "A done" },
      { body: expect.stringMatching(/^B \d+%$/) },
      { body: "-i" },
    ]);
  });

  test("a forward list keeps distinct same-app cards snapped to identical bounds", async () => {
    const pages = [withoutFooter(retitled("First")), withoutFooter(retitled("Second")), stream];
    const { tray } = setup((commands) =>
      commands.includes("shell input keyevent 4") ||
      !commands.some((command) => command.startsWith("shell input swipe 192 370"))
        ? closed
        : (pages[forwardSwipes(commands)] ?? stream),
    );
    const result = await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 2000,
    });
    expect(result.isError).toBe(false);
    expect(result.payload.notifications).toMatchObject([
      { title: "First" },
      { title: "Second" },
      { title: "Wear" },
    ]);
  });

  test("rewinding keeps going past a different card at the same snapped bounds", async () => {
    const lower = retitled("Lower");
    const { tray, adb } = setup((commands) => (commands.includes(REWIND_SWIPE) ? stream : lower));
    const result = await tray.execute({
      action: "find",
      notification: { title: "Wear" },
      awaitTimeout: 500,
    });
    expect(result.isError).toBe(false);
    expect(adb.getExecutedCommands().filter((command) => command === REWIND_SWIPE)).toHaveLength(2);
  });
});

describe("Wear terminal evidence", () => {
  let originalActionScreenshotPolicy: string | undefined;
  beforeEach(() => {
    originalActionScreenshotPolicy = process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
  });
  afterEach(() => {
    if (originalActionScreenshotPolicy === undefined) {
      delete process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
    } else {
      process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT = originalActionScreenshotPolicy;
    }
    serverConfig.setAccessibilityAuditConfig(null);
  });

  test("captures the configured screenshot from the restored final observation", async () => {
    process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT = "false";
    // Distinct from the initial closed screen and the opened stream.
    const restoredScreen = { ...closed, updatedAt: 99 };
    const { tray, observer } = setup((commands) =>
      commands.includes("shell input keyevent 4")
        ? restoredScreen
        : commands.some((command) => command.startsWith("shell input swipe"))
          ? stream
          : closed,
    );
    const result = await tray.execute({
      action: "find",
      notification: { title: "Wear" },
      awaitTimeout: 500,
    });
    expect(result.isError).toBe(false);
    expect(result.payload.observation).toBe(restoredScreen);
    expect(observer.getCaptureScreenshotCallCount()).toBe(1);
    expect(observer.getCapturedScreenshotObservations()).toEqual([restoredScreen]);
    expect(observer.getAccessibilityAuditCallCount()).toBe(0);
  });

  test("runs the terminal accessibility audit when screenshots are skipped", async () => {
    delete process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
    const { tray, observer } = setup();
    await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(observer.getCaptureScreenshotCallCount()).toBe(0);
    expect(observer.getAccessibilityAuditCallCount()).toBe(1);
  });

  test("captures evidence for open", async () => {
    delete process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
    const { tray, observer } = setup();
    await tray.execute({ action: "open", awaitTimeout: 500 });
    expect(observer.getAccessibilityAuditCallCount()).toBe(1);
  });

  test("captures evidence for close from its closed observation", async () => {
    process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT = "false";
    const { tray, observer } = setup((commands) =>
      commands.includes("shell input keyevent 4") ? closed : stream,
    );
    const result = await tray.execute({ action: "close", awaitTimeout: 500 });
    expect(result.isError).toBe(false);
    expect(observer.getCapturedScreenshotObservations()).toEqual([closed]);
  });
});
