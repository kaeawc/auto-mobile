import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";
import {
  HARD_BUDGET_MIN_POLL_READ_MS,
  pollObserveUntil,
} from "../../../src/features/observe/ObservePoll";
import { RealSettleObserve } from "../../../src/features/observe/SettleObserve";
import { settleEmbeddedObservation } from "../../../src/server/embeddedObservationSettle";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Hard settle budget (#17670): every poll read and terminal read is raced
 * against the remaining budget, the read the budget cuts off is aborted, and no
 * poll starts with less than HARD_BUDGET_MIN_POLL_READ_MS left. FakeTimer only.
 */

function capture(updatedAt: number, marker: string): ObserveResult {
  return {
    updatedAt,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "com.example",
      // Moves every read, so the screen never settles.
      hierarchy: {
        node: {
          "resource-id": "com.example:id/row",
          text: marker,
          bounds: { left: 0, top: updatedAt, right: 100, bottom: 50 + updatedAt },
        },
      },
      updatedAt,
    },
  } as ObserveResult;
}

/** Each read takes the next duration from `readMs` of fake time; records the signals it was given. */
class TimedObserveScreen extends FakeObserveScreen {
  readonly signals: Array<AbortSignal | undefined> = [];
  private reads = 0;

  constructor(
    private readonly timer: FakeTimer,
    private readonly readMs: readonly number[],
  ) {
    super();
    this.setObserveResult((index) => capture(10 + index * 10, `read-${index}`));
  }

  override async execute(options: ObserveScreenExecuteOptions = {}): Promise<ObserveResult> {
    const result = await super.execute(options);
    this.signals.push(options.signal);
    const ms = this.readMs[Math.min(this.reads++, this.readMs.length - 1)];
    await this.timer.sleep(ms);
    return result;
  }
}

function poll(screen: TimedObserveScreen, timer: FakeTimer, hardBudget: boolean) {
  return pollObserveUntil(screen, timer, { timeoutMs: 1000, pollMs: 150, hardBudget }, () => false);
}

describe("pollObserveUntil hard budget (#17670)", () => {
  test("a slow read is cut off at the budget and aborted, returning the earlier capture", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new TimedObserveScreen(timer, [100, 5000]);
    const outcome = await poll(screen, timer, true);

    expect(outcome.terminalReason).toBe("timeout");
    expect(outcome.polls).toBe(1);
    expect(outcome.observation.viewHierarchy?.updatedAt).toBe(10);
    // The deadline is inclusive of the budget's last millisecond.
    expect(outcome.waitMs).toBe(1001);
    expect(screen.signals[1]?.aborted).toBe(true);
    expect(screen.signals[0]?.aborted).toBe(false);
  });

  test("without a hard budget the same read is waited for", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new TimedObserveScreen(timer, [100, 5000]);
    const outcome = await poll(screen, timer, false);

    expect(outcome.polls).toBe(2);
    expect(outcome.waitMs).toBe(5250);
  });

  test("no poll starts with less than the minimum read time left", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    // Reads end at 400 and 800; after the 150ms poll sleep 50ms remain, under the minimum.
    const screen = new TimedObserveScreen(timer, [400, 250, 400]);
    const outcome = await poll(screen, timer, true);

    expect(1000 - outcome.waitMs).toBeLessThan(HARD_BUDGET_MIN_POLL_READ_MS);
    expect(outcome.polls).toBe(2);
    expect(screen.getExecuteCallCount()).toBe(2);
    expect(outcome.waitMs).toBe(950);
  });

  test("a soft budget still takes the short last poll", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new TimedObserveScreen(timer, [400, 250, 400]);
    const outcome = await poll(screen, timer, false);
    expect(screen.getExecuteCallCount()).toBe(3);
    expect(screen.getExecuteOptions()[2].timeoutMs).toBe(50);
    expect(outcome.waitMs).toBe(1350);
  });

  test("a first read cut off by the budget throws, since there is nothing to return", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new TimedObserveScreen(timer, [5000]);
    const error = await poll(screen, timer, true).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect(screen.signals[0]?.aborted).toBe(true);
    expect(timer.now()).toBe(1001);
  });

  test("the terminal back-stack read is raced against the remaining budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new TimedObserveScreen(timer, [100, 100]);
    let backStackSignal: AbortSignal | undefined;
    screen.collectDeferredBackStack = async (_observation, options) => {
      backStackSignal = options?.signal;
      await timer.sleep(5000);
      return true;
    };
    const outcome = await pollObserveUntil(
      screen,
      timer,
      { timeoutMs: 1000, pollMs: 150, hardBudget: true },
      (_observation, previous) => previous !== undefined,
    );

    expect(outcome.terminalReason).toBe("matched");
    // The reconciliation capture never started: the back-stack read used up the budget.
    expect(screen.getExecuteCallCount()).toBe(2);
    expect(backStackSignal?.aborted).toBe(true);
    expect(timer.now()).toBe(1001);
    expect(outcome.waitMs).toBe(1001);
  });

  test("the reconciliation capture is raced against the remaining budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new TimedObserveScreen(timer, [100, 100, 5000]);
    screen.setDeferredBackStackDisagreement(true);
    const outcome = await pollObserveUntil(
      screen,
      timer,
      { timeoutMs: 1000, pollMs: 150, hardBudget: true },
      (_observation, previous) => previous !== undefined,
    );

    expect(screen.getExecuteCallCount()).toBe(3);
    expect(screen.signals[2]?.aborted).toBe(true);
    // The cut-off reconciliation read is discarded, and the contradicted match is
    // not reported as one.
    expect(outcome.observation.viewHierarchy?.updatedAt).toBe(20);
    expect(outcome.stopped).toBe(false);
    expect(outcome.terminalReason).toBe("timeout");
    expect(outcome.waitMs).toBe(1001);
    expect(timer.now()).toBe(1001);
  });
});

describe("embedded settle gate hard budget (#17670)", () => {
  test("a slow read ends the gate at the loop budget, not the fence, and is aborted", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new TimedObserveScreen(timer, [200, 5000]);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: capture(5, "action"),
      settleObserve: new RealSettleObserve(screen, timer),
      timer,
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.settleMs).toBe(1001);
    expect(outcome.settlePolls).toBe(1);
    expect(screen.signals[1]?.aborted).toBe(true);
    expect(screen.getExecuteOptions().every((options) => options.timeoutMs !== undefined)).toBe(
      true,
    );
  });
});
