import { describe, expect, spyOn, test } from "bun:test";
import type {
  SettleObserve,
  SettleOptions,
} from "../../src/features/observe/interfaces/SettleObserve";
import type { ObserveResult } from "../../src/models/ObserveResult";
import {
  EMBEDDED_OBSERVATION_SETTLE_FENCE_MARGIN_MS,
  EMBEDDED_OBSERVATION_SETTLE_MAX_TIMEOUT_MS,
  EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS,
  embeddedObservationSettleCapMs,
  resolveEmbeddedObservationSettleBudgetMs,
  settleEmbeddedObservation,
  settleEmbeddedObservationInResponse,
} from "../../src/server/embeddedObservationSettle";
import { tapOnSchema } from "../../src/server/interactionTools/tapSchemas";
import { RealSettleObserve } from "../../src/features/observe/SettleObserve";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { logger } from "../../src/utils/logger";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Hard cap and per-call budget for the embedded-observation settle gate
 * (#17663). FakeTimer + fakes only.
 */

function clockObservation(updatedAt: number): ObserveResult {
  return {
    updatedAt,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "com.example",
      hierarchy: {
        node: {
          class: "android.widget.TextView",
          "resource-id": "com.example:id/clock",
          text: `t${updatedAt}`,
        },
      },
      updatedAt,
    },
  } as ObserveResult;
}

/** A settle delegate whose read never resolves and never looks at its signal. */
function deafSettle(): { settle: SettleObserve; calls: SettleOptions[] } {
  const calls: SettleOptions[] = [];
  return {
    calls,
    settle: {
      execute: (options = {}) => {
        calls.push(options);
        return new Promise(() => {});
      },
    },
  };
}

describe("embedded settle gate hard cap (#17663)", () => {
  test("a read that ignores its abort signal is cut off at the cap with settled:false", async () => {
    const timer = new FakeTimer();
    const { settle } = deafSettle();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const captured = clockObservation(10);
      const pending = settleEmbeddedObservation({
        actionClass: "navigation",
        observation: captured,
        settleObserve: settle,
        timer,
      });
      const capMs = embeddedObservationSettleCapMs(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS);
      expect(capMs).toBe(
        EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS + EMBEDDED_OBSERVATION_SETTLE_FENCE_MARGIN_MS,
      );
      timer.advanceTime(capMs);
      const outcome = await pending;

      expect(outcome.observation).toBe(captured);
      expect(outcome.settled).toBe(false);
      expect(outcome.settleMs).toBe(capMs);
      expect(outcome.settlePolls).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("a per-call budget bounds the loop and shortens the cap with it", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult((index) => clockObservation(20 + index * 10));
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: clockObservation(10),
      settleObserve: new RealSettleObserve(fake, timer),
      timer,
      budgetMs: 300,
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.settleMs).toBe(300);
    expect(outcome.settlePolls).toBeGreaterThan(0);
    expect(embeddedObservationSettleCapMs(300)).toBe(600);
  });

  test("a deaf read under a per-call budget returns at the shortened cap", async () => {
    const timer = new FakeTimer();
    const { settle, calls } = deafSettle();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const pending = settleEmbeddedObservation({
        actionClass: "navigation",
        observation: clockObservation(10),
        settleObserve: settle,
        timer,
        budgetMs: 200,
      });
      timer.advanceTime(400);
      const outcome = await pending;

      expect(calls[0]?.timeoutMs).toBe(200);
      expect(outcome.settled).toBe(false);
      expect(outcome.settleMs).toBe(400);
    } finally {
      warn.mockRestore();
    }
  });

  test("a zero budget skips re-observation and reports the capture unsettled", async () => {
    const timer = new FakeTimer();
    const { settle, calls } = deafSettle();
    const captured = clockObservation(10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settle,
      timer,
      budgetMs: 0,
    });

    expect(calls).toHaveLength(0);
    expect(outcome).toEqual({ observation: captured, settled: false });
  });
});

describe("per-call settleTimeoutMs (#17663)", () => {
  test.each([
    [undefined, EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS],
    [{}, EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS],
    [{ settleTimeoutMs: 0 }, 0],
    [{ settleTimeoutMs: 250 }, 250],
    [{ settleTimeoutMs: EMBEDDED_OBSERVATION_SETTLE_MAX_TIMEOUT_MS }, 3000],
    [{ settleTimeoutMs: EMBEDDED_OBSERVATION_SETTLE_MAX_TIMEOUT_MS + 1 }, 1000],
    [{ settleTimeoutMs: -1 }, 1000],
    [{ settleTimeoutMs: "500" }, 1000],
    [{ settleTimeoutMs: Number.NaN }, 1000],
  ])("args %p resolve to a %p ms budget", (args, expected) => {
    expect(resolveEmbeddedObservationSettleBudgetMs(args)).toBe(expected);
  });

  test("tapOn accepts settleTimeoutMs within bounds and rejects it outside them", () => {
    const base = { selector: { text: "Back" }, platform: "android" };
    expect(tapOnSchema.safeParse({ ...base, settleTimeoutMs: 0 }).success).toBe(true);
    expect(tapOnSchema.safeParse({ ...base, settleTimeoutMs: 1500 }).success).toBe(true);
    expect(
      tapOnSchema.safeParse({
        ...base,
        settleTimeoutMs: EMBEDDED_OBSERVATION_SETTLE_MAX_TIMEOUT_MS + 1,
      }).success,
    ).toBe(false);
    expect(tapOnSchema.safeParse({ ...base, settleTimeoutMs: -1 }).success).toBe(false);
  });

  test("a tapOn response with settleTimeoutMs 0 is stamped unsettled without re-observing", async () => {
    const observation = clockObservation(10);
    const response = createStructuredToolResponse({ success: true, observation });
    const { settle, calls } = deafSettle();
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: { selector: { text: "Back" }, settleTimeoutMs: 0 },
      internal: false,
      createSettleObserve: () => settle,
      timer: new FakeTimer(),
    });

    expect(calls).toHaveLength(0);
    const stamped = response.structuredContent!.observation;
    expect(stamped.settled).toBe(false);
    expect(stamped.settleMs).toBeUndefined();
  });

  test("a tapOn response forwards its settleTimeoutMs as the loop budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult((index) => clockObservation(20 + index * 10));
    const observation = clockObservation(10);
    const response = createStructuredToolResponse({ success: true, observation });
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: { selector: { text: "Back" }, settleTimeoutMs: 450 },
      internal: false,
      createSettleObserve: () => new RealSettleObserve(fake, timer),
      timer,
    });

    const stamped = response.structuredContent!.observation;
    expect(stamped.settled).toBe(false);
    expect(stamped.settleMs).toBe(450);
  });
});
