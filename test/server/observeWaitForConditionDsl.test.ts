import { describe, expect, test } from "bun:test";
import type { ObserveResult, ViewHierarchyResult } from "../../src/models";
import {
  buildConditionPredicate,
  observeSchema,
  registerObserveTools,
  waitForObservation,
  type WaitForWithSettled,
} from "../../src/server/observeTools";
import { ElementResolver } from "../../src/features/utility/ElementResolver";
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

const makeObservation = (children: Record<string, unknown>[], updatedAt = 0): ObserveResult => {
  const viewHierarchy = makeHierarchy(children);
  viewHierarchy.updatedAt = updatedAt;
  return {
    updatedAt,
    screenSize: { width: 200, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 0 },
    viewHierarchy,
  } as ObserveResult;
};

const node = (props: Record<string, unknown>): Record<string, unknown> => ({
  bounds: flatBounds(0, 0, 10, 10),
  ...props,
});

// ---------------------------------------------------------------------------
// buildConditionPredicate — the DSL branching (AC3 core)
// ---------------------------------------------------------------------------
describe("buildConditionPredicate", () => {
  const finder = new ElementResolver();

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
  test("for:'appear' falls back to substring matching when no exact text node exists", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      makeObservation([node({ text: "Account settings" })], 10),
      makeObservation([node({ text: "Account settings" })], 20),
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      { for: "appear", text: "Account" } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.matchedElement?.text).toBe("Account settings");
  });

  test("for:'appear' applies the settled quiet period and returns its stable hierarchy", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const stable = makeObservation(
      [node({ "resource-id": "submit" }), node({ text: "stable" })],
      30,
    );
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "spinner" })], 10),
      stable,
    ]);
    const outcome = await waitForObservation(
      observeScreen,
      {
        for: "appear",
        elementId: "submit",
        settled: { quietPeriodMs: 250 },
      } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );
    expect(outcome.settled).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.polls).toBeGreaterThan(1);
    expect(outcome.observation.viewHierarchy).toEqual(stable.viewHierarchy);
  });

  test("for:'appear' times out when the element disappears during the settled quiet period", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const withoutSubmit = makeObservation([node({ "resource-id": "spinner" })], 30);
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "submit" })], 10),
      makeObservation([node({ "resource-id": "submit" })], 20),
      withoutSubmit,
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      {
        for: "appear",
        elementId: "submit",
        settled: { quietPeriodMs: 200 },
        timeoutMs: 500,
      } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );

    expect(outcome.matched).toBe(false);
    expect(outcome.settled).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.matchedElement).toBeUndefined();
    expect(outcome.awaitedElement).toBeUndefined();
  });

  test("for:'appear' reports matched:true when the element stays present but hierarchy never settles", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult((index) =>
      makeObservation([node({ "resource-id": "submit", text: String(index) })], index + 1),
    );
    observeScreen.enableAutoVaryHierarchy();

    const outcome = await waitForObservation(
      observeScreen,
      {
        for: "appear",
        elementId: "submit",
        settled: { quietPeriodMs: 200 },
        timeoutMs: 500,
      } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.settled).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.matchedElement?.["resource-id"]).toBe("submit");
    expect(outcome.awaitedElement?.["resource-id"]).toBe("submit");
  });

  test("for:'appear' returns the current element after a failed settled recheck recovers", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      makeObservation([node({ "resource-id": "submit", text: "old" })], 10),
      makeObservation([node({ "resource-id": "submit", text: "old" })], 20),
      makeObservation([node({ "resource-id": "spinner" })], 30),
      makeObservation([node({ "resource-id": "submit", text: "new" })], 40),
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      {
        for: "appear",
        elementId: "submit",
        settled: { quietPeriodMs: 200 },
        timeoutMs: 700,
      } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.settled).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.matchedElement?.text).toBe("new");
    expect(outcome.awaitedElement?.text).toBe("new");
  });

  test("for:'appear' threads skipBackStack through every poll", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(makeObservation([node({ "resource-id": "submit" })]));
    await waitForObservation(
      observeScreen,
      { for: "appear", elementId: "submit" } satisfies WaitForWithSettled,
      undefined,
      true,
      timer,
    );
    expect(observeScreen.getExecuteOptions().length).toBeGreaterThan(0);
    expect(
      observeScreen.getExecuteOptions().every((options) => options.skipBackStack === true),
    ).toBe(true);
  });

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
      { for: "appear", elementId: "submit" } satisfies WaitForWithSettled,
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
      { for: "stable" } satisfies WaitForWithSettled,
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
      { for: "textEquals", elementId: "counter", text: "5" } satisfies WaitForWithSettled,
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
      { for: "clickable", elementId: "submit", timeout: 300 } satisfies WaitForWithSettled,
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
      { for: "stable" } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );

    expect(outcome.settled).toBe(false);
    expect(outcome.awaitTimeout).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.polls).toBe(1);
  });

  test("for:'stable' reports timeout when stale Asleep frames exhaust the budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult({
      ...makeObservation([node({ "resource-id": "content" })], 10),
      wakefulness: "Asleep",
      freshness: { isFresh: false, verified: false, category: "cache_age" },
    });

    const outcome = await waitForObservation(
      observeScreen,
      { for: "stable", timeout: 300 } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(true);
    expect(outcome.timedOut).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Back-compat: the legacy element-appear waitFor form is untouched (AC4)
// ---------------------------------------------------------------------------
describe("waitFor back-compat", () => {
  test("legacy waitFor retains a first-poll match when settling exceeds the deadline", async () => {
    const timer = new FakeTimer();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(() => {
      timer.advanceTime(300);
      return makeObservation([node({ text: "Sign in or register" })], 10);
    });

    const outcome = await waitForObservation(
      observeScreen,
      { text: "Sign in or register", settled: { quietPeriodMs: 200 }, timeoutMs: 300 },
      undefined,
      false,
      timer,
    );

    expect(outcome.polls).toBe(1);
    expect(outcome.matched).toBe(true);
    expect(outcome.settled).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.awaitedElement?.text).toBe("Sign in or register");
    expect(outcome.matchedElement?.text).toBe("Sign in or register");
  });

  test("legacy waitFor retains the last match when the hierarchy never settles", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult((index) =>
      makeObservation(
        [node({ text: "Sign in or register" }), node({ text: String(index) })],
        10 + index,
      ),
    );

    const outcome = await waitForObservation(
      observeScreen,
      { text: "Sign in or register", settled: { quietPeriodMs: 200 }, timeoutMs: 300 },
      undefined,
      false,
      timer,
    );

    expect(outcome.polls).toBe(4);
    expect(outcome.matched).toBe(true);
    expect(outcome.settled).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.awaitedElement?.text).toBe("Sign in or register");
    expect(outcome.matchedElement?.text).toBe("Sign in or register");
  });

  test("legacy waitFor clears element evidence when the last predicate fails", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult((index) => ({
      ...makeObservation([node({ "resource-id": "submit", text: String(index) })], 10 + index),
      activeWindow: {
        appId: index < 3 ? "com.example" : "com.other",
        activityName: ".Main",
        layoutSeqSum: 0,
      },
    }));

    const outcome = await waitForObservation(
      observeScreen,
      {
        elementId: "submit",
        activeWindow: { appId: "com.example" },
        settled: { quietPeriodMs: 200 },
        timeoutMs: 300,
      },
      undefined,
      false,
      timer,
    );

    expect(outcome.polls).toBe(4);
    expect(outcome.matched).toBe(false);
    expect(outcome.settled).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.awaitedElement).toBeUndefined();
    expect(outcome.matchedElement).toBeUndefined();
  });

  test("legacy waitFor reports settled when its quiet gate succeeds", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult((index) =>
      makeObservation([node({ "resource-id": "submit" })], 10 + index),
    );

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
