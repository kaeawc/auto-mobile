import { expect, test } from "bun:test";
import { swipeOnSchema } from "../../../src/server/interactionTools";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import type { ObserveResult, SwipeOnOptions } from "../../../src/models";
import { encodeAndroidFlat, type LogicalNode } from "../../fixtures/hierarchyArbitraries";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeTalkBackSwipeExecutor } from "../../fakes/FakeTalkBackSwipeExecutor";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeScrollableElementsQuery } from "../../fakes/FakeElementTraitQueries";

type Options = SwipeOnOptions;
const container = {
  elementId: "list",
  container: { elementId: "panel_A" },
  selectionStrategy: "unique" as const,
};
function node(id: string, children: LogicalNode[] = [], top = 100): LogicalNode {
  return {
    attrs: { "resource-id": id, text: id, class: "android.view.View" },
    bounds: { left: 20, top, right: 480, bottom: top + 200 },
    children,
  };
}
function observation(kind = "missing", top = 100): ObserveResult {
  const row = node(
    "row",
    [node("", kind === "found" || kind === "ambiguous" ? [node("target", [], top + 50)] : [])],
    top,
  );
  if (kind === "ambiguous") {
    row.children.push(node("target", [], top + 70));
  }
  const list = node("list", [row], top);
  const panel = node("panel_A", [node("", [list])]);
  if (kind === "container-ambiguous") {
    panel.children.push(node("list"));
  }
  return {
    timestamp: top,
    screenSize: { width: 500, height: 500 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: {
      screenWidth: 500,
      screenHeight: 500,
      hierarchy: {
        node: encodeAndroidFlat(
          node("", [
            node("panel_B", [node("list", [node("row", [node("target", [], 150)])], 250)]),
            ...(kind === "container-missing" ? [] : [panel]),
          ]),
        ),
      },
    },
  };
}
function harness(frames: ObserveResult[], resolver?: ElementResolver) {
  const observe = new FakeObserveScreen();
  let index = 0;
  observe.setObserveResult(() => frames[Math.min(index, frames.length - 1)]);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const runner = new FakeTalkBackSwipeExecutor();
  class TestSwipeOn extends SwipeOn {
    override async observedInteraction<T>(
      run: (observation: ObserveResult) => Promise<T>,
    ): Promise<T & { observation: ObserveResult }> {
      const result = await run(frames[Math.min(index, frames.length - 1)]);
      index++;
      timer.advanceTime(200);
      return { ...result, observation: frames[Math.min(index, frames.length - 1)] };
    }
  }
  const action = new TestSwipeOn(
    { name: "fake", deviceId: "nested-swipe-fake", platform: "ios" },
    null,
    {
      observeScreen: observe,
      timer,
      resolver,
      voiceOverExecutor: runner,
      scrollables: new FakeScrollableElementsQuery(),
      accessibilityDetector: new FakeAccessibilityDetector(),
    },
  );
  return { execute: (options: Options) => action.execute(options), runner };
}
test("nested container swipes within its own bounds through anonymous wrappers", async () => {
  const h = harness([observation()]);
  expect((await h.execute(swipeOnSchema.parse({ direction: "down", container }))).success).toBe(
    true,
  );
  const swipe = h.runner.getSwipeCalls()[0];
  expect(swipe.containerElement?.bounds.top).toBe(100);
  expect(swipe.y1).toBeGreaterThanOrEqual(100);
  expect(swipe.y2).toBeLessThanOrEqual(300);
});
for (const [kind, message] of [
  ["container-missing", "Container level 1 not found: panel_A"],
  ["container-ambiguous", "Container level 2 ambiguous"],
]) {
  test(`${kind} fails before every gesture`, async () => {
    const h = harness([observation(kind)]);
    const result = await h.execute({
      direction: "down",
      container,
      lookFor: { text: "target", maxTime: 600 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
    if (kind.includes("ambiguous")) {
      expect(result.error).toContain("Candidates:");
    }
    // #10325: the structured diagnostic reaches the swipeOn result, as dragAndDrop's does.
    expect(result).toHaveProperty(
      "containerFailure",
      kind === "container-missing"
        ? { level: 1, reason: "not-found", selector: container.container }
        : { level: 2, reason: "ambiguous", selector: container },
    );
    expect(h.runner.getCallCount()).toBe(0);
  });
}
test("lookFor re-resolves the swipe scope plus a more specific chain after scrolling", async () => {
  const h = harness([observation(), observation("found", 120)]);
  const result = await h.execute({
    direction: "down",
    container,
    lookFor: {
      text: "target",
      container: { elementId: "row" },
      selectionStrategy: "unique",
      maxTime: 600,
    },
  });
  expect(result.success).toBe(true);
  expect(result.found).toBe(true);
  expect(result.element?.bounds.top).toBe(170);
  expect(h.runner.getCallCount()).toBe(1);
});
test("scoped not-found exhausts the search budget without a global same-name fallback", async () => {
  const h = harness([observation(), observation("missing", 120), observation("missing", 140)]);
  const result = await h.execute({
    direction: "down",
    container,
    lookFor: { text: "target", container: { elementId: "row" }, maxTime: 400 },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("not found within container");
  expect(result.error).toContain("panel_A");
  expect(result.error).toContain("row");
  expect(result.error).toContain("timeout=400ms");
  expect(h.runner.getCallCount()).toBe(2);
});
test("lookFor scope alone is retained and unique ambiguity lists candidates without a swipe", async () => {
  const h = harness([observation("ambiguous")]);
  const result = await h.execute({
    direction: "down",
    lookFor: {
      text: "target",
      container: { elementId: "row", container },
      selectionStrategy: "unique",
      maxTime: 600,
    },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("Target ambiguous: 2 matches; Candidates:");
  expect(result.error).toContain("bounds=");
  expect(h.runner.getCallCount()).toBe(0);
});

for (const lookFor of [undefined, { text: "target", maxTime: 400 }]) {
  test(`nested explicit container miss never falls back, lookFor=${!!lookFor}`, async () => {
    const h = harness([observation()]);
    const result = await h.execute({
      direction: "down",
      container: { elementId: "absent", container: { elementId: "panel_A" } },
      lookFor,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Container level 2 not found: absent");
    expect(h.runner.getCallCount()).toBe(0);
  });
}
test("container disappearance after a swipe prevents dispatch using stale or global bounds", async () => {
  const h = harness([observation(), observation("container-missing")]);
  const result = await h.execute({
    direction: "down",
    container,
    lookFor: { text: "target", maxTime: 600 },
  });
  expect(result.error).toContain("Container level 1 not found: panel_A");
  expect(h.runner.getCallCount()).toBe(1);
});
test("unique zero-match lookFor keeps searching and ambiguity after one swipe stops immediately", async () => {
  const h = harness([observation(), observation("ambiguous")]);
  const result = await h.execute({
    direction: "down",
    container,
    lookFor: { text: "target", selectionStrategy: "unique", maxTime: 600 },
  });
  expect(result.error).toContain("Target ambiguous: 2 matches; Candidates:");
  expect(h.runner.getCallCount()).toBe(1);
});
test("missing lookFor inner scope remains scoped through timeout even with an outside target", async () => {
  const h = harness([observation(), observation("found", 120), observation("found", 140)]);
  const result = await h.execute({
    direction: "down",
    container,
    lookFor: {
      text: "target",
      container: { elementId: "absent" },
      selectionStrategy: "unique",
      maxTime: 400,
    },
  });
  expect(result.error).toContain("not found within container scope");
  expect(result.error).toContain("absent");
  expect(result.error).toContain("timeout=400ms");
  expect(h.runner.getCallCount()).toBe(2);
});
test("per-level indices disambiguate a unique container without requiring it to be interactive", async () => {
  const h = harness([observation("container-ambiguous")]);
  const result = await h.execute({ direction: "down", container: { ...container, index: 1 } });
  expect(result.success).toBe(true);
  expect(h.runner.getCallCount()).toBe(1);
});

test("random swipe scope and lookFor refer to the same resolved container in a frame", async () => {
  let calls = 0;
  const h = harness(
    [observation(), observation("found", 120)],
    new ElementResolver(() => (calls++ % 2 ? 0 : 0.99)),
  );
  const result = await h.execute({
    direction: "down",
    container: { elementId: "list", selectionStrategy: "random" },
    lookFor: { text: "target", container: { elementId: "row" }, maxTime: 400 },
  });
  expect(result.success).toBe(true);
  expect(result.scrollIterations).toBe(1);
  expect(h.runner.getSwipeCalls()[0].containerElement?.bounds.top).toBe(100);
});

for (const [kind, message] of [
  ["container-missing", "Container level 1 not found: panel_A"],
  ["container-ambiguous", "Container level 2 ambiguous"],
]) {
  test(`single swipe ${kind} fails before dispatch`, async () => {
    const h = harness([observation(kind)]);
    const result = await h.execute({ direction: "down", container });
    expect(result.error).toContain(message);
    expect(h.runner.getCallCount()).toBe(0);
  });
}
function legacyObservation(kind: "missing" | "found" | "absent" = "missing", top = 100) {
  const frame = observation();
  const list = node("auto_list", [], 200);
  list.attrs.scrollable = true;
  list.bounds = { left: 60, top: 200, right: 440, bottom: 450 };
  const legacy = node("absent", kind === "found" ? [node("target", [], top + 20)] : [], top);
  frame.viewHierarchy!.hierarchy.node = encodeAndroidFlat({
    ...node("", [...(kind === "absent" ? [] : [legacy]), list]),
    bounds: { left: 0, top: 0, right: 500, bottom: 500 },
  });
  return frame;
}

test("legacy one-level container miss uses the automatic scrollable before finding lookFor", async () => {
  const h = harness([legacyObservation("absent"), legacyObservation("found")]);
  const result = await h.execute({
    direction: "down",
    container: { elementId: "absent" },
    lookFor: { text: "target", maxTime: 400 },
  });
  expect(result).toMatchObject({ success: true });
  expect(result.error).toBeUndefined();
  expect(result.found).toBe(true);
  expect(h.runner.getCallCount()).toBe(1);
  const swipe = h.runner.getSwipeCalls()[0];
  expect(swipe.containerElement?.["resource-id"]).toBe("auto_list");
  expect(swipe.x1).toBeGreaterThanOrEqual(60);
  expect(swipe.x2).toBeLessThanOrEqual(440);
  expect(swipe.y1).toBeGreaterThanOrEqual(200);
  expect(swipe.y2).toBeLessThanOrEqual(450);
});

test("legacy container disappearance reselects the automatic scrollable on the next swipe", async () => {
  const h = harness([
    legacyObservation(),
    legacyObservation("absent"),
    legacyObservation("found", 120),
  ]);
  const result = await h.execute({
    direction: "down",
    container: { elementId: "absent" },
    lookFor: { text: "target", maxTime: 600 },
  });
  expect(result).toMatchObject({ success: true });
  expect(h.runner.getCallCount()).toBe(2);
  expect(h.runner.getSwipeCalls()[1].containerElement?.["resource-id"]).toBe("auto_list");
});

test("legacy lookFor retains its original timeout wording", async () => {
  const h = harness([legacyObservation(), legacyObservation("missing", 120)]);
  const result = await h.execute({
    direction: "down",
    container: { elementId: "absent" },
    lookFor: { text: "target", maxTime: 200 },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('text "target" not found after scrolling');
  expect(result.error).not.toContain("within container scope");
});

for (const resolved of [false, true]) {
  test(`scoped lookFor appends a legacy swipe container only when resolved=${resolved}`, async () => {
    const frame = legacyObservation(resolved ? "missing" : "absent");
    const target = node("target", [], 100);
    target.bounds = { left: 80, top: 230, right: 420, bottom: 280 };
    const inner = node("inner", [target]);
    frame.viewHierarchy!.hierarchy.node = encodeAndroidFlat(
      node("", [
        ...(resolved ? [node("absent")] : []),
        {
          ...node("auto_list", [inner], 200),
          attrs: { "resource-id": "auto_list", scrollable: true },
        },
      ]),
    );
    const h = harness([frame]);
    const result = await h.execute({
      direction: "down",
      container: { elementId: "absent" },
      lookFor: {
        text: "target",
        container: { elementId: "inner" },
        selectionStrategy: "unique",
        maxTime: 200,
      },
    });
    expect(result.success).toBe(!resolved);
    expect(h.runner.getCallCount()).toBe(resolved ? 1 : 0);
  });
}

for (const optIn of [{ index: 0 }, { selectionStrategy: "first" as const }]) {
  test(`one-level container opt-in ${JSON.stringify(optIn)} rejects a miss without fallback`, async () => {
    const h = harness([legacyObservation("absent")]);
    const result = await h.execute({
      direction: "down",
      container: { elementId: "absent", ...optIn },
      lookFor: { text: "target", maxTime: 400 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Container level 1 not found: absent");
    expect(h.runner.getCallCount()).toBe(0);
  });
}

test("scoped lookFor stays inside a resolved legacy container with a matching peer outside", async () => {
  const frame = legacyObservation();
  const target = node("target", [], 120);
  target.bounds = { left: 80, top: 130, right: 420, bottom: 180 };
  frame.viewHierarchy!.hierarchy.node = encodeAndroidFlat({
    ...node("", [
      node("absent", [node("inner", [target])]),
      node("peer", [node("inner", [node("target", [], 150)])]),
    ]),
    bounds: { left: 0, top: 0, right: 500, bottom: 500 },
  });
  const h = harness([frame]);
  const result = await h.execute({
    direction: "down",
    container: { elementId: "absent" },
    lookFor: {
      text: "target",
      container: { elementId: "inner" },
      selectionStrategy: "unique",
      maxTime: 200,
    },
  });
  expect(result.success).toBe(true);
  expect(result.element?.bounds.top).toBe(130);
  expect(h.runner.getCallCount()).toBe(0);
});

test("legacy single swipe retains main's retry failure wording", async () => {
  const h = harness([observation()]);
  const result = await h.execute({ direction: "down", container: { elementId: "absent" } });
  expect(result.success).toBe(false);
  expect(result.error).toContain("Element not found with provided elementId 'absent'");
  expect(result.error).not.toContain("Container level");
  expect(h.runner.getCallCount()).toBe(0);
});
