import { describe, expect, test } from "bun:test";
import { DragPath } from "../../../src/features/action/DragPath";
import {
  DRAG_PATH_MAX_TOTAL_MS,
  assertDragPathFitsRequestBudget,
  planDragPath,
  resolveDragPathPoints,
} from "../../../src/features/action/dragPathPlan";
import { runDragPathStroke, type StrokeClient } from "../../../src/features/action/dragPathStroke";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { observation } from "../../helpers/tapAtCoordinate";
import type { Window } from "../../../src/features/observe/Window";

const android = { name: "a", platform: "android", deviceId: "emulator-5554" } as BootedDevice;
const ios = { name: "i", platform: "ios", deviceId: "ios-1" } as BootedDevice;

interface Frame {
  kind: "start" | "move" | "end";
  at: number;
  x: number;
  y: number;
  cancel?: boolean;
  displayId?: number;
}

function fakeClient(
  timer: FakeTimer,
  behavior: { failMoveAt?: number; failStart?: boolean; failEnd?: boolean } = {},
) {
  const frames: Frame[] = [];
  let moves = 0;
  const client: StrokeClient = {
    requestGestureStart: async (_id, x, y, _t, _p, displayId) => {
      frames.push({ kind: "start", at: timer.now(), x, y, displayId });
      return behavior.failStart ? { success: false, totalTimeMs: 0, error: "no" } : ok();
    },
    requestGestureMove: async (_id, x, y) => {
      moves++;
      frames.push({ kind: "move", at: timer.now(), x, y });
      return behavior.failMoveAt === moves
        ? { success: false, totalTimeMs: 0, error: "lost" }
        : ok();
    },
    requestGestureEnd: async (_id, x, y, cancel) => {
      frames.push({ kind: "end", at: timer.now(), x, y, cancel });
      return behavior.failEnd && !cancel ? { success: false, totalTimeMs: 0, error: "x" } : ok();
    },
  };
  return { client, frames };
}

function ok() {
  return { success: true, totalTimeMs: 0 };
}

describe("planDragPath", () => {
  test("splits a segment into frames at most 50 ms apart and ends on the vertex", () => {
    const plan = planDragPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1, durationMs: 200 },
        ],
      },
    );
    expect(plan.moves.map((m) => [m.atMs, m.x])).toEqual([
      [50, 25],
      [100, 50],
      [150, 75],
      [200, 100],
    ]);
    expect(plan.totalMs).toBe(200);
  });

  test("uses the default segment time, chains segment offsets and adds holds", () => {
    const plan = planDragPath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      {
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 0, durationMs: 10 },
          { x: 0, y: 0 },
        ],
        holdMs: 500,
        releaseHoldMs: 100,
      },
    );
    expect(plan.moves.at(0)).toEqual({ atMs: 10, x: 10, y: 0 });
    expect(plan.moves.at(-1)).toEqual({ atMs: 210, x: 10, y: 10 });
    expect(plan.totalMs).toBe(500 + 210 + 100);
  });
});

describe("resolveDragPathPoints", () => {
  const obs = { screenSize: { width: 100, height: 200 } } as ObserveResult;
  test("converts normalized points to native pixels", () => {
    const resolved = resolveDragPathPoints(
      {
        points: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.5 },
        ],
        coordinateSpace: "normalized",
      },
      obs,
      "android",
    );
    expect(resolved).toEqual({
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 100 },
      ],
    });
  });
  test("names the first out-of-bounds point", () => {
    const resolved = resolveDragPathPoints(
      {
        points: [
          { x: 1, y: 1 },
          { x: 100, y: 1 },
        ],
      },
      obs,
      "android",
    );
    expect("error" in resolved && resolved.error).toContain("points[1]");
  });
});

describe("assertDragPathFitsRequestBudget", () => {
  test("rejects a path over the hard ceiling", () => {
    expect(() => assertDragPathFitsRequestBudget(DRAG_PATH_MAX_TOTAL_MS + 1, undefined)).toThrow(
      "exceeds",
    );
  });
  test("rejects a path that does not fit the remaining request budget", () => {
    expect(() => assertDragPathFitsRequestBudget(5000, 6000)).toThrow("remaining request budget");
    expect(() => assertDragPathFitsRequestBudget(5000, 7000)).not.toThrow();
  });
});

describe("runDragPathStroke", () => {
  const plan = planDragPath(
    [
      { x: 1, y: 1 },
      { x: 3, y: 3 },
      { x: 3, y: 9 },
    ],
    {
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 0, durationMs: 100 },
        { x: 0, y: 0, durationMs: 50 },
      ],
      holdMs: 300,
      releaseHoldMs: 70,
    },
  );

  test("holds, paces moves on the timeline and lifts at the last point", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { client, frames } = fakeClient(timer);
    const result = await runDragPathStroke(client, plan, { gestureId: "g", timer });
    expect(result).toEqual({ success: true, moveCount: 3 });
    expect(frames.map((f) => [f.kind, f.at])).toEqual([
      ["start", 0],
      ["move", 350],
      ["move", 400],
      ["move", 450],
      ["end", 520],
    ]);
    expect(frames.at(-1)).toMatchObject({ x: 3, y: 9, cancel: false });
  });

  test("lifts with a cancelling end when a move fails", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { client, frames } = fakeClient(timer, { failMoveAt: 2 });
    const result = await runDragPathStroke(client, plan, { gestureId: "g", timer });
    expect(result.success).toBe(false);
    expect(result.indeterminate).toBe(true);
    expect(frames.at(-1)).toMatchObject({ kind: "end", cancel: true });
  });

  test("lifts the finger when aborted mid-hold and never sends a move", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { client, frames } = fakeClient(timer);
    const controller = new AbortController();
    const running = runDragPathStroke(client, plan, {
      gestureId: "g",
      timer,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(running).rejects.toBeDefined();
    expect(frames.map((f) => f.kind)).toEqual(["start", "end"]);
    expect(frames.at(-1)?.cancel).toBe(true);
  });

  test("a refused start sends nothing else", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { client, frames } = fakeClient(timer, { failStart: true });
    const result = await runDragPathStroke(client, plan, { gestureId: "g", timer });
    expect(result.success).toBe(false);
    expect(frames.map((f) => f.kind)).toEqual(["start"]);
  });

  test("a refused end is followed by a cancelling end", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { client, frames } = fakeClient(timer, { failEnd: true });
    const result = await runDragPathStroke(client, plan, { gestureId: "g", timer });
    expect(result.success).toBe(false);
    expect(frames.slice(-2).map((f) => f.cancel)).toEqual([false, true]);
  });
});

describe("DragPath", () => {
  function create(device: BootedDevice, client: StrokeClient, timer: FakeTimer) {
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation(100, 200));
    const dragPath = new DragPath(device, new FakeAdbExecutor(), {
      timer,
      androidClient: client,
      idGenerator: new CountingIdGenerator("stroke"),
    });
    dragPath.window = new FakeWindow() as unknown as Window;
    dragPath.observeScreen = observe;
    return dragPath;
  }

  test("drags an L-shaped path in native pixels", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { client, frames } = fakeClient(timer);
    const result = await create(android, client, timer).execute({
      points: [
        { x: 10, y: 10 },
        { x: 10, y: 100, durationMs: 50 },
        { x: 80, y: 100, durationMs: 50 },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.points).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 100 },
      { x: 80, y: 100 },
    ]);
    expect(frames.map((f) => f.kind)).toEqual(["start", "move", "move", "end"]);
  });

  test("an out-of-bounds point fails before any input", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { client, frames } = fakeClient(timer);
    const result = await create(android, client, timer).execute({
      points: [
        { x: 10, y: 10 },
        { x: 100, y: 10 },
      ],
    });
    expect(result.success).toBe(false);
    expect(frames).toEqual([]);
  });

  test("rejects a path that exceeds the request budget before any input", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { client, frames } = fakeClient(timer);
    const result = create(android, client, timer).execute(
      {
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 10, durationMs: 4000 },
        ],
      },
      { deadlineMs: timer.now() + 3000 },
    );
    await expect(result).rejects.toThrow("remaining request budget");
    expect(frames).toEqual([]);
  });

  test("iOS is refused with a clear platform error", async () => {
    const timer = new FakeTimer();
    const { client } = fakeClient(timer);
    await expect(
      create(ios, client, timer).execute({
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      }),
    ).rejects.toThrow("dragPath");
  });
});
