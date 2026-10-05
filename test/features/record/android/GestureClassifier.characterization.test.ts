import { describe, expect, test } from "bun:test";
import { GestureClassifier } from "../../../../src/features/record/android/GestureClassifier";
import type { GestureEvent, RawTouchFrame } from "../../../../src/features/record/android/types";

type Slot = RawTouchFrame["activeSlots"][number];
const slot = (id: number, x: number, y: number, unknownAxes?: Slot["unknownAxes"]): Slot => ({
  slotId: id,
  trackingId: id + 1,
  x,
  y,
  pressure: 0,
  ...(unknownAxes ? { unknownAxes } : {}),
});
const frame = (
  arrivedAt: number,
  activeSlots: Slot[],
  releasedSlots: number[] = [],
): RawTouchFrame => ({ arrivedAt, activeSlots, releasedSlots });
const down = (at = 0, x = 100, y = 100) => frame(at, [slot(0, x, y)]);
const up = (at: number) => frame(at, [], [0]);
const tap = (arrivedAt: number, screenX = 100, screenY = 100): GestureEvent => ({
  type: "tap",
  arrivedAt,
  screenX,
  screenY,
});
interface Case {
  name: string;
  frames: RawTouchFrame[];
  expected: (GestureEvent | null)[];
}
const cases: Case[] = [
  { name: "empty frame", frames: [frame(0, [])], expected: [null] },
  { name: "untracked release", frames: [up(10)], expected: [null] },
  {
    name: "stationary update and tap",
    frames: [down(), down(20), up(50)],
    expected: [null, null, tap(50)],
  },
  { name: "tap below long press boundary", frames: [down(), up(399)], expected: [null, tap(399)] },
  {
    name: "long press boundary",
    frames: [down(), up(400)],
    expected: [
      null,
      { type: "longPress", arrivedAt: 400, screenX: 100, screenY: 100, durationMs: 400 },
    ],
  },
  {
    name: "movement below slop",
    frames: [down(), down(20, 107), up(50)],
    expected: [null, null, tap(50)],
  },
  {
    name: "double tap time and distance boundaries",
    frames: [down(), up(50), down(300, 200), up(350)],
    expected: [
      null,
      tap(50),
      null,
      { type: "doubleTap", arrivedAt: 350, screenX: 200, screenY: 100, firstTapArrivedAt: 50 },
    ],
  },
  {
    name: "double tap expires",
    frames: [down(), up(50), down(300), up(351)],
    expected: [null, tap(50), null, tap(351)],
  },
  {
    name: "double tap outside distance",
    frames: [down(), up(50), down(100, 201), up(150)],
    expected: [null, tap(50), null, tap(150, 201)],
  },
  {
    name: "double tap resets remembered tap",
    frames: [down(), up(50), down(100), up(150), down(200), up(250)],
    expected: [
      null,
      tap(50),
      null,
      { type: "doubleTap", arrivedAt: 150, screenX: 100, screenY: 100, firstTapArrivedAt: 50 },
      null,
      tap(250),
    ],
  },
  {
    name: "release with another active contact cleans up",
    frames: [down(), frame(20, [slot(1, 200, 100)], [0]), up(30), frame(50, [], [1])],
    expected: [null, null, null, tap(50, 200)],
  },
  {
    name: "multiple releases clean up",
    frames: [down(), frame(20, [], [0, 9]), up(50)],
    expected: [null, null, null],
  },
];

for (const [name, x, y, duration, direction, speed] of [
  ["slop boundary and zero duration", 108, 100, 0, "right", "normal"],
  ["right at fling boundary", 110, 100, 200, "right", "fast"],
  ["right below fling boundary", 110, 100, 201, "right", "normal"],
  ["left", 90, 100, 100, "left", "fast"],
  ["up", 100, 90, 100, "up", "fast"],
  ["down", 100, 110, 100, "down", "fast"],
  ["equal displacement prefers horizontal", 90, 110, 100, "left", "fast"],
] as const) {
  cases.push({
    name,
    frames: [down(), down(0, x, y), up(duration)],
    expected: [
      null,
      null,
      {
        type: "swipe",
        arrivedAt: duration,
        direction,
        startX: 100,
        startY: 100,
        endX: x,
        endY: y,
        speed,
      },
    ],
  });
}

for (const [name, initial, final, staggered, expected] of [
  ["pinch out", 100, 200, false, { type: "pinch", arrivedAt: 50, scale: 2, pinchDirection: "out" }],
  [
    "pinch in staggered",
    100,
    50,
    true,
    { type: "pinch", arrivedAt: 50, scale: 0.5, pinchDirection: "in" },
  ],
  ["pinch below scale threshold", 100, 105, false, null],
  ["zero initial pinch distance", 0, 100, false, null],
] as const) {
  const frames = [
    frame(0, [slot(0, 0, 0), slot(1, initial, 0)]),
    frame(20, [slot(0, 0, 0), slot(1, final, 0)]),
  ];
  if (staggered) {
    frames.push(frame(30, [slot(0, 0, 0)], [1]));
  }
  frames.push(frame(50, [], staggered ? [0] : [0, 1]), down(100), up(150));
  cases.push({
    name,
    frames,
    expected: [...Array(frames.length - 3).fill(null), expected, null, tap(150)],
  });
}

for (const [name, first, second, duration, type] of [
  ["missing x", slot(0, NaN, 100, ["x"]), slot(0, NaN, 100, ["x"]), 50, "tap"],
  ["missing y long press", slot(0, 100, NaN, ["y"]), slot(0, 100, NaN, ["y"]), 400, "longPress"],
  ["missing both axes", slot(0, NaN, NaN, ["x", "y"]), slot(0, NaN, NaN, ["x", "y"]), 50, "tap"],
  ["axes first reported mid contact", slot(0, NaN, NaN, ["x", "y"]), slot(0, 100, 100), 50, "tap"],
  ["known axis proves swipe", slot(0, 100, NaN, ["y"]), slot(0, 108, NaN, ["y"]), 50, "swipe"],
  ["axes become unknown mid contact", slot(0, 100, 100), slot(0, 100, NaN, ["y"]), 50, "tap"],
] as const) {
  cases.push({
    name,
    frames: [
      frame(0, [first]),
      frame(20, [second]),
      up(duration),
      down(duration + 10),
      up(duration + 50),
    ],
    expected: [
      null,
      null,
      {
        type,
        arrivedAt: duration,
        durationMs: duration,
        unknownAxes: first.unknownAxes ?? second.unknownAxes,
      },
      null,
      tap(duration + 50),
    ],
  });
}

cases.push({
  name: "pinch axes unknown at start and merged on update",
  frames: [
    frame(0, [slot(0, NaN, 0, ["x"]), slot(1, 100, 0)]),
    frame(20, [slot(0, 0, 0), slot(1, 200, NaN, ["y"])]),
    frame(30, [slot(0, 0, 0)], [1]),
    up(50),
    down(100),
    up(150),
  ],
  expected: [null, null, null, null, null, tap(150)],
});
cases.push({
  name: "known pinch becomes unknown",
  frames: [
    frame(0, [slot(0, 0, 0), slot(1, 100, 0)]),
    frame(20, [slot(0, 0, 0), slot(1, 200, NaN, ["y"])]),
    frame(50, [], [0, 1]),
  ],
  expected: [null, null, null],
});

// An incomplete unknown contact clears an earlier tap before a later known tap.
cases.push({
  name: "unknown contact clears last tap",
  frames: [down(), up(50), frame(100, [slot(0, NaN, 100, ["x"])]), up(150), down(200), up(250)],
  expected: [
    null,
    tap(50),
    null,
    { type: "tap", arrivedAt: 150, durationMs: 50, unknownAxes: ["x"] },
    null,
    tap(250),
  ],
});

describe("GestureClassifier exact frame characterization", () => {
  test.each(cases)("$name", ({ frames, expected }) => {
    const classifier = new GestureClassifier({ toScreenPoint: (x, y) => ({ x, y }) }, 1);
    expect(frames.map((value) => classifier.feedFrame(value))).toEqual(expected);
  });
});
