import { describe, expect, test } from "bun:test";
import { DragPath, type IosPathClient } from "../../../src/features/action/DragPath";
import { SnapshotReferenceStore } from "../../../src/features/observe/SnapshotReferenceStore";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { BootedDevice, DragPathOptions, ObserveResult } from "../../../src/models";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { observation } from "../../helpers/tapAtCoordinate";

const device: BootedDevice = { name: "i", platform: "ios", deviceId: "ios-drag-retry" };
const STALE =
  "Command execution failed: Stale frame context; observe a fresh frame before retrying";
type Reply = Awaited<ReturnType<IosPathClient["requestPathGesture"]>>;
const stale: Reply = {
  success: false,
  totalTimeMs: 0,
  error: STALE,
  dispatched: true,
  acknowledged: true,
};
const ok: Reply = { success: true, totalTimeMs: 1, dispatched: true, acknowledged: true };
const options: DragPathOptions = {
  points: [
    { x: 10, y: 10 },
    { x: 10, y: 100, durationMs: 50 },
  ],
};

class RetryObserver extends FakeObserveScreen {
  onFresh?: () => void;
  constructor(private readonly events: string[]) {
    super();
  }
  override async execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    this.events.push(`observe:${options?.freshness ?? "default"}`);
    const result = await super.execute(options);
    if (
      options?.freshness === "fresh" &&
      this.events.some((event) => event.startsWith("dispatch:"))
    ) {
      this.onFresh?.();
    }
    return result;
  }
}

function harness(replies: Reply[] = [stale, ok], refreshed = observation(100, 200, "fresh")) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const events: string[] = [];
  const requests: Array<Parameters<IosPathClient["requestPathGesture"]>> = [];
  const hooks: { onDispatch?: () => void } = {};
  const client: IosPathClient = {
    requestPathGesture: async (...args) => {
      requests.push(args);
      events.push(`dispatch:${args[2]?.frameContext}`);
      hooks.onDispatch?.();
      return replies[Math.min(requests.length - 1, replies.length - 1)];
    },
  };
  const observe = new RetryObserver(events);
  const initial = observation(100, 200, "initial");
  initial.display = { ...initial.display, key: "0" };
  refreshed.display = { ...refreshed.display, key: "0" };
  observe.setObserveSequence([initial, refreshed]);
  const transitions = new FakeDisplayTransitionReader();
  transitions.panel = { key: "0", role: "unknown" };
  const references = new SnapshotReferenceStore(timer, new CountingIdGenerator());
  const drag = new DragPath(device, new FakeAdbExecutor(), {
    timer,
    iosClient: client,
    displayTransitions: transitions,
    snapshotReferences: references,
    lastRenderedObservation: () => ({
      display: { key: "0" },
      displayRevision: transitions.fullRevision,
    }),
  });
  drag.window = new FakeWindow();
  drag.observeScreen = observe;
  return { drag, timer, events, requests, hooks, observe, initial, transitions, references };
}

function snapshotId(h: ReturnType<typeof harness>): string {
  const captured = h.references.capture(device.deviceId, h.initial);
  if (captured.status !== "captured") {
    throw new Error("Snapshot unavailable");
  }
  return captured.reference.snapshotId;
}

describe("DragPath iOS fresh-frame retry", () => {
  test("refreshes a stale frame and retries unchanged coordinates even after scrolling moved the layout", async () => {
    const h = harness(
      [stale, ok],
      observation(100, 200, "fresh", 0, {
        bounds: { left: 0, top: 50, right: 90, bottom: 150 },
      }),
    );
    const controller = new AbortController();
    const result = await h.drag.execute(options, { signal: controller.signal });
    expect(result.success).toBe(true);
    expect(result.points).toEqual(options.points.map(({ x, y }) => ({ x, y })));
    expect(h.events.slice(0, 3)).toEqual(["dispatch:initial", "observe:fresh", "dispatch:fresh"]);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1][0]).toEqual(h.requests[0][0]);
    expect(h.requests.map((request) => request[2]?.signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
    expect(h.observe.getExecuteOptions()[0]).toMatchObject({
      freshness: "fresh",
      display: h.initial.display.key,
      signal: controller.signal,
    });
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("surfaces a second stale rejection without another retry", async () => {
    const h = harness([stale, { ...stale, error: `${STALE} (second)` }]);
    const result = await h.drag.execute(options);
    expect(result.success).toBe(false);
    expect(result.error).toContain("(second)");
    expect(h.requests).toHaveLength(2);
    expect(
      h.observe
        .getExecuteOptions()
        .filter((call) => call.freshness === "fresh" && call.display === "0"),
    ).toHaveLength(1);
  });

  test("refuses changed resolved points without dispatching again", async () => {
    const h = harness([stale, ok], observation(200, 400, "fresh"));
    const result = await h.drag.execute({
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
      coordinateSpace: "normalized",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Stale frame context");
    expect(result.error).toContain("recompute");
    expect(h.requests).toHaveLength(1);
    expect(
      h.observe
        .getExecuteOptions()
        .some((call) => call.freshness === "fresh" && call.display === "0"),
    ).toBe(true);
  });

  test("does not retry a neighbouring non-stale runner error", async () => {
    const h = harness([{ ...stale, error: "synthesis failed" }]);
    const result = await h.drag.execute(options);
    expect(result.error).toContain("synthesis failed");
    expect(h.requests).toHaveLength(1);
    expect(
      h.observe
        .getExecuteOptions()
        .some((call) => call.freshness === "fresh" && call.display === "0"),
    ).toBe(false);
  });

  test("does not retry an unconfirmed request even if its diagnostic mentions a stale frame", async () => {
    const h = harness([{ ...stale, acknowledged: false }]);
    const result = await h.drag.execute(options);
    expect(result.error).toContain("may have run");
    expect(h.requests).toHaveLength(1);
    expect(
      h.observe
        .getExecuteOptions()
        .some((call) => call.freshness === "fresh" && call.display === "0"),
    ).toBe(false);
  });

  test("accepts a fresh capture repeating the rejected semantic token", async () => {
    const h = harness([stale, ok], observation(100, 200, "initial"));
    expect((await h.drag.execute(options)).success).toBe(true);
    expect(h.requests.map((request) => request[2]?.frameContext)).toEqual(["initial", "initial"]);
  });

  test("rechecks the snapshot and refuses an element layout moved in the fresh frame", async () => {
    const h = harness(
      [stale, ok],
      observation(100, 200, "fresh", 0, {
        bounds: { left: 0, top: 50, right: 90, bottom: 150 },
      }),
    );
    const result = await h.drag.execute({ ...options, snapshotId: snapshotId(h) });
    expect(result.error).toBe(
      "Snapshot reference is stale (tap-targeting layout changed); re-observe.",
    );
    expect(h.requests).toHaveLength(1);
    expect(
      h.observe
        .getExecuteOptions()
        .some((call) => call.freshness === "fresh" && call.display === "0"),
    ).toBe(true);
  });

  test("retries when the snapshot remains current", async () => {
    const h = harness();
    expect((await h.drag.execute({ ...options, snapshotId: snapshotId(h) })).success).toBe(true);
    expect(h.requests).toHaveLength(2);
  });

  test("rechecks the remaining request budget after refresh", async () => {
    const h = harness();
    h.observe.onFresh = () => h.timer.advanceTime(1000);
    await expect(h.drag.execute(options, { deadlineMs: h.timer.now() + 2500 })).rejects.toThrow(
      "remaining request budget",
    );
    expect(h.requests).toHaveLength(1);
  });

  test.each([undefined, "active"])(
    "honours the display fence after refresh on display %s",
    async (display) => {
      const h = harness();
      h.observe.onFresh = () => h.transitions.transition();
      const result = await h.drag.execute({ ...options, display });
      expect(result.success).toBe(false);
      expect(result.error).toStartWith("Display changed");
      expect(result.staleDisplay).toMatchObject({ retry: "observe" });
      expect(h.requests).toHaveLength(1);
    },
  );

  test("honours cancellation during the fresh observation", async () => {
    const h = harness();
    const controller = new AbortController();
    h.observe.onFresh = () => controller.abort();
    await expect(h.drag.execute(options, { signal: controller.signal })).rejects.toThrow();
    expect(h.requests).toHaveLength(1);
  });

  test("does not refresh after cancellation at the rejection", async () => {
    const h = harness();
    const controller = new AbortController();
    h.hooks.onDispatch = () => controller.abort();
    await expect(h.drag.execute(options, { signal: controller.signal })).rejects.toThrow();
    expect(h.requests).toHaveLength(1);
    expect(
      h.observe
        .getExecuteOptions()
        .some((call) => call.freshness === "fresh" && call.display === "0"),
    ).toBe(false);
  });

  test("refuses a fresh capture without a usable frame context", async () => {
    const refreshed = observation(100, 200, "");
    const h = harness([stale, ok], refreshed);
    expect((await h.drag.execute(options)).success).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(
      h.observe
        .getExecuteOptions()
        .some((call) => call.freshness === "fresh" && call.display === "0"),
    ).toBe(true);
  });

  test("does not adopt a fresh request that returned an explicitly stale capture", async () => {
    const refreshed = observation(100, 200, "fresh");
    refreshed.freshness = { ...refreshed.freshness, isFresh: false };
    const h = harness([stale, ok], refreshed);
    expect((await h.drag.execute(options)).success).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(
      h.observe
        .getExecuteOptions()
        .some((call) => call.freshness === "fresh" && call.display === "0"),
    ).toBe(true);
  });
});
