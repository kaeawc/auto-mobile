import { describe, expect, test } from "bun:test";
import type { Element } from "../../../src/models/Element";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { ConditionPredicate } from "../../../src/features/observe/interfaces/WaitForCondition";
import { RealWaitForCondition } from "../../../src/features/observe/WaitForCondition";
import { appear, disappear } from "../../../src/features/observe/ConditionPredicates";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Unit tests for `RealWaitForCondition` (issue #4389).
 *
 * The wait loop polls with a monotonic minTimestamp (shared with the settle
 * loop), evaluates a predicate over each observation, and resolves with the
 * matched element — or, on timeout, the last-seen near-matches (never a bare
 * `false`). FakeTimer + a small budget keep every case deterministic and <100ms
 * with no device or DB.
 */

function obs(node: Record<string, unknown>, extra?: Partial<ObserveResult>): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "com.example",
      hierarchy: { node: node as any },
    },
    ...extra,
  } as ObserveResult;
}

/** A root node wrapping the given children (each must carry bounds to parse). */
function root(children: Record<string, unknown>[]): Record<string, unknown> {
  return {
    "resource-id": "root",
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    node: children,
  };
}

describe("RealWaitForCondition", () => {
  test("resolves on predicate-true with the matched element", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(
        {
          "resource-id": "screen",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: "loading",
        },
        { updatedAt: 10 },
      ),
      obs(
        {
          "resource-id": "screen",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: "ready",
        },
        { updatedAt: 20 },
      ),
    ]);

    const predicate: ConditionPredicate = (observation) => {
      const node = observation.viewHierarchy?.hierarchy?.node as
        | Record<string, unknown>
        | undefined;
      return node?.text === "ready"
        ? {
            matched: true,
            matchedElement: node as unknown as Element,
            candidates: [node as unknown as Element],
          }
        : { matched: false, candidates: [] };
    };

    const waitFor = new RealWaitForCondition(fake, timer);
    const result = await waitFor.execute(predicate, { timeoutMs: 2500, pollMs: 150 });

    expect(result.matched).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.polls).toBe(2);
    expect(result.matchedElement!.text).toBe("ready");
    expect(fake.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(true);
  });

  test("on timeout returns the last-seen candidates, not a bare failure", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult((index) =>
      obs(
        {
          "resource-id": "screen",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: `frame-${index}`,
        },
        { updatedAt: (index + 1) * 10 },
      ),
    );

    // Never matches, but always reports the current node as a near-match.
    const predicate: ConditionPredicate = (observation) => {
      const node = observation.viewHierarchy?.hierarchy?.node as unknown as Element;
      return { matched: false, candidates: [node] };
    };

    const waitFor = new RealWaitForCondition(fake, timer);
    const result = await waitFor.execute(predicate, { timeoutMs: 500, pollMs: 150 });

    expect(result.matched).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.matchedElement).toBeUndefined();
    // Debuggable: the last poll's near-matches, not an empty/bare failure.
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].text).toBe(`frame-${result.polls - 1}`);
  });

  test("each poll uses a monotonic minTimestamp (shared poll loop)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(
        { "resource-id": "screen", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "a" },
        { updatedAt: 10 },
      ),
      obs(
        { "resource-id": "screen", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "b" },
        { updatedAt: 20 },
      ),
      obs(
        {
          "resource-id": "screen",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: "match",
        },
        { updatedAt: 30 },
      ),
    ]);
    const predicate: ConditionPredicate = (observation) => {
      const node = observation.viewHierarchy?.hierarchy?.node as
        | Record<string, unknown>
        | undefined;
      return node?.text === "match"
        ? { matched: true, matchedElement: node as unknown as Element }
        : { matched: false, candidates: [] };
    };

    const waitFor = new RealWaitForCondition(fake, timer);
    await waitFor.execute(predicate, { timeoutMs: 2500, pollMs: 150 });

    expect(fake.getExecuteMinTimestamps()).toEqual([0, 10, 20]);
  });

  test("built-in `appear` predicate reuses the finder and resolves when the element shows up", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const finder = new DefaultElementFinder();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(
        root([
          {
            "resource-id": "spinner",
            bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            text: "…",
          },
        ]),
        { updatedAt: 10 },
      ),
      obs(
        root([
          {
            "resource-id": "submit",
            bounds: { left: 0, top: 20, right: 10, bottom: 30 },
            text: "Submit",
          },
        ]),
        { updatedAt: 20 },
      ),
    ]);

    const waitFor = new RealWaitForCondition(fake, timer);
    const result = await waitFor.execute(appear(finder, { elementId: "submit" }), {
      timeoutMs: 2500,
      pollMs: 150,
    });

    expect(result.matched).toBe(true);
    expect(result.matchedElement!["resource-id"]).toBe("submit");
    expect(result.polls).toBe(2);
  });

  test("built-in `disappear` predicate resolves when the element is gone", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const finder = new DefaultElementFinder();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(
        root([
          {
            "resource-id": "progress",
            bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            text: "Loading",
          },
        ]),
        { updatedAt: 10 },
      ),
      obs(
        root([
          {
            "resource-id": "content",
            bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            text: "Done",
          },
        ]),
        { updatedAt: 20 },
      ),
    ]);

    const waitFor = new RealWaitForCondition(fake, timer);
    const result = await waitFor.execute(disappear(finder, { elementId: "progress" }), {
      timeoutMs: 2500,
      pollMs: 150,
    });

    expect(result.matched).toBe(true);
    expect(result.polls).toBe(2);
  });

  test("works on iOS-shaped observations (no gfxinfo dependency)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const finder = new DefaultElementFinder();
    const fake = new FakeObserveScreen();
    const iosExtra: Partial<ObserveResult> = {
      activeWindow: { appId: "com.apple.mobilesafari", activityName: "", layoutSeqSum: 1 },
      screenIdentity: {
        platform: "ios",
        source: "heuristic",
        confidence: "high",
        key: "bundle=com.apple.mobilesafari",
        components: { bundleId: "com.apple.mobilesafari" },
      },
    };
    fake.setObserveSequence([
      obs(
        root([
          {
            "resource-id": "loading",
            bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            text: "…",
          },
        ]),
        { updatedAt: 10, ...iosExtra },
      ),
      obs(
        root([
          {
            "resource-id": "Done",
            bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            text: "Done",
          },
        ]),
        { updatedAt: 20, ...iosExtra },
      ),
    ]);

    const waitFor = new RealWaitForCondition(fake, timer);
    const result = await waitFor.execute(appear(finder, { text: "Done" }), {
      timeoutMs: 2500,
      pollMs: 150,
    });

    expect(result.matched).toBe(true);
    expect(result.matchedElement!.text).toBe("Done");
  });

  test("aborts mid-poll when the signal fires", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const controller = new AbortController();
    fake.setObserveResult((index) => {
      if (index === 1) {
        controller.abort();
      }
      return obs(
        {
          "resource-id": "screen",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: `f${index}`,
        },
        { updatedAt: (index + 1) * 10 },
      );
    });
    const predicate: ConditionPredicate = () => ({ matched: false, candidates: [] });

    const waitFor = new RealWaitForCondition(fake, timer);
    await expect(
      waitFor.execute(predicate, { timeoutMs: 2500, pollMs: 150, signal: controller.signal }),
    ).rejects.toThrow("Operation cancelled");
  });
});
