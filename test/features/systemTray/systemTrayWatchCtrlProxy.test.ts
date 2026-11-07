import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { ActionableError } from "../../../src/models";
import { SystemTray } from "../../../src/features/systemTray/SystemTray";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../../src/features/systemTray/systemTrayHelpers";
import {
  watchExpandedTarget,
  watchHasExpandedCard,
  watchNotifications,
  watchStreamScroll,
} from "../../../src/features/systemTray/helpers/watchHierarchy";
import { observeResultFromFixture } from "../../helpers/observeFixture";
import topCapture from "../../fixtures/wear/systemtray/ctrlproxy-stream-top.json";
import scrolledCapture from "../../fixtures/wear/systemtray/ctrlproxy-stream-scrolled.json";
import fixtureCardCapture from "../../fixtures/wear/systemtray/ctrlproxy-stream-fixture-card.json";
import page1Capture from "../../fixtures/wear/systemtray/ctrlproxy-stream-page-1.json";
import page2Capture from "../../fixtures/wear/systemtray/ctrlproxy-stream-page-2.json";
import midScreenCapture from "../../fixtures/wear/systemtray/ctrlproxy-stream-card-mid-screen.json";
import offscreenCapture from "../../fixtures/wear/systemtray/ctrlproxy-card-expanded-offscreen.json";
import headerOffscreenCapture from "../../fixtures/wear/systemtray/ctrlproxy-card-expanded-header-offscreen.json";
import expandedCapture from "../../fixtures/wear/systemtray/ctrlproxy-card-expanded.json";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured with CtrlProxy on a Wear OS 7 round emulator (API 37, android-wear-signed, 454x454):
// app name, time, title and body are siblings under one clickable card node, so no card has a
// title or body node of its own.
const capture = (raw: unknown, label: string): ObserveResult =>
  observeResultFromFixture(
    { updatedAt: 0, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 }, ...(raw as object) },
    label,
  );
const top = capture(topCapture, "stream-top");
const scrolled = capture(scrolledCapture, "stream-scrolled");
const withFixtureCard = capture(fixtureCardCapture, "stream-fixture-card");
const expanded = capture(expandedCapture, "card-expanded");
// The Fixture alert card below the stream's top, and its expanded form: only Reply is on screen.
const midScreen = capture(midScreenCapture, "stream-card-mid-screen");
// The same card scrolled up until its header left the screen, leaving only Reply, Archive and Open app.
const headerOffscreen = capture(headerOffscreenCapture, "card-expanded-header-offscreen");
const offscreen = capture(offscreenCapture, "card-expanded-offscreen");
// Two consecutive scan pages of one four-card stream: the second repeats TitleThree.
const page1 = capture(page1Capture, "stream-page-1");
const page2 = capture(page2Capture, "stream-page-2");
// A fake watch face, not a captured hierarchy.
const closed: ObserveResult = {
  ...top,
  viewHierarchy: { hierarchy: { node: { $: { bounds: "[0,0][454,454]" } } } },
};

const FIXTURE_APP = "dev.jasonpearson.automobile.wearfixture";
const BACK = "shell input keyevent 4";
const WHEEL = "shell input mouse scroll 227 227 --axis VSCROLL,3";
// Centres of the captured card, and of the Archive row of its expanded form.
const TAP_CARD = "shell input tap 227 195";
const TAP_ARCHIVE = "shell input tap 227 430";
const watch: BootedDevice = {
  deviceId: "fake-watch",
  name: "watch",
  platform: "android",
  formFactor: "watch",
};

afterEach(resetSystemTrayDependencies);

const LABELS: Record<string, string> = {
  "com.android.shell": "Shell",
  [FIXTURE_APP]: "AutoMobile Wear Fixture",
};

function setup(read: (commands: string[], reads: number) => ObserveResult) {
  const adb = new FakeAdbExecutor();
  const observer = new FakeObserveScreen();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let reads = 0;
  observer.setObserveResult(() => read(adb.getExecutedCommands(), reads++));
  setSystemTrayDependencies({
    adbFactory: () => adb,
    observeScreenFactory: () => observer,
    timer,
    appLabelResolver: async (_device, appId) => LABELS[appId] ?? appId,
    appInventoryFactory: () => ({
      executeDetailedResult: async () => ({
        successful: true,
        apps: {
          profiles: {},
          system: [
            { packageName: "com.android.shell", userIds: [0], foreground: false, recent: false },
            { packageName: FIXTURE_APP, userIds: [0], foreground: false, recent: false },
          ],
        },
      }),
    }),
  });
  return { adb, timer, tray: new SystemTray(watch) };
}

describe("Wear OS 7 CtrlProxy card capture", () => {
  test("reads title and body from the card's text lines, not the whole card as a header", () => {
    expect(
      watchNotifications(top.viewHierarchy).map(({ appLabel, title, body }) => [
        appLabel,
        title,
        body,
      ]),
    ).toEqual([
      ["Shell", "Bravo", "bravo"],
      ["Android System", "Connect to open Wi‑Fi network", "AndroidWifi"],
    ]);
  });

  test("lists each card once, with its own bounds", () => {
    const cards = watchNotifications(scrolled.viewHierarchy);
    expect(cards.map((card) => card.element.bounds.top)).toEqual([0, 107, 291]);
  });

  test("keeps an expanded card's action rows out of its body", () => {
    expect(watchNotifications(expanded.viewHierarchy)).toMatchObject([
      { title: "Fixture alert", body: "Two actions follow" },
    ]);
  });

  test("knows the stream is at its top only while it cannot scroll back", () => {
    expect(watchStreamScroll(top.viewHierarchy)).toBe("top");
    expect(watchStreamScroll(scrolled.viewHierarchy)).toBe("scrolled");
    expect(watchStreamScroll(closed.viewHierarchy)).toBe("unknown");
  });

  test("finds an action inside the expanded card while the stream root stays in the tree", () => {
    expect(watchHasExpandedCard(expanded.viewHierarchy)).toBe(true);
    expect(watchHasExpandedCard(top.viewHierarchy)).toBe(false);
    expect(watchExpandedTarget(expanded.viewHierarchy, "Archive")?.bounds).toEqual({
      left: 43,
      top: 407,
      right: 411,
      bottom: 454,
    });
    expect(watchExpandedTarget(expanded.viewHierarchy, "Nope")).toBeUndefined();
    // The card's header scrolled out of the capture; its actions are still found.
    expect(watchNotifications(headerOffscreen.viewHierarchy).map((card) => card.appLabel)).toEqual([
      "Shell",
    ]);
    expect(watchExpandedTarget(headerOffscreen.viewHierarchy, "Archive")).toBeDefined();
    // A collapsed stream has no expanded card to search.
    expect(watchExpandedTarget(top.viewHierarchy, "Bravo")).toBeUndefined();
  });
});

describe("Wear OS 7 stream actions", () => {
  test("list returns each card once with its title and body", async () => {
    const { tray } = setup(() => top);
    const result = await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(result.isError).toBe(false);
    expect(result.payload.notifications).toMatchObject([{ title: "Bravo", body: "bravo" }]);
  });

  test("list returns a card shown on two scan pages once and skips the card cut off at the edge", async () => {
    const { tray, adb } = setup((commands) => {
      const scans = commands.filter(
        (command) => command === "shell input swipe 227 340 227 113 500",
      );
      return scans.length === 0 ? page1 : page2;
    });
    const result = await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 5000,
    });
    expect(result.isError).toBe(false);
    expect((result.payload.notifications as { title: string }[]).map((card) => card.title)).toEqual(
      ["TitleFour", "TitleThree", "TitleTwo"],
    );
    expect(adb.getExecutedCommands()).not.toContain(WHEEL);
  });

  test("list waits for a scroll that is not drawn yet instead of ending the scan", async () => {
    const SCAN = "shell input swipe 227 340 227 113 500";
    let readsAfterSwipe = 0;
    const { tray } = setup((commands) => {
      if (!commands.includes(SCAN)) {
        return page1;
      }
      return readsAfterSwipe++ < 2 ? page1 : page2;
    });
    const result = await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 5000,
    });
    expect((result.payload.notifications as { title: string }[]).map((card) => card.title)).toEqual(
      ["TitleFour", "TitleThree", "TitleTwo"],
    );
  });

  test("tap with an action label taps the action inside the expanded card", async () => {
    const { tray, adb } = setup((commands) =>
      commands.includes(TAP_CARD) ? expanded : withFixtureCard,
    );
    const result = await tray.execute({
      action: "tap",
      notification: { appId: FIXTURE_APP, title: "Fixture alert", tapActionLabel: "Archive" },
      awaitTimeout: 500,
    });
    expect(result).toMatchObject({
      isError: false,
      payload: { message: "Tapped watch notification" },
    });
    expect(adb.getExecutedCommands().filter((command) => command.includes("input tap"))).toEqual([
      TAP_CARD,
      TAP_ARCHIVE,
    ]);
  });

  test("tap scrolls an expanded card's off-screen action into view first", async () => {
    const SCROLL_UP = "shell input swipe 227 317 227 158 400";
    const { tray, adb } = setup((commands) => {
      if (!commands.includes("shell input tap 227 285")) {
        return midScreen;
      }
      return commands.includes(SCROLL_UP) ? expanded : offscreen;
    });
    const result = await tray.execute({
      action: "tap",
      notification: { appId: FIXTURE_APP, title: "Fixture alert", tapActionLabel: "Archive" },
      awaitTimeout: 500,
    });
    expect(result.isError).toBe(false);
    expect(adb.getExecutedCommands().filter((command) => command.includes("input tap"))).toEqual([
      "shell input tap 227 285",
      TAP_ARCHIVE,
    ]);
  });

  test("tap waits for the card to finish expanding", async () => {
    let afterTap = 0;
    const { tray, adb } = setup((commands) => {
      if (!commands.includes(TAP_CARD)) {
        return withFixtureCard;
      }
      return afterTap++ < 2 ? withFixtureCard : expanded;
    });
    await tray.execute({
      action: "tap",
      notification: { appId: FIXTURE_APP, title: "Fixture alert", tapActionLabel: "Archive" },
      awaitTimeout: 500,
    });
    expect(adb.getExecutedCommands()).toContain(TAP_ARCHIVE);
  });

  test("tap collapses the card it expanded before leaving an already-open stream", async () => {
    const { tray, adb } = setup((commands) => {
      const afterTap = commands.includes(TAP_ARCHIVE);
      if (!commands.includes(TAP_CARD)) {
        return withFixtureCard;
      }
      return afterTap && commands.includes(BACK) ? withFixtureCard : expanded;
    });
    await tray.execute({
      action: "tap",
      notification: { appId: FIXTURE_APP, title: "Fixture alert", tapActionLabel: "Archive" },
      awaitTimeout: 500,
    });
    expect(adb.getExecutedCommands().filter((command) => command === BACK)).toHaveLength(1);
  });

  test("does not rewind a stream that is already at its top", async () => {
    const { tray, adb } = setup(() => top);
    await tray.execute({
      action: "find",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("rewinds a freshly opened stream that came back scrolled", async () => {
    const { tray, adb } = setup((commands) => {
      if (
        commands.includes(BACK) ||
        !commands.some((command) => command.startsWith("shell input swipe 227 438"))
      ) {
        return closed;
      }
      return commands.includes(WHEEL) ? top : scrolled;
    });
    await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(adb.getExecutedCommands()).toContain(WHEEL);
  });

  test("rewinds a scrolled stream with wheel steps, never a finger swipe", async () => {
    const { tray, adb } = setup((commands) => (commands.includes(WHEEL) ? top : scrolled));
    const result = await tray.execute({
      action: "find",
      notification: { appId: "com.android.shell", title: "Bravo" },
      awaitTimeout: 500,
    });
    expect(result.isError).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([WHEEL]);
  });
});

describe("closing the stream after an action", () => {
  // The face the open gesture starts from, then the stream, which slides out after Back.
  const slidingOut = (readsAfterBack: number) => {
    let afterBack = 0;
    return (commands: string[]) => {
      if (!commands.some((command) => command.startsWith("shell input swipe"))) {
        return closed;
      }
      if (!commands.includes(BACK)) {
        return top;
      }
      return afterBack++ < readsAfterBack ? top : closed;
    };
  };

  test("waits for the stream to finish sliding out instead of failing the action", async () => {
    const { tray, adb, timer } = setup(slidingOut(2));
    const result = await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(result.isError).toBe(false);
    expect(adb.getExecutedCommands().filter((command) => command === BACK)).toHaveLength(1);
    expect(timer.getSleepHistory().filter((ms) => ms === 250).length).toBeGreaterThanOrEqual(2);
  });

  test("reports a stream that never closes without pressing Back again on the watch face", async () => {
    const { tray, adb } = setup(slidingOut(Number.POSITIVE_INFINITY));
    await expect(
      tray.execute({
        action: "list",
        notification: { appId: "com.android.shell" },
        awaitTimeout: 500,
      }),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(adb.getExecutedCommands().filter((command) => command === BACK)).toHaveLength(1);
  });
});
