import { describe, expect, test } from "bun:test";
import type { ObserveResult, ViewHierarchyResult } from "../../src/models";
import {
  buildConditionPredicate,
  observeSchema,
  registerObserveTools,
  runSettleObserveTool,
  runWaitForConditionTool,
  settleObserveSchema,
  waitForConditionSchema,
  waitForObservation,
} from "../../src/server/observeTools";
import { DefaultElementFinder } from "../../src/features/utility/ElementFinder";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Tests for the observe `waitFor` predicate DSL and the standalone
 * `settleObserve` / `waitForCondition` tools (issue #4398). These wire the
 * #4389 primitives (RealSettleObserve, RealWaitForCondition, the predicate
 * builders) into reachable MCP tool calls.
 *
 * All poll-loop cases run under FakeTimer + FakeObserveScreen — no device, no DB,
 * < 100ms — the same seam `waitForObservation` was already tested through.
 */

const flatBounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

/** A flat (resource-id-addressable) view hierarchy wrapping the given children. */
const makeHierarchy = (children: Record<string, unknown>[]): ViewHierarchyResult =>
  ({
    hierarchy: {
      node: {
        "resource-id": "root",
        "bounds": flatBounds(0, 0, 200, 200),
        "node": children,
      },
    },
    screenWidth: 200,
    screenHeight: 200,
  } as unknown as ViewHierarchyResult);

const makeObservation = (
  children: Record<string, unknown>[],
  updatedAt = 0
): ObserveResult =>
  ({
    updatedAt,
    screenSize: { width: 200, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 0 },
    viewHierarchy: makeHierarchy(children),
  } as ObserveResult);

const node = (props: Record<string, unknown>): Record<string, unknown> => ({
  "bounds": flatBounds(0, 0, 10, 10),
  ...props,
});

// ---------------------------------------------------------------------------
// buildConditionPredicate — the DSL branching (AC3 core)
// ---------------------------------------------------------------------------
describe("buildConditionPredicate", () => {
  const finder = new DefaultElementFinder();

  test("appear -> matches a present element", () => {
    const predicate = buildConditionPredicate(finder, "appear", { elementId: "submit" });
    expect(predicate(makeObservation([node({ "resource-id": "submit" })])).matched).toBe(true);
  });

  test("appear -> scopes its finder lookup to the requested container", () => {
    const predicate = buildConditionPredicate(finder, "appear", {
      elementId: "submit",
      container: { elementId: "checkout" },
    });
    const observation = makeObservation([
      node({ "resource-id": "other", "node": [node({ "resource-id": "submit" })] }),
      node({ "resource-id": "checkout", "node": [] }),
    ]);

    expect(predicate(observation).matched).toBe(false);
  });

  test("disappear -> matches an absent element", () => {
    const predicate = buildConditionPredicate(finder, "disappear", { elementId: "spinner" });
    expect(predicate(makeObservation([node({ "resource-id": "content" })])).matched).toBe(true);
  });

  test("clickable -> requires the element to be clickable", () => {
    const predicate = buildConditionPredicate(finder, "clickable", { elementId: "btn" });
    expect(predicate(makeObservation([node({ "resource-id": "btn", "clickable": false })])).matched).toBe(false);
    expect(predicate(makeObservation([node({ "resource-id": "btn", "clickable": true })])).matched).toBe(true);
  });

  test("textEquals -> uses text as the exact expected value", () => {
    const predicate = buildConditionPredicate(finder, "textEquals", { elementId: "counter", text: "5" });
    expect(predicate(makeObservation([node({ "resource-id": "counter", "text": "50" })])).matched).toBe(false);
    expect(predicate(makeObservation([node({ "resource-id": "counter", "text": "5" })])).matched).toBe(true);
  });

  test("textEquals -> retains its container scope", () => {
    const predicate = buildConditionPredicate(finder, "textEquals", {
      elementId: "counter",
      text: "5",
      container: { elementId: "checkout" },
    });
    expect(predicate(makeObservation([
      node({ "resource-id": "other", "node": [node({ "resource-id": "counter", "text": "5" })] }),
      node({ "resource-id": "checkout", "node": [] }),
    ])).matched).toBe(false);
  });

  test("countStable -> settles once the match count repeats", () => {
    const predicate = buildConditionPredicate(finder, "countStable", { elementId: "row" }, { stableReads: 2 });
    expect(predicate(makeObservation([node({ "resource-id": "row" })])).matched).toBe(false);
    expect(predicate(makeObservation([node({ "resource-id": "row" })])).matched).toBe(true);
  });

  test("textEquals without text is rejected (text is the required expected value)", () => {
    expect(() => buildConditionPredicate(finder, "textEquals", { elementId: "counter" })).toThrow(/text/);
  });
});

// ---------------------------------------------------------------------------
// observe waitFor DSL path via the injectable waitForObservation seam (AC3)
// ---------------------------------------------------------------------------
describe("waitForObservation DSL branch", () => {
  test("for:'appear' polls until the element shows up and reports it as awaitedElement", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "spinner" })], 10),
      makeObservation([node({ "resource-id": "submit", "text": "Go" })], 20),
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      { for: "appear", elementId: "submit" } as any,
      undefined,
      false,
      timer
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(outcome.awaitedElement?.["resource-id"]).toBe("submit");
  });

  test("for:'stable' routes to the settle loop and returns the final settled snapshot (no awaitedElement)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const settled = makeObservation([node({ "resource-id": "content", "text": "done" })], 30);
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "content", "text": "loading" })], 10),
      settled,
      settled,
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      { for: "stable" } as any,
      undefined,
      false,
      timer
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(outcome.awaitedElement).toBeUndefined();
  });

  test("for:'textEquals' waits until the located element shows the exact value", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "counter", "text": "4" })], 10),
      makeObservation([node({ "resource-id": "counter", "text": "5" })], 20),
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      { for: "textEquals", elementId: "counter", text: "5" } as any,
      undefined,
      false,
      timer
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(outcome.awaitedElement?.text).toBe("5");
  });

  test("for:'appear' times out (no bare crash) when the element never appears", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(index => makeObservation([node({ "resource-id": "spinner" })], (index + 1) * 10));

    const outcome = await waitForObservation(
      observeScreen,
      { for: "appear", elementId: "submit", timeout: 300 } as any,
      undefined,
      false,
      timer
    );

    expect(outcome.awaitTimeout).toBe(true);
    expect(outcome.awaitedElement).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Back-compat: the legacy element-appear waitFor form is untouched (AC4)
// ---------------------------------------------------------------------------
describe("waitFor back-compat", () => {
  test("legacy element-appear form (no `for`) still parses", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: { elementId: "com.app:id/name", timeout: 8000 },
    });
    expect(parsed.waitFor).toMatchObject({ elementId: "com.app:id/name" });
  });

  test("legacy textAny form (no `for`) still parses", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: { textAny: ["OK", "Done"] },
    });
    expect(parsed.waitFor).toMatchObject({ textAny: ["OK", "Done"] });
  });

  test("DSL form with `for` parses alongside the legacy forms", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: { for: "clickable", elementId: "com.app:id/submit" },
    });
    expect(parsed.waitFor).toMatchObject({ for: "clickable", elementId: "com.app:id/submit" });
  });

  test("DSL form accepts a container scope and the timeoutMs alias", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        for: "clickable",
        elementId: "com.app:id/submit",
        container: { elementId: "com.app:id/form" },
        timeoutMs: 8000,
      },
    });
    expect(parsed.waitFor).toMatchObject({
      container: { elementId: "com.app:id/form" },
      timeoutMs: 8000,
    });
  });

  test("rejects conflicting timeout aliases across all waitFor forms", () => {
    for (const waitFor of [
      { for: "appear", elementId: "x" },
      { elementId: "x" },
      { textAny: ["x"] },
    ]) {
      expect(() =>
        observeSchema.parse({
          platform: "android",
          waitFor: { ...waitFor, timeout: 1000, timeoutMs: 2000 },
        })
      ).toThrow(/timeout/);
    }
  });

  test("DSL `for: stable` needs no selector", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: { for: "stable", timeout: 3000 },
    });
    expect(parsed.waitFor).toMatchObject({ for: "stable" });
  });

  test("DSL `for: appear` without a selector is rejected", () => {
    expect(() =>
      observeSchema.parse({ platform: "android", waitFor: { for: "appear" } })
    ).toThrow();
  });

  test("mixing `for` with a legacy-only field (activeWindow) is rejected, not silently dropped", () => {
    // Regression guard: the DSL arm declares activeWindow as `never`, and the legacy
    // arms declare `for` as `never`, so a `for`+activeWindow request matches no arm.
    // Without the legacy-arm `for: never`, the passthrough element arm re-admitted
    // `for` and silently discarded activeWindow.
    expect(() =>
      observeSchema.parse({
        platform: "android",
        waitFor: { for: "appear", elementId: "x", activeWindow: { appId: "com.z" } },
      })
    ).toThrow();
  });

  test("mixing `for` with a legacy-only element field (className) is rejected", () => {
    expect(() =>
      observeSchema.parse({
        platform: "android",
        waitFor: { for: "appear", elementId: "x", className: "android.widget.Button" },
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Standalone tool schemas (AC1 / AC2)
// ---------------------------------------------------------------------------
describe("settleObserveSchema", () => {
  test("accepts an empty settle request (all defaults)", () => {
    expect(settleObserveSchema.parse({ platform: "android" })).toMatchObject({ platform: "android" });
  });

  test("accepts tuning knobs", () => {
    const parsed = settleObserveSchema.parse({ platform: "ios", timeoutMs: 4000, pollMs: 200, stableReads: 3 });
    expect(parsed).toMatchObject({ timeoutMs: 4000, pollMs: 200, stableReads: 3 });
  });
});

describe("waitForConditionSchema", () => {
  test("accepts a valid appear condition", () => {
    expect(waitForConditionSchema.parse({ platform: "android", for: "appear", elementId: "x" })).toMatchObject({
      for: "appear",
      elementId: "x",
    });
  });

  test("does not offer `stable` (that is the settleObserve tool)", () => {
    expect(() => waitForConditionSchema.parse({ platform: "android", for: "stable" })).toThrow();
  });

  test("requires a selector for appear", () => {
    expect(() => waitForConditionSchema.parse({ platform: "android", for: "appear" })).toThrow();
  });

  test("accepts a container scope", () => {
    expect(waitForConditionSchema.parse({
      platform: "android",
      for: "appear",
      elementId: "row",
      container: { text: "Recent orders" },
    })).toMatchObject({ container: { text: "Recent orders" } });
  });
});

// ---------------------------------------------------------------------------
// Standalone tool handler cores (AC1 / AC2) — injected ObserveScreen + timer
// ---------------------------------------------------------------------------
describe("runSettleObserveTool", () => {
  test("returns the settled final snapshot", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const settled = makeObservation([node({ "resource-id": "content", "text": "done" })], 30);
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "content", "text": "loading" })], 10),
      settled,
      settled,
    ]);

    const result = await runSettleObserveTool(observeScreen, { platform: "android" } as any, timer);
    expect(result.settled).toBe(true);
    expect(result.observation.viewHierarchy).toBeDefined();
  });
});

describe("runWaitForConditionTool", () => {
  test("builds the predicate from the DSL and resolves with the matched element", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "spinner" })], 10),
      makeObservation([node({ "resource-id": "submit", "text": "Go" })], 20),
    ]);

    const result = await runWaitForConditionTool(
      observeScreen,
      { platform: "android", for: "appear", elementId: "submit" } as any,
      timer
    );
    expect(result.matched).toBe(true);
    expect(result.matchedElement?.["resource-id"]).toBe("submit");
  });

  test("does not satisfy a condition from outside the requested container", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      makeObservation([
        node({ "resource-id": "other", "node": [node({ "resource-id": "submit" })] }),
        node({ "resource-id": "checkout", "node": [] }),
      ], 10),
      makeObservation([
        node({ "resource-id": "other", "node": [node({ "resource-id": "submit" })] }),
        node({ "resource-id": "checkout", "node": [node({ "resource-id": "submit" })] }),
      ], 20),
    ]);

    const result = await runWaitForConditionTool(
      observeScreen,
      {
        platform: "android",
        for: "appear",
        elementId: "submit",
        container: { elementId: "checkout" },
      } as any,
      timer
    );

    expect(result.matched).toBe(true);
    expect(result.observation.updatedAt).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Registration (AC1 / AC2) — the tools are reachable from the registry
// ---------------------------------------------------------------------------
describe("tool registration", () => {
  test("registers settleObserve and waitForCondition as served (not debug-only) device-aware tools", () => {
    registerObserveTools();
    // The default getAllTools() is the served, availability-filtered set — asserting
    // against it (not includeUnavailable) proves the tools are actually reachable,
    // not merely present but gated off as debugOnly.
    const names = ToolRegistry.getAllTools().map(tool => tool.name);
    expect(names).toContain("settleObserve");
    expect(names).toContain("waitForCondition");
  });
});
