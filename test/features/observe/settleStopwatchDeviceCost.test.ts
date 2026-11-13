import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type {
  ObserveDiff,
  ObserveDiffNode,
} from "../../../src/features/observe/output/ObserveResultOutput";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { SettleOptions } from "../../../src/features/observe/interfaces/SettleObserve";
import {
  RealSettleObserve,
  isStabilityDiffEmpty,
} from "../../../src/features/observe/SettleObserve";
import {
  VolatileTextTracker,
  splitVolatileChanges,
} from "../../../src/features/observe/settleVolatileText";
import { settleEmbeddedObservation } from "../../../src/server/embeddedObservationSettle";
import { embeddedObservationSettleTickExtensionMs } from "../../../src/server/embeddedObservationSettleBudget";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { TestHierarchyNode } from "./observeScreenTestBuilders";

/**
 * The Clock stopwatch on a device that charges real read costs (#17749).
 *
 * On the API 37 emulator a settle poll read cost about 250-330 ms, so the 1 s
 * embedded budget fit three or four reads: never enough for a running
 * stopwatch, whose tick has to be seen three times before it is masked, and a
 * terminal back-stack read. A paused stopwatch blinks its time text by fading
 * it to alpha 0 every half second, which flips `visible-to-user` and leaves the
 * text alone. Reads here cost 300 ms and the back-stack read 150 ms of fake time.
 */

const READ_MS = 300;
const BACK_STACK_MS = 150;
const BUDGET_MS = 1000;
const POLL_MS = 150;

const HUNDREDTHS_ID = "com.google.android.deskclock:id/stopwatch_hundredths_text";
const TIME_ID = "com.google.android.deskclock:id/stopwatch_time_text";
const HUNDREDTHS_BOUNDS = { left: 588, top: 1046, right: 732, bottom: 1219 };
const TIME_BOUNDS = { left: 348, top: 873, right: 732, bottom: 1121 };
const LAP_BOUNDS = { left: 0, top: 1300, right: 1080, bottom: 1400 };

interface StopwatchFrame {
  time: string;
  hundredths: string;
  /** False while a paused stopwatch's blink has faded the time text out. */
  visible?: boolean;
  laps?: number;
  appId?: string;
}

/** The Stopwatch tab as one capture. */
function stopwatchScreen(frame: StopwatchFrame, updatedAt: number): ObserveResult {
  const visible = frame.visible ?? true;
  const textNode = (resourceId: string, bounds: typeof TIME_BOUNDS, text: string) => ({
    class: "android.widget.TextView",
    "resource-id": resourceId,
    "visible-to-user": visible,
    bounds,
    text,
  });
  const children: TestHierarchyNode[] = [
    {
      class: "android.widget.ImageButton",
      "resource-id": "com.google.android.deskclock:id/fab",
      bounds: { left: 456, top: 1900, right: 624, bottom: 2068 },
    },
    textNode(TIME_ID, TIME_BOUNDS, frame.time),
    textNode(HUNDREDTHS_ID, HUNDREDTHS_BOUNDS, frame.hundredths),
  ];
  for (let lap = 1; lap <= (frame.laps ?? 0); lap++) {
    children.push({
      class: "android.widget.TextView",
      "resource-id": `com.google.android.deskclock:id/lap_${lap}`,
      "visible-to-user": true,
      bounds: {
        ...LAP_BOUNDS,
        top: LAP_BOUNDS.top + lap * 100,
        bottom: LAP_BOUNDS.bottom + lap * 100,
      },
      text: `Lap ${lap}`,
    });
  }
  const appId = frame.appId ?? "com.google.android.deskclock";
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

/** Every read and back-stack read takes fake time, like the emulator. */
class DeviceCostObserveScreen extends FakeObserveScreen {
  constructor(private readonly timer: FakeTimer) {
    super();
  }

  override async execute(options: ObserveScreenExecuteOptions = {}): Promise<ObserveResult> {
    const result = await super.execute(options);
    await this.timer.sleep(READ_MS);
    return result;
  }

  override async collectDeferredBackStack(
    observation: ObserveResult,
    options?: { signal?: AbortSignal },
  ): Promise<boolean | void> {
    await this.timer.sleep(BACK_STACK_MS);
    return super.collectDeferredBackStack(observation, options);
  }
}

/** The action's capture is updatedAt 5; poll reads start at 10. */
function deviceSettle(
  reference: StopwatchFrame,
  frames: readonly StopwatchFrame[],
  overrides: Partial<SettleOptions> = {},
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const screen = new DeviceCostObserveScreen(timer);
  screen.setObserveSequence(frames.map((frame, index) => stopwatchScreen(frame, 10 + index * 10)));
  const settle = new RealSettleObserve(screen, timer).execute({
    timeoutMs: BUDGET_MS,
    pollMs: POLL_MS,
    hardBudget: true,
    initialMinTimestampMs: 5,
    referenceObservation: stopwatchScreen(reference, 5),
    volatileExtensionMs: embeddedObservationSettleTickExtensionMs(BUDGET_MS),
    ...overrides,
  });
  return { settle, screen };
}

/** A running stopwatch: the hundredths change every read, the seconds once. */
const RUNNING: readonly StopwatchFrame[] = [
  { time: "6:15", hundredths: "97" },
  { time: "6:16", hundredths: "20" },
  { time: "6:16", hundredths: "47" },
  { time: "6:16", hundredths: "70" },
  { time: "6:16", hundredths: "93" },
  { time: "6:17", hundredths: "16" },
];
const RUNNING_ACTION_CAPTURE: StopwatchFrame = { time: "6:15", hundredths: "74" };

/** A paused stopwatch: same text every read, the blink flips its visibility. */
const PAUSED: readonly StopwatchFrame[] = [false, true, false, true, false].map((visible) => ({
  time: "6:16",
  hundredths: "47",
  visible,
}));
const PAUSED_ACTION_CAPTURE: StopwatchFrame = { time: "6:16", hundredths: "47", visible: true };

describe("settle on a running stopwatch at device read cost (#17749)", () => {
  test("without the action capture or the extension the budget cuts it off", async () => {
    const { settle } = deviceSettle(RUNNING_ACTION_CAPTURE, RUNNING, {
      referenceObservation: undefined,
      volatileExtensionMs: 0,
    });
    const result = await settle;
    expect(result.settled).toBe(false);
    expect(result.waitMs).toBeLessThanOrEqual(BUDGET_MS + 1);
  });

  test("settles on the third read once the action capture seeds the tick", async () => {
    const { settle, screen } = deviceSettle(RUNNING_ACTION_CAPTURE, RUNNING);
    const result = await settle;
    expect(result.settled).toBe(true);
    expect(result.terminalReason).toBe("settled");
    expect(result.polls).toBe(3);
    // Reads at 0-300, 450-750 and 900-1200, then the back-stack read to 1350.
    expect(result.waitMs).toBe(1350);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(30);
    expect(screen.getCollectDeferredBackStackCallCount()).toBe(1);
  });

  test("the action capture alone is not enough at this read cost", async () => {
    const { settle } = deviceSettle(RUNNING_ACTION_CAPTURE, RUNNING, { volatileExtensionMs: 0 });
    expect((await settle).settled).toBe(false);
  });

  test("an action capture from another screen does not seed the tick", async () => {
    const { settle } = deviceSettle(
      { ...RUNNING_ACTION_CAPTURE, appId: "com.example.other" },
      RUNNING,
    );
    const result = await settle;
    // Four reads are needed again; the fourth would end past the extended budget.
    expect(result.settled).toBe(false);
    expect(result.polls).toBe(3);
    expect(result.waitMs).toBe(BUDGET_MS + embeddedObservationSettleTickExtensionMs(BUDGET_MS) + 1);
  });

  test("a lap row appearing every read withdraws the extension", async () => {
    const withLaps = RUNNING.map((frame, index) => ({ ...frame, laps: index }));
    const { settle } = deviceSettle(RUNNING_ACTION_CAPTURE, withLaps);
    const result = await settle;
    expect(result.settled).toBe(false);
    expect(result.waitMs).toBeLessThanOrEqual(BUDGET_MS + 1);
  });

  test("a static screen settles on two reads and never uses the extension", async () => {
    const still = RUNNING_ACTION_CAPTURE;
    const { settle } = deviceSettle(still, [still, still, still]);
    const result = await settle;
    expect(result.settled).toBe(true);
    expect(result.polls).toBe(2);
    // Reads at 0-300 and 450-750, then the back-stack read.
    expect(result.waitMs).toBe(900);
  });

  test("a title rewritten across the action and twice more is not settled early (#17692)", async () => {
    // The seeded diff counts as one change, not a mask: the node changed in
    // two diffs is promoted, and the read after the last rewrite still counts.
    const title = (text: string): StopwatchFrame => ({ time: text, hundredths: "00" });
    const { settle } = deviceSettle(title("Loading"), [
      title("Signing in"),
      title("Welcome"),
      title("Welcome"),
    ]);
    const result = await settle;
    expect(result.settled).toBe(true);
    expect(result.polls).toBe(3);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(30);
  });
});

describe("settle on a paused, blinking stopwatch at device read cost (#17749)", () => {
  test("without the change it never settles", async () => {
    const { settle } = deviceSettle(PAUSED_ACTION_CAPTURE, PAUSED, {
      referenceObservation: undefined,
      volatileExtensionMs: 0,
    });
    expect((await settle).settled).toBe(false);
  });

  test("the blink is masked from its third flip and settles", async () => {
    const { settle } = deviceSettle(PAUSED_ACTION_CAPTURE, PAUSED);
    const result = await settle;
    expect(result.settled).toBe(true);
    expect(result.polls).toBe(3);
    expect(result.waitMs).toBe(1350);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(30);
  });

  test("aliased blink reads settle with a three-read stability threshold", async () => {
    const frames = [false, false, true, true, false, false, true].map((visible) => ({
      ...PAUSED_ACTION_CAPTURE,
      visible,
    }));
    const { settle, screen } = deviceSettle(PAUSED_ACTION_CAPTURE, frames, {
      timeoutMs: 2500,
      // One equal pair must not end the loop before the next sampled flip.
      stableReads: 3,
    });
    const result = await settle;
    expect(result.settled).toBe(true);
    expect(result.terminalReason).toBe("settled");
    expect(result.polls).toBe(5);
    expect(result.waitMs).toBe(2250);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(50);
    expect(screen.getCollectDeferredBackStackCallCount()).toBe(1);
  });
});

describe("embedded settle gate on the stopwatch (#17749)", () => {
  test("a running stopwatch settles inside the gate's budget plus extension", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new DeviceCostObserveScreen(timer);
    screen.setObserveSequence(
      RUNNING.map((frame, index) => stopwatchScreen(frame, 10 + index * 10)),
    );
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: stopwatchScreen(RUNNING_ACTION_CAPTURE, 5),
      settleObserve: new RealSettleObserve(screen, timer),
      timer,
    });
    expect(outcome.settled).toBe(true);
    expect(outcome.settlePolls).toBe(3);
    expect(outcome.settleMs).toBe(1350);
  });

  test("the extension is at most half of a shortened budget", () => {
    expect(embeddedObservationSettleTickExtensionMs(1000)).toBe(500);
    expect(embeddedObservationSettleTickExtensionMs(3000)).toBe(500);
    expect(embeddedObservationSettleTickExtensionMs(300)).toBe(150);
    expect(embeddedObservationSettleTickExtensionMs(0)).toBe(0);
  });
});

/** A matched node whose only change is its visibility. */
function blink(resourceId: string, from: boolean): ObserveDiff {
  const key = [resourceId, "348,873,732,1121", "6:16", 1].join("\0");
  return {
    isDiff: true,
    skeleton: [],
    added: [],
    removed: [],
    changed: [{ key, changes: { "visible-to-user": { from, to: !from } } }],
  };
}

describe("VolatileTextTracker visibility blink (#17749)", () => {
  test("a node whose visibility flips is masked from its third consecutive flip", () => {
    const tracker = new VolatileTextTracker();
    const stable = [true, false, true, false].map((from) =>
      isStabilityDiffEmpty(tracker.mask(blink(TIME_ID, from))),
    );
    expect(stable).toEqual([false, false, true, true]);
  });

  test("an equal diff between flips still promotes the blink without masking its second flip", () => {
    const tracker = new VolatileTextTracker();
    const empty: ObserveDiff = { isDiff: true, skeleton: [], added: [], removed: [], changed: [] };
    const stable = [
      blink(TIME_ID, true),
      empty,
      blink(TIME_ID, false),
      empty,
      blink(TIME_ID, true),
    ].map((step) => isStabilityDiffEmpty(tracker.mask(step)));
    expect(stable).toEqual([false, true, false, true, true]);
    expect(tracker.volatileCount).toBe(1);
  });

  test("a flip older than the two preceding diffs does not promote the blink", () => {
    const tracker = new VolatileTextTracker();
    const empty: ObserveDiff = { isDiff: true, skeleton: [], added: [], removed: [], changed: [] };
    tracker.mask(blink(TIME_ID, true));
    tracker.mask(empty);
    tracker.mask(empty);
    expect(isStabilityDiffEmpty(tracker.mask(blink(TIME_ID, false)))).toBe(false);
    expect(tracker.volatileCount).toBe(0);
  });

  test("reset clears pending flips across equal diffs", () => {
    const tracker = new VolatileTextTracker();
    const empty: ObserveDiff = { isDiff: true, skeleton: [], added: [], removed: [], changed: [] };
    tracker.mask(blink(TIME_ID, true));
    tracker.mask(empty);
    tracker.reset();
    tracker.mask(blink(TIME_ID, false));
    expect(tracker.volatileCount).toBe(0);
    expect(isStabilityDiffEmpty(tracker.mask(blink(TIME_ID, true)))).toBe(false);
    expect(tracker.volatileCount).toBe(1);
  });

  test("a node that only becomes visible once is never masked", () => {
    const tracker = new VolatileTextTracker();
    const empty: ObserveDiff = { isDiff: true, skeleton: [], added: [], removed: [], changed: [] };
    expect(isStabilityDiffEmpty(tracker.mask(blink(TIME_ID, false)))).toBe(false);
    expect(isStabilityDiffEmpty(tracker.mask(empty))).toBe(true);
    expect(tracker.volatileCount).toBe(0);
  });

  test("a flip together with another attribute change still counts", () => {
    const tracker = new VolatileTextTracker();
    const withFocus = (from: boolean): ObserveDiff => {
      const diff = blink(TIME_ID, from);
      diff.changed[0].changes.focused = { from, to: !from };
      return diff;
    };
    const stable = [true, false, true].map((from) =>
      isStabilityDiffEmpty(tracker.mask(withFocus(from))),
    );
    expect(stable).toEqual([false, false, false]);
  });
});

describe("splitVolatileChanges (#17749)", () => {
  const node = (resourceId: string, text: string): ObserveDiffNode => ({
    key: [resourceId, "588,1046,732,1219", text, 2].join("\0"),
    attributes: { "resource-id": resourceId, text, bounds: HUNDREDTHS_BOUNDS },
  });

  test("a tick-only diff has ticks and nothing else", () => {
    const tick: ObserveDiff = {
      isDiff: true,
      skeleton: [],
      added: [node(HUNDREDTHS_ID, "47")],
      removed: [node(HUNDREDTHS_ID, "20")],
      changed: [],
    };
    const split = splitVolatileChanges(tick);
    expect(split.ticks).toBe(1);
    expect(isStabilityDiffEmpty(split.rest)).toBe(true);
  });

  test("a structural change alongside a tick is left in the rest", () => {
    const lap = node("com.google.android.deskclock:id/lap_1", "Lap 1");
    const split = splitVolatileChanges({
      isDiff: true,
      skeleton: [],
      added: [node(HUNDREDTHS_ID, "47"), lap],
      removed: [node(HUNDREDTHS_ID, "20")],
      changed: [],
    });
    expect(split.ticks).toBe(1);
    expect(split.rest.added).toEqual([lap]);
  });
});
