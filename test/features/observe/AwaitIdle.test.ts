import { describe, expect, spyOn, test } from "bun:test";
import { AwaitIdle } from "../../../src/features/observe/AwaitIdle";
import { Idle, ROTATION_READ_FLOOR_MS } from "../../../src/features/observe/Idle";
import {
  WINDOW_MANAGER_ROTATION_COMMAND,
  WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
} from "../../../src/utils/android-cmdline-tools/readWindowManagerRotation";
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
    private readonly waitForTimeout = false,
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
      if (this.waitForTimeout) {
        await this.timer.sleep(timeoutMs ?? 0);
      } else {
        this.timer.advanceTime(timeoutMs ?? 0);
      }
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
        command: "shell dumpsys gfxinfo 'com.example.app' reset",
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

describe("AwaitIdle rotation polling", () => {
  test("gives every read the timeout floor and caller signal when the budget is smaller", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    adb.setCommandResponseSequence(WINDOW_MANAGER_ROTATION_COMMAND, [
      { stdout: "mRotation=0", stderr: "" },
      { stdout: "mRotation=1", stderr: "" },
    ]);

    await createAwaitIdle(adb, timer).waitForRotation(
      1,
      ROTATION_READ_FLOOR_MS / 10,
      controller.signal,
    );

    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual([1000, 1000]);
    expect(adb.getCommandCalls().map(({ signal }) => signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
  });

  test("uses the remaining budget when it exceeds the read timeout floor", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence(WINDOW_MANAGER_ROTATION_COMMAND, [
      { stdout: "mRotation=0", stderr: "" },
      { stdout: "mRotation=1", stderr: "" },
    ]);

    await createAwaitIdle(adb, timer).waitForRotation(1, 5000);

    expect(timer.now()).toBe(17);
    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual([5000, 4983]);
  });

  test("detects rotation appearing only in the final slot of the default budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence(WINDOW_MANAGER_ROTATION_COMMAND, [
      ...Array.from({ length: 30 }, () => ({ stdout: "mRotation=0", stderr: "" })),
      { stdout: "mRotation=1", stderr: "" },
    ]);

    await createAwaitIdle(adb, timer).waitForRotation(1);

    expect(adb.getCommandCalls()).toHaveLength(31);
    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual(
      Array.from({ length: 31 }, () => 1000),
    );
    expect(timer.getSleepHistory()).toEqual([...Array.from({ length: 29 }, () => 17), 7]);
    expect(timer.now()).toBe(500);
  });

  test("caps sleeps at the deadline and stops after exactly one final unsuccessful read", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, {
      stdout: "mRotation=0",
      stderr: "",
    });
    const awaitIdle = createAwaitIdle(adb, timer);
    const statusSpy = spyOn(Idle.prototype, "getRotationStatus");

    try {
      await expect(awaitIdle.waitForRotation(1, 40)).rejects.toThrow(
        "Timeout waiting for rotation to 1 after 40ms",
      );
      const statuses = await Promise.all(statusSpy.mock.results.map(({ value }) => value));
      expect(statuses.map(({ shouldContinue }) => shouldContinue)).toEqual([
        true,
        true,
        true,
        false,
      ]);
      expect(adb.getCommandCalls()).toHaveLength(4);
      expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual([
        1000, 1000, 1000, 1000,
      ]);
      expect(timer.getSleepHistory()).toEqual([17, 17, 6]);
      expect(timer.getSleepHistory().every((ms) => ms >= 0)).toBe(true);
      expect(timer.now()).toBe(40);
    } finally {
      statusSpy.mockRestore();
    }
  });

  test("never sleeps for a negative duration after a read consumes the budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new DeadlineAdbExecutor(timer, () => true);

    await expect(createAwaitIdle(adb, timer).waitForRotation(1, 5000)).rejects.toThrow(
      "Timeout waiting for rotation to 1 after 5000ms",
    );

    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual([5000, 5000]);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(timer.now()).toBe(10000);
  });

  test("rejects an abort without resolving the pending poll sleep", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, {
      stdout: "mRotation=0",
      stderr: "",
    });
    const controller = new AbortController();
    const pending = createAwaitIdle(adb, timer).waitForRotation(1, 100, controller.signal);
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    try {
      expect(timer.getPendingSleeps()).toEqual([17]);
      controller.abort(new Error("rotation cancelled during sleep"));
      const settled = await Promise.race([
        pending.catch((error: unknown) => error),
        (async () => {
          for (let i = 0; i < 20; i++) {
            await Promise.resolve();
          }
          return "still pending";
        })(),
      ]);
      expect(settled).toMatchObject({ message: "Operation cancelled" });
      expect(timer.getPendingSleeps()).toEqual([17]);
      expect(timer.now()).toBe(0);
      expect(adb.getCommandCalls()).toHaveLength(1);
    } finally {
      timer.resolveAll();
      await pending.catch(() => undefined);
    }
  });

  test("rejects an abort without waiting for a hanging rotation read to time out", async () => {
    const timer = new FakeTimer();
    const adb = new DeadlineAdbExecutor(timer, () => true, true);
    const controller = new AbortController();
    const pending = createAwaitIdle(adb, timer).waitForRotation(1, 100, controller.signal);
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    try {
      expect(timer.getPendingSleepCount()).toBe(1);
      controller.abort(new Error("rotation cancelled during read"));
      const settled = await Promise.race([
        pending.catch((error: unknown) => error),
        (async () => {
          for (let i = 0; i < 20; i++) {
            await Promise.resolve();
          }
          return "still pending";
        })(),
      ]);
      expect(settled).toMatchObject({ message: "Operation cancelled" });
      expect(timer.getPendingSleeps()).toEqual([ROTATION_READ_FLOOR_MS]);
      expect(timer.now()).toBe(0);
      expect(adb.getCommandCalls()).toHaveLength(1);
      expect(adb.getCommandCalls()[0]?.signal).toBe(controller.signal);
    } finally {
      timer.resolveAll();
      await pending.catch(() => undefined);
    }
  });

  test("a primary timeout attempts fallback with the same remaining-budget bound", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new DeadlineAdbExecutor(timer, () => true, true);

    await expect(createAwaitIdle(adb, timer).waitForRotation(1, 5000)).rejects.toThrow(
      "Timeout waiting for rotation to 1 after 5000ms",
    );

    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual([5000, 5000]);
    expect(timer.getSleepHistory()).toEqual([5000, 5000]);
    expect(timer.now()).toBe(10000);
    expect(timer.now()).toBeLessThanOrEqual(2 * 5000);
  });

  test("bounds the wedged final primary and fallback reads by the floor", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new DeadlineAdbExecutor(timer, () => timer.now() >= 100, true);
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, {
      stdout: "mRotation=0",
      stderr: "",
    });

    await expect(createAwaitIdle(adb, timer).waitForRotation(1, 100)).rejects.toThrow(
      "Timeout waiting for rotation to 1 after 100ms",
    );

    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual([
      1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000,
    ]);
    expect(timer.getSleepHistory()).toEqual([17, 17, 17, 17, 17, 15, 1000, 1000]);
    // Ordinary primary timeouts trigger fallback; each wedged command consumes the floor.
    expect(adb.getExecutedCommands().slice(-2)).toEqual([
      WINDOW_MANAGER_ROTATION_COMMAND,
      WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
    ]);
    expect(timer.now()).toBe(2100);
    expect(timer.now()).toBeLessThanOrEqual(100 + 2 * ROTATION_READ_FLOOR_MS);
  });

  test("stops after a wedged read starting just before the deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const readStarts: number[] = [];
    const adb = new DeadlineAdbExecutor(
      timer,
      () => {
        readStarts.push(timer.now());
        return timer.now() >= 493;
      },
      true,
    );
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, {
      stdout: "mRotation=0",
      stderr: "",
    });

    await expect(createAwaitIdle(adb, timer).waitForRotation(1, 500)).rejects.toThrow(
      "Timeout waiting for rotation to 1 after 500ms",
    );

    expect(timer.now()).toBe(2493);
    expect(timer.now()).toBeLessThanOrEqual(500 + 2 * ROTATION_READ_FLOOR_MS);
    expect(readStarts).toEqual([...Array.from({ length: 30 }, (_, index) => index * 17), 1493]);
    expect(adb.getCommandCalls()).toHaveLength(31);
    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual(
      Array.from({ length: 31 }, () => ROTATION_READ_FLOOR_MS),
    );
    expect(timer.getSleepHistory()).toEqual([
      ...Array.from({ length: 29 }, () => 17),
      ROTATION_READ_FLOOR_MS,
      ROTATION_READ_FLOOR_MS,
    ]);
  });

  test("passes the signal to a rotation read that cancels the wait", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const reason = new Error("rotation cancelled");
    const adb = new CancellingAdbExecutor(controller, reason);

    await expect(
      createAwaitIdle(adb, timer).waitForRotation(1, 100, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(adb.getCommandCalls()[0]?.signal).toBe(controller.signal);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("rejects an already-aborted rotation wait without starting a read", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    controller.abort(new Error("rotation cancelled"));

    await expect(
      createAwaitIdle(adb, timer).waitForRotation(1, 100, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(adb.getCommandCalls()).toEqual([]);
  });

  test("completes after the target rotation appears", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence(WINDOW_MANAGER_ROTATION_COMMAND, [
      { stdout: "mRotation=0", stderr: "" },
      { stdout: "mRotation=0", stderr: "" },
      { stdout: "mRotation=1", stderr: "" },
    ]);
    const awaitIdle = createAwaitIdle(adb, timer);

    await awaitIdle.waitForRotation(1, 100);

    expect(adb.getCommandCalls()).toHaveLength(3);
    expect(timer.now()).toBe(34);
  });

  test("throws when the rotation polling deadline expires", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, {
      stdout: "mRotation=0",
      stderr: "",
    });
    const awaitIdle = createAwaitIdle(adb, timer);

    await expect(awaitIdle.waitForRotation(1, 34)).rejects.toThrow(
      "Timeout waiting for rotation to 1 after 34ms",
    );
    expect(adb.getCommandCalls()).toHaveLength(3);
    expect(timer.now()).toBe(34);
  });
});
