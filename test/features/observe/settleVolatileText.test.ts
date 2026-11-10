import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type {
  ObserveDiff,
  ObserveDiffNode,
} from "../../../src/features/observe/output/ObserveResultOutput";
import { VolatileTextTracker } from "../../../src/features/observe/settleVolatileText";
import {
  RealSettleObserve,
  isStabilityDiffEmpty,
} from "../../../src/features/observe/SettleObserve";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { TestHierarchyNode } from "./observeScreenTestBuilders";

/**
 * Volatile-text masking in the settle comparator (#17670).
 *
 * Fixtures come from a running stopwatch in the Android 15 Clock app, captured
 * on an emulator during the #17663 research: every unstable diff was a text
 * change on `stopwatch_hundredths_text` (every poll) and sometimes
 * `stopwatch_time_text` (once a second), never a structural change.
 */

const HUNDREDTHS_ID = "com.google.android.deskclock:id/stopwatch_hundredths_text";
const TIME_ID = "com.google.android.deskclock:id/stopwatch_time_text";
const HUNDREDTHS_BOUNDS = { left: 588, top: 1046, right: 732, bottom: 1219 };
const TIME_BOUNDS = { left: 348, top: 873, right: 732, bottom: 1121 };
const TEXT_ACTIONS = [
  "select",
  "clear_selection",
  "accessibility_focus",
  "next_at_movement_granularity",
  "previous_at_movement_granularity",
  "set_selection",
];

/** A diff node exactly as `diffObserveResult` reported it on the device. */
function capturedNode(
  resourceId: string,
  bounds: typeof HUNDREDTHS_BOUNDS,
  text: string,
  siblingIndex: number,
): ObserveDiffNode {
  const boundsKey = [bounds.left, bounds.top, bounds.right, bounds.bottom].join(",");
  return {
    key: [resourceId, boundsKey, text, siblingIndex].join("\0"),
    attributes: {
      actions: TEXT_ACTIONS,
      text,
      "resource-id": resourceId,
      "visible-to-user": true,
      "view-id": resourceId,
      bounds,
    },
  };
}

const hundredths = (text: string) => capturedNode(HUNDREDTHS_ID, HUNDREDTHS_BOUNDS, text, 2);
const time = (text: string) => capturedNode(TIME_ID, TIME_BOUNDS, text, 1);

function diff(added: ObserveDiffNode[], removed: ObserveDiffNode[]): ObserveDiff {
  return { isDiff: true, skeleton: [], added, removed, changed: [] };
}

/** The last three consecutive unstable diffs of the captured settle loop, in order. */
const CAPTURED_STOPWATCH_DIFFS: readonly ObserveDiff[] = [
  diff([time("6:16"), hundredths("20")], [time("6:15"), hundredths("97")]),
  diff([hundredths("47")], [hundredths("20")]),
  diff([hundredths("70")], [hundredths("47")]),
];

describe("VolatileTextTracker (#17670)", () => {
  test("masks the stopwatch from its third consecutive text change, from the captured diffs", () => {
    const tracker = new VolatileTextTracker();
    const stable = CAPTURED_STOPWATCH_DIFFS.map((captured) =>
      isStabilityDiffEmpty(tracker.mask(captured)),
    );
    // The second consecutive change marks the node volatile but still counts
    // (#17692); only the third and later changes are masked.
    expect(stable).toEqual([false, false, true]);
    expect(tracker.volatileCount).toBe(1);
  });

  test("a once-a-second tick is not volatile and still counts", () => {
    const tracker = new VolatileTextTracker();
    tracker.mask(diff([hundredths("20")], [hundredths("97")]));
    tracker.mask(diff([hundredths("47")], [hundredths("20")]));
    const masked = tracker.mask(
      diff([time("6:17"), hundredths("70")], [time("6:16"), hundredths("47")]),
    );
    expect(masked.added).toEqual([time("6:17")]);
    expect(masked.removed).toEqual([time("6:16")]);
  });

  test("structural changes still count after the node is volatile", () => {
    const tracker = new VolatileTextTracker();
    tracker.mask(diff([hundredths("20")], [hundredths("97")]));
    tracker.mask(diff([hundredths("47")], [hundredths("20")]));

    // A new node appears alongside the tick.
    const lapRow = capturedNode("com.google.android.deskclock:id/lap", TIME_BOUNDS, "Lap 1", 3);
    const appeared = tracker.mask(diff([hundredths("70"), lapRow], [hundredths("47")]));
    expect(appeared.added).toEqual([lapRow]);
    expect(appeared.removed).toEqual([]);

    // The volatile node disappears: removed with no counterpart.
    expect(isStabilityDiffEmpty(tracker.mask(diff([], [hundredths("70")])))).toBe(false);
  });

  test("changing capture metadata does not stop a ticking node becoming volatile", () => {
    const tracker = new VolatileTextTracker();
    const withExtras = (node: ObserveDiffNode, traversalIndex: number): ObserveDiffNode => ({
      ...node,
      attributes: { ...node.attributes, extras: { traversalIndex }, occlusionState: "visible" },
    });
    tracker.mask(diff([withExtras(hundredths("20"), 2)], [withExtras(hundredths("97"), 1)]));
    tracker.mask(diff([withExtras(hundredths("47"), 3)], [withExtras(hundredths("20"), 2)]));
    const third = tracker.mask(
      diff([withExtras(hundredths("70"), 4)], [withExtras(hundredths("47"), 3)]),
    );
    expect(isStabilityDiffEmpty(third)).toBe(true);
  });

  test("a pair with no text change is a move, never a text change", () => {
    const tracker = new VolatileTextTracker();
    // A textless control that moves between containers keeps its local key.
    const button = capturedNode("", HUNDREDTHS_BOUNDS, "", 0);
    const moved = diff([button], [button]);
    expect(isStabilityDiffEmpty(tracker.mask(moved))).toBe(false);
    expect(isStabilityDiffEmpty(tracker.mask(moved))).toBe(false);
    expect(tracker.volatileCount).toBe(0);
  });

  test("a volatile node that changes more than its text still counts", () => {
    const tracker = new VolatileTextTracker();
    tracker.mask(diff([hundredths("20")], [hundredths("97")]));
    tracker.mask(diff([hundredths("47")], [hundredths("20")]));
    const focused = hundredths("70");
    focused.attributes = { ...focused.attributes, focused: true };
    expect(isStabilityDiffEmpty(tracker.mask(diff([focused], [hundredths("47")])))).toBe(false);
  });

  test("a matched node whose only change is its text is a text change", () => {
    const tracker = new VolatileTextTracker();
    const key = hundredths("00").key;
    const textChange = (from: string, to: string): ObserveDiff => ({
      ...diff([], []),
      changed: [{ key, changes: { text: { from, to } } }],
    });
    expect(isStabilityDiffEmpty(tracker.mask(textChange("1", "2")))).toBe(false);
    expect(isStabilityDiffEmpty(tracker.mask(textChange("2", "3")))).toBe(false);
    expect(isStabilityDiffEmpty(tracker.mask(textChange("3", "4")))).toBe(true);
  });

  test("a matched node sharing a volatile identity still reports its other changes", () => {
    const tracker = new VolatileTextTracker();
    tracker.mask(diff([hundredths("20")], [hundredths("97")]));
    tracker.mask(diff([hundredths("47")], [hundredths("20")]));
    // A node in another subtree with the same local identity flips `checked`.
    const toggled: ObserveDiff = {
      ...diff([hundredths("70")], [hundredths("47")]),
      changed: [{ key: hundredths("47").key, changes: { checked: { from: false, to: true } } }],
    };
    const masked = tracker.mask(toggled);
    expect(masked.added).toEqual([]);
    expect(masked.changed).toEqual(toggled.changed);
    expect(isStabilityDiffEmpty(masked)).toBe(false);
  });

  test("top-level field changes are never masked", () => {
    const tracker = new VolatileTextTracker();
    tracker.mask(CAPTURED_STOPWATCH_DIFFS[1]);
    tracker.mask(CAPTURED_STOPWATCH_DIFFS[2]);
    const rotated = { ...CAPTURED_STOPWATCH_DIFFS[2], fields: { rotation: { from: 0, to: 1 } } };
    expect(isStabilityDiffEmpty(tracker.mask(rotated))).toBe(false);
  });

  test("two text changes on one node that then stop are never masked (#17692)", () => {
    const tracker = new VolatileTextTracker();
    // A real transition: a title rewritten twice ("Loading" -> "Signing in" -> "Welcome").
    const title = (text: string) => capturedNode("com.example:id/title", TIME_BOUNDS, text, 0);
    const stable = [
      diff([title("Signing in")], [title("Loading")]),
      diff([title("Welcome")], [title("Signing in")]),
      diff([], []),
    ].map((step) => isStabilityDiffEmpty(tracker.mask(step)));
    expect(stable).toEqual([false, false, true]);
  });

  test("reset forgets volatile nodes", () => {
    const tracker = new VolatileTextTracker();
    tracker.mask(CAPTURED_STOPWATCH_DIFFS[1]);
    tracker.mask(CAPTURED_STOPWATCH_DIFFS[2]);
    tracker.reset();
    expect(tracker.volatileCount).toBe(0);
    expect(isStabilityDiffEmpty(tracker.mask(CAPTURED_STOPWATCH_DIFFS[2]))).toBe(false);
  });
});

/** The Clock app's stopwatch screen as a hierarchy, at one tick. */
function stopwatchScreen(
  timeText: string,
  hundredthsText: string,
  updatedAt: number,
  extra: { appId?: string; lap?: boolean } = {},
): ObserveResult {
  const textNode = (resourceId: string, bounds: typeof HUNDREDTHS_BOUNDS, text: string) => ({
    class: "android.widget.TextView",
    "resource-id": resourceId,
    "view-id": resourceId,
    "visible-to-user": true,
    actions: TEXT_ACTIONS,
    bounds,
    text,
  });
  const children: TestHierarchyNode[] = [
    {
      class: "android.widget.ImageButton",
      "resource-id": "com.google.android.deskclock:id/fab",
      bounds: { left: 456, top: 1900, right: 624, bottom: 2068 },
    },
    textNode(TIME_ID, TIME_BOUNDS, timeText),
    textNode(HUNDREDTHS_ID, HUNDREDTHS_BOUNDS, hundredthsText),
  ];
  if (extra.lap) {
    children.push(textNode("com.google.android.deskclock:id/lap", TIME_BOUNDS, "Lap 1"));
  }
  const appId = extra.appId ?? "com.google.android.deskclock";
  return {
    updatedAt,
    screenSize: { width: 1080, height: 2400 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId, activityName: ".DeskClock", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: appId,
      hierarchy: {
        node: {
          class: "android.widget.FrameLayout",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: children,
        },
      },
      updatedAt,
    },
  } as ObserveResult;
}

async function settle(sequence: ObserveResult[]) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const fake = new FakeObserveScreen();
  fake.setObserveSequence(sequence);
  return new RealSettleObserve(fake, timer).execute({ timeoutMs: 1000, pollMs: 150 });
}

describe("RealSettleObserve on a running stopwatch (#17670)", () => {
  test("settles on the fourth read instead of paying the whole budget", async () => {
    // The captured loop's per-poll texts, in order.
    const result = await settle([
      stopwatchScreen("6:15", "97", 10),
      stopwatchScreen("6:16", "20", 20),
      stopwatchScreen("6:16", "47", 30),
      stopwatchScreen("6:16", "70", 40),
      stopwatchScreen("6:16", "93", 50),
    ]);
    expect(result.settled).toBe(true);
    expect(result.terminalReason).toBe("settled");
    expect(result.polls).toBe(4);
    expect(result.waitMs).toBe(450);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(40);
  });

  test("a node appearing while the stopwatch ticks restarts the stable run", async () => {
    const result = await settle([
      stopwatchScreen("6:15", "97", 10),
      stopwatchScreen("6:16", "20", 20),
      stopwatchScreen("6:16", "47", 30, { lap: true }),
      stopwatchScreen("6:16", "70", 40, { lap: true }),
    ]);
    expect(result.settled).toBe(true);
    expect(result.polls).toBe(4);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(40);
  });

  test("one-off changes on two nodes sharing a local identity do not mask each other", async () => {
    // Two subtrees whose rows share resource id, bounds and sibling index.
    const twoRows = (a: string, b: string, updatedAt: number): ObserveResult => {
      const row = (text: string): TestHierarchyNode => ({
        class: "android.widget.LinearLayout",
        bounds: { left: 0, top: 0, right: 1080, bottom: 200 },
        node: [
          {
            class: "android.widget.TextView",
            "resource-id": "com.example:id/status",
            bounds: { left: 0, top: 0, right: 500, bottom: 100 },
            text,
          },
        ],
      });
      const screen = stopwatchScreen("6:15", "00", updatedAt);
      return {
        ...screen,
        viewHierarchy: {
          ...screen.viewHierarchy,
          hierarchy: {
            node: {
              class: "android.widget.FrameLayout",
              node: [
                { class: "android.widget.FrameLayout", node: [row(a)] },
                { class: "android.widget.ScrollView", node: [row(b)] },
              ],
            },
          },
        },
      } as ObserveResult;
    };
    const result = await settle([
      twoRows("A0", "B0", 10),
      twoRows("A1", "B0", 20),
      twoRows("A1", "B1", 30),
      twoRows("A1", "B2", 40),
      twoRows("A1", "B2", 50),
    ]);
    // Neither row changed twice in a row, so nothing is masked: the first stable
    // pair is the last two reads.
    expect(result.settled).toBe(true);
    expect(result.polls).toBe(5);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(50);
  });

  test("a ticking node that moves to another parent every read is not masked", async () => {
    const clock = (text: string): TestHierarchyNode => ({
      class: "android.widget.TextView",
      "resource-id": "com.example:id/clock",
      bounds: { left: 0, top: 0, right: 500, bottom: 100 },
      text,
    });
    // The clock alternates between two existing containers, keeping its local key.
    const screen = (text: string, inFirst: boolean, updatedAt: number): ObserveResult => {
      const base = stopwatchScreen("6:15", "00", updatedAt);
      return {
        ...base,
        viewHierarchy: {
          ...base.viewHierarchy,
          hierarchy: {
            node: {
              class: "android.widget.FrameLayout",
              node: [
                { class: "android.widget.FrameLayout", node: inFirst ? [clock(text)] : [] },
                { class: "android.widget.ScrollView", node: inFirst ? [] : [clock(text)] },
              ],
            },
          },
        },
      } as ObserveResult;
    };
    const result = await settle([
      screen("0", true, 10),
      screen("1", false, 20),
      screen("2", true, 30),
      screen("3", false, 40),
      screen("3", false, 50),
    ]);
    expect(result.settled).toBe(true);
    expect(result.polls).toBe(5);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(50);
  });

  test("a screen change during a motion read forgets volatile nodes", async () => {
    const other = { appId: "com.example.other" };
    // The new screen arrives mid-animation; motion reads are never diffed.
    const moving = stopwatchScreen("6:16", "1", 30, other);
    moving.viewHierarchy = {
      ...moving.viewHierarchy!,
      windows: [{ prototypeMotion: { active: 1 } }],
    } as NonNullable<ObserveResult["viewHierarchy"]>;
    const result = await settle([
      stopwatchScreen("6:15", "97", 10),
      stopwatchScreen("6:16", "20", 20),
      // The hundredths node turns volatile here, but a lap row keeps it unstable.
      stopwatchScreen("6:16", "33", 25, { lap: true }),
      moving,
      stopwatchScreen("6:16", "1", 40, other),
      // A one-off change on the new screen must not be masked by the old screen's state.
      stopwatchScreen("6:16", "2", 50, other),
      stopwatchScreen("6:16", "2", 60, other),
    ]);
    expect(result.settled).toBe(true);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(60);
  });

  test("a screen change forgets volatile nodes", async () => {
    const result = await settle([
      stopwatchScreen("6:15", "97", 10),
      stopwatchScreen("6:16", "20", 20),
      stopwatchScreen("6:16", "47", 30, { appId: "com.example.other" }),
      stopwatchScreen("6:16", "70", 40, { appId: "com.example.other" }),
      stopwatchScreen("6:16", "93", 50, { appId: "com.example.other" }),
      stopwatchScreen("6:16", "16", 60, { appId: "com.example.other" }),
    ]);
    // Three text changes on the new screen are needed again before it masks.
    expect(result.settled).toBe(true);
    expect(result.polls).toBe(6);
  });

  test("a transition of two text changes on one node is not masked as ticking text (#17692)", async () => {
    // The hundredths node is rewritten twice, then the screen grows a lap row:
    // the settle must not stop on the read before the row appears.
    const result = await settle([
      stopwatchScreen("6:15", "97", 10),
      stopwatchScreen("6:15", "20", 20),
      stopwatchScreen("6:15", "47", 30),
      stopwatchScreen("6:15", "47", 40, { lap: true }),
      stopwatchScreen("6:15", "47", 50, { lap: true }),
    ]);
    expect(result.settled).toBe(true);
    expect(result.polls).toBe(5);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(50);
  });
});
