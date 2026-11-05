import { afterEach, describe, expect, test } from "bun:test";
import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { wireCapture } from "../../helpers/wireCapture";

afterEach(() => {
  AndroidCtrlProxyClient.resetInstances();
});

/*
 * Inline model trees in the CtrlProxy / XCUITest capture shape: no device capture holds a
 * tappable row whose hoisted label comes partly from a child below the screen (#17024).
 *
 * A tappable " Alarm" row spans [0,500,400,900] on a 400x800 screen. Its "7:00" child sits
 * at [0,850,100,890], entirely below the screen, so the selector "7:00 Alarm" matches only
 * through the hoisted label. The row's visible part is [0,500,400,800].
 */
const screen = { left: 0, top: 0, right: 400, bottom: 800 };
const row = { left: 0, top: 500, right: 400, bottom: 900 };
const offScreenTime = { left: 0, top: 850, right: 100, bottom: 890 };

function alarmRow(rowBounds = row, timeBounds = offScreenTime) {
  return {
    text: " Alarm",
    clickable: "true",
    "resource-id": "alarm_row",
    bounds: rowBounds,
    node: [{ text: "7:00", bounds: timeBounds }],
  };
}

interface AndroidLayout {
  /** An application window (a dialog) above the app window. */
  dialog?: typeof screen;
  /** A control in the app window listed after the list, so drawn over it (a floating button). */
  fab?: typeof screen;
  /** A control in the app window listed before the list, so drawn under it. */
  backdrop?: typeof screen;
  rowBounds?: typeof screen;
}

/** Android: the row scrolls in a list in the app window. */
function androidCapture({ dialog, fab, backdrop, rowBounds = row }: AndroidLayout = {}) {
  const control = (id: string, bounds: typeof screen) => ({
    "resource-id": id,
    "content-desc": id,
    clickable: "true",
    bounds,
  });
  const list = {
    "resource-id": "alarm_list",
    scrollable: "true",
    bounds: screen,
    node: [alarmRow(rowBounds)],
  };
  const app = {
    bounds: screen,
    node: [
      ...(backdrop ? [control("backdrop", backdrop)] : []),
      list,
      ...(fab ? [control("add_alarm", fab)] : []),
    ],
  };
  const dialogNode = dialog && control("dialog_panel", dialog);
  return wireCapture({
    screenWidth: 400,
    screenHeight: 800,
    hierarchy: { node: dialogNode ? [app, dialogNode] : [app] },
    windows: [
      { type: 1, windowLayer: 0, bounds: screen, hierarchy: app },
      ...(dialogNode ? [{ type: 1, windowLayer: 1, bounds: dialog, hierarchy: dialogNode }] : []),
    ],
  });
}

/** iOS: one window; the row scrolls in a list, and an optional control is drawn above the list. */
function iosCapture(cover?: typeof screen, rowBounds = row): ViewHierarchyResult {
  return wireCapture({
    screenWidth: 400,
    screenHeight: 800,
    hierarchy: {
      node: {
        $: { class: "XCUIElementTypeWindow", bounds: screen },
        node: [
          {
            $: { class: "XCUIElementTypeScrollView", scrollable: true, bounds: screen },
            node: [
              {
                $: {
                  class: "XCUIElementTypeCell",
                  text: " Alarm",
                  clickable: true,
                  bounds: rowBounds,
                },
                node: [{ $: { class: "UILabel", text: "7:00", bounds: offScreenTime } }],
              },
            ],
          },
          ...(cover
            ? [
                {
                  $: {
                    class: "XCUIElementTypeButton",
                    clickable: true,
                    text: "Banner",
                    bounds: cover,
                  },
                },
              ]
            : []),
        ],
      },
    },
  });
}

async function tapOn(platform: "android" | "ios", capture: ViewHierarchyResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "test-device", platform, deviceId: "test-device" },
    new FakeAdbExecutor(),
    {
      timer,
      tapStrategy: platform === "ios" ? FakeTapStrategy.ios() : new FakeTapStrategy(),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  const observation: ObserveResult = {
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    observationId: "hoisted-label-visible-part",
    updatedAt: 1,
    screenSize: { width: 400, height: 800 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: capture,
  };
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
    observation,
  });
  tap.refreshViewHierarchy = async () => capture;
  tap.executeAndroidTap = async (_action, { x, y }) => {
    points.push({ x, y });
  };
  tap.testHooks.setIosCoordinateTap(async (_action, x, y) => {
    points.push({ x, y });
  });
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    effect: undefined,
    observation: current,
  });
  tap.testHooks.setTerminalScreenshotCapture(async () => {});
  tap.testHooks.setDeferredPredictionRecorder(async () => {});
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  const result = await tap.execute({ text: "7:00 Alarm", action: "tap" });
  return { result, points };
}

function inside(point: { x: number; y: number }, bounds: typeof screen): boolean {
  return (
    point.x >= bounds.left &&
    point.x < bounds.right &&
    point.y >= bounds.top &&
    point.y < bounds.bottom
  );
}

const visiblePart = { ...row, bottom: 800 };
const coversVisiblePart = { left: 0, top: 450, right: 400, bottom: 800 };
const coversTopOfVisiblePart = { left: 0, top: 500, right: 400, bottom: 720 };
const entirelyBelow = { left: 0, top: 820, right: 400, bottom: 900 };

describe("tapOn a hoisted label built partly from an off-screen child (#17024)", () => {
  describe("Android", () => {
    test("taps the visible part of the partly off-screen row", async () => {
      const { result, points } = await tapOn("android", androidCapture());
      expect(result.success).toBe(true);
      expect(points).toHaveLength(1);
      expect(inside(points[0]!, visiblePart)).toBe(true);
    });

    for (const [cover, layout] of [
      ["window", { dialog: coversTopOfVisiblePart }],
      ["view", { fab: coversTopOfVisiblePart }],
    ] as const) {
      test(`moves the tap off a ${cover} covering part of the visible row`, async () => {
        const { result, points } = await tapOn("android", androidCapture(layout));
        expect(result.success).toBe(true);
        expect(points).toHaveLength(1);
        expect(inside(points[0]!, { left: 0, top: 720, right: 400, bottom: 800 })).toBe(true);
      });
    }

    test("refuses with a typed error when a window covers the whole visible part", async () => {
      const { result, points } = await tapOn(
        "android",
        androidCapture({ dialog: coversVisiblePart }),
      );
      expect(points).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Target is covered by dialog_panel");
    });

    test("refuses with a typed error when a view in the window covers the whole visible part", async () => {
      const { result, points } = await tapOn("android", androidCapture({ fab: coversVisiblePart }));
      expect(points).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target is covered by "add_alarm"');
      expect(result.error).toContain("swipeOn");
    });

    test("ignores a control listed before the list, which the list draws over", async () => {
      const { result, points } = await tapOn(
        "android",
        androidCapture({ backdrop: coversVisiblePart }),
      );
      expect(result.success).toBe(true);
      expect(points).toHaveLength(1);
      expect(inside(points[0]!, visiblePart)).toBe(true);
    });

    test("refuses a row that is entirely off screen", async () => {
      const { result, points } = await tapOn(
        "android",
        androidCapture({ rowBounds: entirelyBelow }),
      );
      expect(points).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Scroll it into view with swipeOn");
    });
  });

  describe("iOS", () => {
    test("taps the visible part of the partly off-screen row", async () => {
      const { result, points } = await tapOn("ios", iosCapture());
      expect(result.success).toBe(true);
      expect(points).toHaveLength(1);
      expect(inside(points[0]!, visiblePart)).toBe(true);
    });

    test("moves the tap off a view covering part of the visible row", async () => {
      const { result, points } = await tapOn("ios", iosCapture(coversTopOfVisiblePart));
      expect(result.success).toBe(true);
      expect(points).toHaveLength(1);
      expect(inside(points[0]!, { left: 0, top: 720, right: 400, bottom: 800 })).toBe(true);
    });

    test("refuses with a typed error when a view covers the whole visible part", async () => {
      const { result, points } = await tapOn("ios", iosCapture(coversVisiblePart));
      expect(points).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target " Alarm" is covered by "Banner"');
    });

    test("refuses a row that is entirely off screen", async () => {
      const { result, points } = await tapOn("ios", iosCapture(undefined, entirelyBelow));
      expect(points).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Scroll it into view with swipeOn");
    });
  });
});
