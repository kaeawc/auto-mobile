import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { SystemTray } from "../../../src/features/systemTray/SystemTray";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../../src/features/systemTray/systemTrayHelpers";
import {
  watchNodes,
  watchStreamRoot,
} from "../../../src/features/systemTray/helpers/watchHierarchy";
import { capturedLauncherHierarchy } from "../../helpers/capturedLauncherHierarchy";
import { buildObserveResult, observeResultFromFixture } from "../../helpers/observeFixture";
import launcherCapture from "../../fixtures/wear/systemtray/ctrlproxy-alert-shy-over-launcher.json";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

const watch: BootedDevice = {
  deviceId: "fake-watch",
  name: "watch",
  platform: "android",
  formFactor: "watch",
};
const SWIPE = "shell input swipe 192 176 364 176 300";
// Centre of the captured X button, [19,92][128,260].
const TAP_X = "shell input tap 73 176";
const closed = buildObserveResult({
  updatedAt: 0,
  screenSize: { width: 384, height: 384 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: { hierarchy: { node: { $: { bounds: "[0,0][384,384]" } } } },
});
let single: ObserveResult;
let revealed: ObserveResult;
let emptied: ObserveResult;
// The captured reveal with its buttons moved to another row: the swipe landed on a different card.
let revealedElsewhere: ObserveResult;
// Captured on an API 37 Wear OS 7 emulator with three stacked cards: the stream at its top (the
// second card is cut off by the bottom edge) and after one page scroll (fully visible).
let stackedTop: ObserveResult;
let stackedScrolled: ObserveResult;
// The scrolled page mid-animation: every card still 10 px lower than where it comes to rest.
let stackedSliding: ObserveResult;
const SCROLL = "shell input swipe 192 288 192 96 500";
// Bravo's bounds after the scroll are [19,81][365,249]; before it only [32,269][352,384] showed.
const SWIPE_BRAVO = "shell input swipe 192 165 364 165 300";
const SWIPE_BRAVO_CLIPPED = "shell input swipe 192 326 364 326 300";
const SWIPE_CHARLIE = "shell input swipe 192 177 364 177 300";

beforeAll(async () => {
  single = {
    ...closed,
    viewHierarchy: await capturedLauncherHierarchy(
      "wear/systemtray/notification-stream-single-card.xml",
    ),
  };
  const revealedHierarchy = await capturedLauncherHierarchy(
    "wear/systemtray/notification-stream-dismiss-revealed.xml",
  );
  revealed = { ...closed, viewHierarchy: revealedHierarchy };
  const elsewhereHierarchy = structuredClone(revealedHierarchy);
  const elsewhereRoot = watchStreamRoot(elsewhereHierarchy);
  for (const node of elsewhereRoot ? watchNodes(elsewhereRoot) : []) {
    if (node.$ && String(node.$["resource-id"]).endsWith(":id/notification_str_clear_button")) {
      node.$.bounds = "[19,300][128,384]";
    }
  }
  revealedElsewhere = { ...closed, viewHierarchy: elsewhereHierarchy };
  stackedTop = {
    ...closed,
    viewHierarchy: await capturedLauncherHierarchy(
      "wear/systemtray/notification-stream-three-cards-top.xml",
    ),
  };
  stackedScrolled = {
    ...closed,
    viewHierarchy: await capturedLauncherHierarchy(
      "wear/systemtray/notification-stream-scrolled-three-cards.xml",
    ),
  };
  const slidingHierarchy = structuredClone(stackedScrolled.viewHierarchy);
  const slidingRoot = watchStreamRoot(slidingHierarchy);
  for (const node of slidingRoot ? watchNodes(slidingRoot) : []) {
    const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(String(node.$?.bounds ?? ""));
    if (node.$ && match && match[2] !== "0") {
      const [left, top, right, bottom] = match.slice(1).map(Number);
      node.$.bounds = `[${left},${top + 10}][${right},${bottom + 10}]`;
    }
  }
  stackedSliding = { ...closed, viewHierarchy: slidingHierarchy };
  // Models removal by pruning the captured container; not a second device capture.
  const prunedHierarchy = structuredClone(revealedHierarchy);
  const root = watchStreamRoot(prunedHierarchy);
  for (const node of root ? watchNodes(root) : []) {
    if (node.$?.["resource-id"] === "com.google.android.clockwork.sysui:id/trayview_container") {
      node.node = [];
    }
  }
  emptied = { ...closed, viewHierarchy: prunedHierarchy };
});
afterEach(resetSystemTrayDependencies);

function setup(read: (commands: string[]) => ObserveResult) {
  const adb = new FakeAdbExecutor();
  const observer = new FakeObserveScreen();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  observer.setObserveResult(() => read(adb.getExecutedCommands()));
  setSystemTrayDependencies({ adbFactory: () => adb, observeScreenFactory: () => observer, timer });
  return { adb, tray: new SystemTray(watch) };
}

describe("Wear OS 7 dismiss reveals the X button", () => {
  test("taps the revealed X after the swipe and confirms the removal", async () => {
    const { adb, tray } = setup((commands) =>
      commands.includes(TAP_X) ? emptied : commands.includes(SWIPE) ? revealed : single,
    );
    const result = await tray.execute({
      action: "dismiss",
      notification: { title: "Zebra" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({ isError: false, payload: { dismissedCount: 1, success: true } });
    const commands = adb.getExecutedCommands();
    expect(commands.indexOf(TAP_X)).toBeGreaterThan(commands.indexOf(SWIPE));
  });

  test("does not claim dismissal when the X tap leaves the card in place", async () => {
    const { tray } = setup((commands) => (commands.includes(SWIPE) ? revealed : single));
    const result = await tray.execute({
      action: "dismiss",
      notification: { title: "Zebra" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({ isError: true, payload: { code: "dismissal_unconfirmed" } });
  });
});

describe("Wear OS 7 dismiss never taps another card's X", () => {
  test("leaves the buttons revealed on a different row untouched", async () => {
    const { adb, tray } = setup((commands) =>
      commands.includes(SWIPE) ? revealedElsewhere : single,
    );
    const result = await tray.execute({
      action: "dismiss",
      notification: { title: "Zebra" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({ isError: true, payload: { code: "dismissal_unconfirmed" } });
    expect(adb.getExecutedCommands().filter((command) => command.includes("input tap"))).toEqual(
      [],
    );
  });
});

describe("Wear OS 7 dismiss targets the requested card with several stacked", () => {
  test("scrolls a card cut off by the screen edge into view and swipes its current bounds", async () => {
    const { adb, tray } = setup((commands) =>
      commands.includes(TAP_X)
        ? emptied
        : commands.includes(SWIPE_BRAVO)
          ? revealed
          : commands.includes(SCROLL)
            ? stackedScrolled
            : stackedTop,
    );
    const result = await tray.execute({
      action: "dismiss",
      notification: { title: "Card Bravo" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({ isError: false, payload: { dismissedCount: 1, success: true } });
    const commands = adb.getExecutedCommands();
    expect(commands).not.toContain(SWIPE_BRAVO_CLIPPED);
    expect(commands.indexOf(SWIPE_BRAVO)).toBeGreaterThan(commands.indexOf(SCROLL));
  });

  test("swipes a fully visible card without scrolling", async () => {
    const { adb, tray } = setup((commands) =>
      commands.includes(TAP_X) ? emptied : commands.includes(SWIPE_CHARLIE) ? revealed : stackedTop,
    );
    await tray.execute({
      action: "dismiss",
      notification: { title: "Card Charlie" },
      awaitTimeout: 500,
    });
    expect(adb.getExecutedCommands()).toContain(SWIPE_CHARLIE);
    expect(adb.getExecutedCommands()).not.toContain(SCROLL);
  });

  test("swipes where the card stopped, not where an animating read placed it", async () => {
    // After the scroll: the page the scan reads and one more read mid-animation, then settled.
    const frames = [stackedSliding, stackedScrolled, stackedScrolled];
    let reads = 0;
    const { adb, tray } = setup((commands) => {
      if (commands.includes(TAP_X)) {
        return emptied;
      }
      if (commands.includes(SWIPE_BRAVO)) {
        return revealed;
      }
      return commands.includes(SCROLL) ? frames[Math.min(reads++, frames.length - 1)] : stackedTop;
    });
    const result = await tray.execute({
      action: "dismiss",
      notification: { title: "Card Bravo" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({ isError: false, payload: { dismissedCount: 1 } });
    const swipes = adb.getExecutedCommands().filter((command) => command.includes("input swipe"));
    expect(swipes.filter((command) => command.endsWith(" 300"))).toEqual([SWIPE_BRAVO]);
  });
});

// Captured with CtrlProxy on a Wear OS 7 round emulator (API 37, 384x384): the app list
// (AllAppsLauncherActivity, `appsList`), which Back opens from the watch face.
const appList = observeResultFromFixture(
  { updatedAt: 0, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 }, ...launcherCapture },
  "alert-shy-over-launcher",
);
// A fake third-party app in front, not a captured hierarchy.
const APP = "dev.example.accept";
const app: ObserveResult = {
  ...closed,
  viewHierarchy: { packageName: APP, hierarchy: { node: { $: { bounds: "[0,0][384,384]" } } } },
  activeWindow: { appId: APP, activityName: `${APP}.MainActivity`, layoutSeqSum: 0 },
};
const BACK = "shell input keyevent 4";
const HOME = "shell input keyevent KEYCODE_HOME";
const OPEN = "shell input swipe 192 370 192 119 900";
/**
 * Reads after the X tap up to and including the one cleanup decides from that the stream is still
 * open: the dismissal's confirmation read, then cleanup's first read.
 */
const READS_UNTIL_CLEANUP_DECIDES = 2;

type Surface = "app" | "face" | "stream" | "revealed" | "emptied" | "appList";
const surfaces = (): Record<Surface, ObserveResult> => ({
  app,
  face: closed,
  stream: single,
  revealed,
  emptied,
  appList,
});

/**
 * A watch with an app in front and one card posted. After its last card is removed, the stream
 * closes on its own once `selfCloseAfter` reads have seen it emptied; the close lands before the
 * next read or key. Back closes a showing stream onto the watch face, and on the face opens the
 * app list, as on a device.
 */
function dismissFromApp(selfCloseAfter: number) {
  let surface: Surface = "app";
  let handled = 0;
  let readsSinceTap = 0;
  const closeIfDue = () => {
    if (surface === "emptied" && readsSinceTap >= selfCloseAfter) {
      surface = "face";
    }
  };
  const press = (command: string) => {
    closeIfDue();
    const next: Partial<Record<string, Partial<Record<Surface, Surface>>>> = {
      [HOME]: { app: "face" },
      [OPEN]: { face: "stream" },
      [SWIPE]: { stream: "revealed" },
      [TAP_X]: { revealed: "emptied" },
      [BACK]: { face: "appList", stream: "face", revealed: "face", emptied: "face" },
    };
    surface = next[command]?.[surface] ?? surface;
    if (command === TAP_X) {
      readsSinceTap = 0;
    }
  };
  return (commands: string[]): ObserveResult => {
    commands.slice(handled).forEach(press);
    handled = commands.length;
    closeIfDue();
    readsSinceTap += 1;
    return surfaces()[surface];
  };
}

describe("Wear dismiss started from inside an app restores the watch face (#17546)", () => {
  const dismiss = (tray: SystemTray) =>
    tray.execute({ action: "dismiss", notification: { title: "Zebra" }, awaitTimeout: 500 });

  test("closes a stream that is still showing with one Back onto the watch face", async () => {
    const { adb, tray } = setup(dismissFromApp(Number.POSITIVE_INFINITY));
    const result = await dismiss(tray);
    expect(result).toMatchObject({ isError: false, payload: { dismissedCount: 1, success: true } });
    expect(result.payload.observation).toBe(closed);
    const commands = adb.getExecutedCommands();
    expect(commands[0]).toBe(HOME);
    expect(commands.filter((command) => command === BACK)).toHaveLength(1);
  });

  test("does not press Back when the stream closed between the last read and the Back", async () => {
    const { adb, tray } = setup(dismissFromApp(READS_UNTIL_CLEANUP_DECIDES));
    const result = await dismiss(tray);
    expect(result).toMatchObject({ isError: false, payload: { dismissedCount: 1, success: true } });
    expect(result.payload.observation).toBe(closed);
    expect(adb.getExecutedCommands()).not.toContain(BACK);
  });

  test("reports dismissal_unconfirmed when cleanup leaves the watch on the app list", async () => {
    // A Back that lands on the watch face anyway (the close finished after the fresh read).
    const model = dismissFromApp(Number.POSITIVE_INFINITY);
    const { adb, tray } = setup((commands) => {
      const shown = model(commands);
      return commands.includes(BACK) ? appList : shown;
    });
    const result = await dismiss(tray);
    expect(result).toMatchObject({
      isError: true,
      payload: { code: "dismissal_unconfirmed", dismissedCount: 1, success: false },
    });
    expect(String(result.payload.message)).toContain("left the watch on the app list");
    expect(result.payload.observation).toBe(appList);
    expect(adb.getExecutedCommands().filter((command) => command === BACK)).toHaveLength(1);
  });
});
