import { describe, expect, test } from "bun:test";
import { AwaitIdle } from "../../../src/features/observe/AwaitIdle";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const device = {
  name: "Pixel",
  platform: "android" as const,
  deviceId: "emulator-5554",
};

class DeadlineAdbExecutor extends FakeAdbExecutor {
  constructor(
    private readonly timer: FakeTimer,
    private readonly consumeBudgetFor: (command: string) => boolean,
  ) {
    super();
  }

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
    waitForProcessSettlementAfterAbort?: boolean,
  ) {
    const result = await super.executeCommand(
      command,
      timeoutMs,
      maxBuffer,
      noRetry,
      signal,
      waitForProcessSettlementAfterAbort,
    );
    if (this.consumeBudgetFor(command)) {
      this.timer.advanceTime(timeoutMs ?? 0);
      throw new Error("ADB command timed out");
    }
    return result;
  }
}

class CancellingAdbExecutor extends FakeAdbExecutor {
  constructor(
    private readonly controller: AbortController,
    private readonly reason: Error,
    private readonly cancelFor: (command: string) => boolean = () => true,
  ) {
    super();
  }

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
    waitForProcessSettlementAfterAbort?: boolean,
  ) {
    const result = await super.executeCommand(
      command,
      timeoutMs,
      maxBuffer,
      noRetry,
      signal,
      waitForProcessSettlementAfterAbort,
    );
    if (this.cancelFor(command)) {
      this.controller.abort(this.reason);
      signal?.throwIfAborted();
    }
    return result;
  }
}

function createAwaitIdle(adb: AdbExecutor, timer: FakeTimer): AwaitIdle {
  return new AwaitIdle(device, { create: () => adb }, timer);
}

describe("AwaitIdle UI stability deadline", () => {
  test("bounds initialization and skips later samples after its budget expires", async () => {
    const timer = new FakeTimer();
    const adb = new DeadlineAdbExecutor(timer, () => true);
    const awaitIdle = createAwaitIdle(adb, timer);

    const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 100);
    const metrics = await awaitIdle.waitForUiStabilityWithState("com.example.app", 100, state);

    expect(timer.now()).toBe(100);
    expect(metrics?.pollCount).toBe(0);
    expect(metrics?.isStable).toBe(false);
    expect(adb.getCommandCalls()).toEqual([
      expect.objectContaining({
        command: "shell dumpsys gfxinfo com.example.app reset",
        timeoutMs: 100,
      }),
    ]);
  });

  test("shrinks a poll command timeout against the initialization deadline", async () => {
    const timer = new FakeTimer();
    const adb = new DeadlineAdbExecutor(timer, (command) => !command.endsWith(" reset"));
    const awaitIdle = createAwaitIdle(adb, timer);
    const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 100);
    timer.advanceTime(25);

    const metrics = await awaitIdle.waitForUiStabilityWithState("com.example.app", 100, state);

    expect(timer.now()).toBe(100);
    expect(metrics?.pollCount).toBe(1);
    expect(metrics?.isStable).toBe(false);
    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual([100, 75]);
  });

  test("preserves caller cancellation during initialization", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const reason = new Error("manual launch cancelled");
    const adb = new CancellingAdbExecutor(controller, reason);
    const awaitIdle = createAwaitIdle(adb, timer);

    await expect(
      awaitIdle.initializeUiStabilityTracking("com.example.app", 100, controller.signal),
    ).rejects.toBe(reason);
  });

  test("preserves cancellation during a poll and does not start a final sample", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const reason = new Error("device lease lost");
    const adb = new CancellingAdbExecutor(
      controller,
      reason,
      (command) => !command.endsWith(" reset"),
    );
    const awaitIdle = createAwaitIdle(adb, timer);
    const state = await awaitIdle.initializeUiStabilityTracking(
      "com.example.app",
      100,
      controller.signal,
    );

    await expect(
      awaitIdle.waitForUiStabilityWithState(
        "com.example.app",
        100,
        state,
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(adb.getCommandCalls()).toHaveLength(2);
  });
});
