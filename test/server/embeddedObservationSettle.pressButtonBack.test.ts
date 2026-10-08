import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ObserveResult } from "../../src/models/ObserveResult";
import type { ObserveScreenExecuteOptions } from "../../src/features/observe/interfaces/ObserveScreen";
import { RealSettleObserve } from "../../src/features/observe/SettleObserve";
import {
  EMBEDDED_OBSERVATION_SETTLE_POLL_MS,
  EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS,
  settleEmbeddedObservationInResponse,
} from "../../src/server/embeddedObservationSettle";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * `pressButton back` landing on a screen that is already still (#9591).
 *
 * The destination is a real emulator capture (Settings > Apps > Playground > Open by default),
 * re-served on every read with a newer device timestamp, as a fresh CtrlProxy extraction of an
 * unchanged screen would be. Each read costs `readMs` of fake time, standing in for the full
 * observe pipeline on a loaded host. A read cut short by the remaining budget comes back
 * unverified, as the real hierarchy read does when its deadline expires.
 */
const DESTINATION: ObserveResult = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/android-settings/open-by-default-radio-rows.observe.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const DEVICE_CLOCK_BASE = DESTINATION.viewHierarchy!.updatedAt as number;

function captureAt(deviceMs: number, verified = true): ObserveResult {
  const observation = structuredClone(DESTINATION);
  observation.updatedAt = deviceMs;
  observation.viewHierarchy!.updatedAt = deviceMs;
  observation.freshness = { isFresh: verified, verified, actualTimestamp: deviceMs, ageMs: 0 };
  return observation;
}

class TimedStillScreen extends FakeObserveScreen {
  constructor(
    private readonly timer: FakeTimer,
    private readonly readMs: number,
  ) {
    super();
    // Records each read's options; the timed result below replaces its return value.
    this.setObserveResult(DESTINATION);
  }

  override async execute(options: ObserveScreenExecuteOptions = {}): Promise<ObserveResult> {
    await super.execute(options);
    const budget = options.timeoutMs ?? Number.POSITIVE_INFINITY;
    const spent = Math.min(this.readMs, budget);
    await this.timer.sleep(spent);
    if (spent < this.readMs) {
      // The read's deadline expired before a fresh extraction landed.
      return captureAt(DEVICE_CLOCK_BASE, false);
    }
    return captureAt(DEVICE_CLOCK_BASE + this.timer.now());
  }
}

async function pressBack(readMs: number) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const screen = new TimedStillScreen(timer, readMs);
  // The action's own post-press capture, taken at device time 0 of this run.
  const response = createStructuredToolResponse({
    success: true,
    button: "back",
    keyCode: 4,
    observation: captureAt(DEVICE_CLOCK_BASE),
  });
  await settleEmbeddedObservationInResponse(response, {
    name: "pressButton",
    args: { button: "back" },
    internal: false,
    timer,
    createSettleObserve: () => new RealSettleObserve(screen, timer),
  });
  return { response, screen, observation: response.structuredContent!.observation };
}

describe("pressButton back on a still screen (#9591)", () => {
  // Two fresh reads plus one poll interval must fit in the budget.
  const slowestSettlingReadMs = Math.floor(
    (EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS - EMBEDDED_OBSERVATION_SETTLE_POLL_MS) / 2,
  );

  test.each([50, 200, slowestSettlingReadMs])(
    "settles when each read takes %pms, and reports how long the gate took",
    async (readMs) => {
      const { observation, screen } = await pressBack(readMs);
      expect(observation.settled).toBe(true);
      expect(observation.settlePolls).toBe(2);
      expect(observation.settleMs).toBe(2 * readMs + EMBEDDED_OBSERVATION_SETTLE_POLL_MS);
      expect(screen.getExecuteCallCount()).toBe(2);
    },
  );

  test.each([slowestSettlingReadMs + 1, 600, 900])(
    "reports settled:false at the budget, not early, when each read takes %pms",
    async (readMs) => {
      const { observation } = await pressBack(readMs);
      expect(observation.settled).toBe(false);
      expect(observation.settleMs).toBeGreaterThanOrEqual(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS);
      expect(observation.settlePolls).toBeLessThanOrEqual(2);
    },
  );

  test("settleMs and settlePolls survive finalization in full and diff shapes", async () => {
    const { response } = await pressBack(200);
    const finalized = finalizeToolResponse(response, {
      name: "pressButton",
      args: { button: "back" },
    });
    const emitted = finalized.structuredContent!.observation;
    expect(emitted.settled).toBe(true);
    expect(emitted.settleMs).toBe(550);
    expect(emitted.settlePolls).toBe(2);
  });
});
