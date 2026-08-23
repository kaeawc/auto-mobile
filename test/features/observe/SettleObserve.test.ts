import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { RealSettleObserve } from "../../../src/features/observe/SettleObserve";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Unit tests for `RealSettleObserve` (issue #4389).
 *
 * The settle loop polls until the hierarchy is structurally stable (two
 * consecutive structurally-equal snapshots, per the #3053 diff) or a budget
 * expires, returning only the final snapshot. All time control flows through
 * FakeTimer with a small budget so the PR #3144 auto-advance poll-flake cannot
 * bite; every test runs well under 100ms and never touches a device or the DB.
 */

/** Build a minimal ObserveResult around a single root node (+ optional overrides). */
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

/** iOS-shaped observation (no gfxinfo/wakefulness signal), for the cross-platform case. */
function iosObs(node: Record<string, unknown>, extra?: Partial<ObserveResult>): ObserveResult {
  return obs(node, {
    activeWindow: { appId: "com.apple.mobilesafari", activityName: "", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "com.apple.mobilesafari",
      hierarchy: { node: node as any },
    },
    screenIdentity: {
      platform: "ios",
      source: "heuristic",
      confidence: "high",
      key: "bundle=com.apple.mobilesafari|nav=Safari",
      components: { bundleId: "com.apple.mobilesafari", navigationTitle: "Safari" },
    },
    ...extra,
  } as ObserveResult);
}

describe("RealSettleObserve", () => {
  test("converges and returns only the final stable snapshot (never the transitions)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Transition (loading) -> settled -> settled-equal. Only the last is returned.
    fake.setObserveSequence([
      obs(
        { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "loading" },
        { updatedAt: 10 },
      ),
      obs(
        { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "done" },
        { updatedAt: 20 },
      ),
      obs(
        { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "done" },
        { updatedAt: 30 },
      ),
    ]);

    const settle = new RealSettleObserve(fake, timer);
    const result = await settle.execute({ timeoutMs: 2500, pollMs: 150 });

    expect(result.settled).toBe(true);
    expect(result.polls).toBe(3);
    // Final snapshot only — the "loading" transition never surfaces.
    expect((result.observation.viewHierarchy!.hierarchy.node as any).text).toBe("done");
    expect(result.observation.updatedAt).toBe(30);
  });

  test("stability comparator is the #3053 structural diff, not JSON.stringify", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Two captures of the SAME screen that differ only in volatile `extras`
    // metadata (and updatedAt). The #3053 diff ignores `extras` -> empty diff ->
    // settled. A naive JSON.stringify fingerprint would differ and never settle.
    const a = obs(
      {
        "resource-id": "x",
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        text: "hi",
        extras: "traversalIndex=1",
      },
      { updatedAt: 10 },
    );
    const b = obs(
      {
        "resource-id": "x",
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        text: "hi",
        extras: "traversalIndex=2",
      },
      { updatedAt: 20 },
    );
    fake.setObserveSequence([a, b]);

    // Control: a JSON.stringify comparator WOULD see these as different.
    expect(JSON.stringify(a.viewHierarchy!.hierarchy)).not.toBe(
      JSON.stringify(b.viewHierarchy!.hierarchy),
    );

    const settle = new RealSettleObserve(fake, timer);
    const result = await settle.execute({ timeoutMs: 2500, pollMs: 150 });

    expect(result.settled).toBe(true);
    expect(result.polls).toBe(2);
  });

  test("settles when only volatile occlusion attributes churn (would never settle otherwise on Android)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Two captures of the SAME idle Android screen. Occlusion attributes churn
    // nondeterministically between captures (documented in StableNodeIdentity)
    // and are diffed by diffObserveResult, so without the settle comparator
    // ignoring them this idle screen would report a `changed` entry every poll
    // and never settle.
    fake.setObserveSequence([
      obs(
        {
          "resource-id": "x",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: "hi",
          occlusionState: "occluded",
        },
        { updatedAt: 10 },
      ),
      obs(
        {
          "resource-id": "x",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: "hi",
          occlusionState: "visible",
        },
        { updatedAt: 20 },
      ),
    ]);

    const settle = new RealSettleObserve(fake, timer);
    const result = await settle.execute({ timeoutMs: 2500, pollMs: 150 });

    expect(result.settled).toBe(true);
    expect(result.polls).toBe(2);
  });

  test("does NOT settle when a real attribute changes alongside occlusion churn", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // `checked` flips (a real UI change) while occlusion also churns — the
    // volatile-attr allowance must not mask the genuine change.
    fake.setObserveResult((index) =>
      obs(
        {
          "resource-id": "cb",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: "Opt",
          checked: index % 2 === 0 ? "true" : "false",
          occlusionState: index % 2 === 0 ? "visible" : "occluded",
        },
        { updatedAt: (index + 1) * 10 },
      ),
    );

    const settle = new RealSettleObserve(fake, timer);
    const result = await settle.execute({ timeoutMs: 500, pollMs: 150 });

    expect(result.settled).toBe(false);
  });

  test("each poll uses a monotonic minTimestamp equal to the prior snapshot (cannot false-settle)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(
        { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "loading" },
        { updatedAt: 10 },
      ),
      obs(
        { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "done" },
        { updatedAt: 20 },
      ),
      obs(
        { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "done" },
        { updatedAt: 30 },
      ),
    ]);

    const settle = new RealSettleObserve(fake, timer);
    await settle.execute({ timeoutMs: 2500, pollMs: 150 });

    const mins = fake.getExecuteMinTimestamps();
    // First poll seeds from loop-start (0); each subsequent poll waits for a read
    // strictly newer than the previous observation's timestamp.
    expect(mins).toEqual([0, 10, 20]);
    // Monotonic non-decreasing.
    for (let i = 1; i < mins.length; i++) {
      expect(mins[i]!).toBeGreaterThanOrEqual(mins[i - 1]!);
    }
  });

  test("returns settled:false with the last snapshot on an ever-changing sequence (timeout)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // A spinner: every poll differs, so structural stability is never reached.
    fake.setObserveResult((index) =>
      obs(
        {
          "resource-id": "spinner",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: `frame-${index}`,
        },
        { updatedAt: (index + 1) * 10 },
      ),
    );

    const settle = new RealSettleObserve(fake, timer);
    const result = await settle.execute({ timeoutMs: 500, pollMs: 150 });

    expect(result.settled).toBe(false);
    expect(result.waitMs).toBeGreaterThanOrEqual(500);
    // The last snapshot is still returned so the caller always has something.
    expect((result.observation.viewHierarchy!.hierarchy.node as any).text).toBe(
      `frame-${result.polls - 1}`,
    );
  });

  test("works on iOS-shaped observations with no gfxinfo/wakefulness signal", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      iosObs(
        {
          "resource-id": "safari.url",
          bounds: { left: 0, top: 0, right: 100, bottom: 20 },
          text: "example.com",
        },
        { updatedAt: 10 },
      ),
      iosObs(
        {
          "resource-id": "safari.url",
          bounds: { left: 0, top: 0, right: 100, bottom: 20 },
          text: "example.com",
        },
        { updatedAt: 20 },
      ),
    ]);

    const settle = new RealSettleObserve(fake, timer);
    const result = await settle.execute({ timeoutMs: 2500, pollMs: 150 });

    expect(result.settled).toBe(true);
    expect(result.polls).toBe(2);
  });

  test("fast-fails when the screen is off (Android Asleep), without burning the budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult((index) =>
      obs(
        {
          "resource-id": "a",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: `f${index}`,
        },
        { updatedAt: (index + 1) * 10, wakefulness: "Asleep" },
      ),
    );

    const settle = new RealSettleObserve(fake, timer);
    const result = await settle.execute({ timeoutMs: 2500, pollMs: 150 });

    expect(result.settled).toBe(false);
    expect(result.polls).toBe(1);
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
          "resource-id": "a",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          text: `f${index}`,
        },
        { updatedAt: (index + 1) * 10 },
      );
    });

    const settle = new RealSettleObserve(fake, timer);
    await expect(
      settle.execute({ timeoutMs: 2500, pollMs: 150, signal: controller.signal }),
    ).rejects.toThrow("Operation cancelled");
  });
});
