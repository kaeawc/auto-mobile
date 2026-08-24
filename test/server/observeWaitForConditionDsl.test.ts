import { describe, expect, test } from "bun:test";
import type { ObserveResult, ViewHierarchyResult } from "../../src/models";
import {
  buildConditionPredicate,
  observeSchema,
  registerObserveTools,
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
        bounds: flatBounds(0, 0, 200, 200),
        node: children,
      },
    },
    screenWidth: 200,
    screenHeight: 200,
  }) as unknown as ViewHierarchyResult;

const makeObservation = (children: Record<string, unknown>[], updatedAt = 0): ObserveResult =>
  ({
    updatedAt,
    screenSize: { width: 200, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 0 },
    viewHierarchy: makeHierarchy(children),
  }) as ObserveResult;

const node = (props: Record<string, unknown>): Record<string, unknown> => ({
  bounds: flatBounds(0, 0, 10, 10),
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
      node({ "resource-id": "other", node: [node({ "resource-id": "submit" })] }),
      node({ "resource-id": "checkout", node: [] }),
    ]);

    expect(predicate(observation).matched).toBe(false);
  });

  test("disappear -> matches an absent element", () => {
    const predicate = buildConditionPredicate(finder, "disappear", { elementId: "spinner" });
    expect(predicate(makeObservation([node({ "resource-id": "content" })])).matched).toBe(true);
  });

  test("clickable -> requires the element to be clickable", () => {
    const predicate = buildConditionPredicate(finder, "clickable", { elementId: "btn" });
    expect(
      predicate(makeObservation([node({ "resource-id": "btn", clickable: false })])).matched,
    ).toBe(false);
    expect(
      predicate(makeObservation([node({ "resource-id": "btn", clickable: true })])).matched,
    ).toBe(true);
  });

  test("textEquals -> uses text as the exact expected value", () => {
    const predicate = buildConditionPredicate(finder, "textEquals", {
      elementId: "counter",
      text: "5",
    });
    expect(
      predicate(makeObservation([node({ "resource-id": "counter", text: "50" })])).matched,
    ).toBe(false);
    expect(
      predicate(makeObservation([node({ "resource-id": "counter", text: "5" })])).matched,
    ).toBe(true);
  });

  test("textEquals -> retains its container scope", () => {
    const predicate = buildConditionPredicate(finder, "textEquals", {
      elementId: "counter",
      text: "5",
      container: { elementId: "checkout" },
    });
    expect(
      predicate(
        makeObservation([
          node({ "resource-id": "other", node: [node({ "resource-id": "counter", text: "5" })] }),
          node({ "resource-id": "checkout", node: [] }),
        ]),
      ).matched,
    ).toBe(false);
  });

  test("countStable -> settles once the match count repeats", () => {
    const predicate = buildConditionPredicate(
      finder,
      "countStable",
      { elementId: "row" },
      { stableReads: 2 },
    );
    expect(predicate(makeObservation([node({ "resource-id": "row" })])).matched).toBe(false);
    expect(predicate(makeObservation([node({ "resource-id": "row" })])).matched).toBe(true);
  });

  test("textEquals without text is rejected (text is the required expected value)", () => {
    expect(() => buildConditionPredicate(finder, "textEquals", { elementId: "counter" })).toThrow(
      /text/,
    );
  });
});

// ---------------------------------------------------------------------------
// observe waitFor DSL path via the injectable waitForObservation seam (AC3)
// ---------------------------------------------------------------------------
describe("waitForObservation DSL branch", () => {
  test("for:'appear' retains condition metadata alongside the awaited-element compatibility field", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "spinner" })], 10),
      makeObservation([node({ "resource-id": "submit", text: "Go" })], 20),
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      { for: "appear", elementId: "submit" } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(outcome.awaitedElement?.["resource-id"]).toBe("submit");
    expect(outcome.matched).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.matchedElement?.["resource-id"]).toBe("submit");
    expect(outcome.polls).toBe(2);
    expect(outcome.waitMs).toBeGreaterThanOrEqual(0);
  });

  test("for:'stable' retains settle metadata and returns the final settled snapshot", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const settled = makeObservation([node({ "resource-id": "content", text: "done" })], 30);
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "content", text: "loading" })], 10),
      settled,
      settled,
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      { for: "stable" } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(outcome.awaitedElement).toBeUndefined();
    expect(outcome.settled).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.polls).toBe(3);
    expect(outcome.waitMs).toBeGreaterThanOrEqual(0);
  });

  test("for:'textEquals' waits until the located element shows the exact value", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "counter", text: "4" })], 10),
      makeObservation([node({ "resource-id": "counter", text: "5" })], 20),
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      { for: "textEquals", elementId: "counter", text: "5" } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(outcome.awaitedElement?.text).toBe("5");
  });

  test("for:'clickable' retains timeout candidates rather than a bare timeout", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult((index) =>
      makeObservation(
        [node({ "resource-id": "submit", text: "Go", clickable: false })],
        (index + 1) * 10,
      ),
    );

    const outcome = await waitForObservation(
      observeScreen,
      { for: "clickable", elementId: "submit", timeout: 300 } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(true);
    expect(outcome.awaitedElement).toBeUndefined();
    expect(outcome.matched).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.candidates).toEqual([expect.objectContaining({ "resource-id": "submit" })]);
    expect(outcome.polls).toBeGreaterThan(1);
  });

  test("for:'stable' reports a screen-off fast-fail without claiming a timeout", async () => {
    const timer = new FakeTimer();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult({
      ...makeObservation([node({ "resource-id": "content" })], 10),
      wakefulness: "Asleep",
    });

    const outcome = await waitForObservation(
      observeScreen,
      { for: "stable" } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.settled).toBe(false);
    expect(outcome.awaitTimeout).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.polls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Back-compat: the legacy element-appear waitFor form is untouched (AC4)
// ---------------------------------------------------------------------------
describe("waitFor back-compat", () => {
  test("legacy waitFor reports settled when its quiet gate succeeds", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const observation = makeObservation([node({ "resource-id": "submit" })], 10);
    observeScreen.setObserveResult(observation);

    const outcome = await waitForObservation(
      observeScreen,
      { elementId: "submit", settled: { quietPeriodMs: 100 } },
      undefined,
      false,
      timer,
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.settled).toBe(true);
    expect(outcome.timedOut).toBe(false);
  });

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

  test("rejects dual timeout aliases across all waitFor forms", () => {
    for (const waitFor of [
      { for: "appear", elementId: "x" },
      { elementId: "x" },
      { textAny: ["x"] },
    ]) {
      expect(() =>
        observeSchema.parse({
          platform: "android",
          waitFor: { ...waitFor, timeout: 1000, timeoutMs: 1000 },
        }),
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

  test("DSL `for: stable` rejects container because settling is whole-screen", () => {
    expect(() =>
      observeSchema.parse({
        platform: "android",
        waitFor: { for: "stable", container: { elementId: "scope" } },
      }),
    ).toThrow(/does not support container/);
  });

  test("DSL `for: appear` without a selector is rejected", () => {
    expect(() =>
      observeSchema.parse({ platform: "android", waitFor: { for: "appear" } }),
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
      }),
    ).toThrow();
  });

  test("mixing `for` with a legacy-only element field (className) is rejected", () => {
    expect(() =>
      observeSchema.parse({
        platform: "android",
        waitFor: { for: "appear", elementId: "x", className: "android.widget.Button" },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Registration — the consolidated surface has no standalone polling tools.
// ---------------------------------------------------------------------------
describe("tool registration", () => {
  test("does not advertise the retired standalone polling tools", () => {
    registerObserveTools();
    const names = ToolRegistry.getAllTools().map((tool) => tool.name);
    expect(names).not.toContain("settleObserve");
    expect(names).not.toContain("waitForCondition");
  });
});
