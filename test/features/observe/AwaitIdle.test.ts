import { createExecResult } from "../../../src/utils/execResult";
import { describe, expect, spyOn, test } from "bun:test";
import { validGfxinfoOutput, noFrameGfxinfoOutput } from "./gfxinfoFixtures";
import {
  AwaitIdle,
  NO_FRAME_STATS_GRACE_MS,
  NO_FRAME_STATS_GRACE_POLLS,
} from "../../../src/features/observe/AwaitIdle";
import {
  Idle,
  ROTATION_READ_FLOOR_MS,
  ROTATION_WAIT_TIMEOUT_MS,
} from "../../../src/features/observe/Idle";
import { fixedBackoff } from "../../../src/utils/Backoff";
import {
  WINDOW_MANAGER_ROTATION_COMMAND,
  WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
} from "../../../src/utils/android-cmdline-tools/readWindowManagerRotation";
import type {
  AdbExecuteOptions,
  AdbExecutor,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
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

  override async executeCommand(command: string, options?: AdbExecuteOptions) {
    const { timeoutMs } = options ?? {};
    const result = await super.executeCommand(command, options);
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

  override async executeCommand(command: string, options?: AdbExecuteOptions) {
    const { signal } = options ?? {};
    const result = await super.executeCommand(command, options);
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

/** Fixed 17 ms rotation polling, so deadline mechanics tests can assert exact sleeps. */
function createFixedPollAwaitIdle(adb: AdbExecutor, timer: FakeTimer): AwaitIdle {
  return new AwaitIdle(device, { create: () => adb }, timer, {
    rotationPollBackoff: fixedBackoff(17),
  });
}

/** Reports window-manager rotation 1 only once the fake clock has reached `rotatesAtMs`. */
class SlowRotationAdbExecutor extends FakeAdbExecutor {
  constructor(
    private readonly timer: FakeTimer,
    private readonly rotatesAtMs: number,
  ) {
    super();
  }

  override async executeCommand(command: string, options?: AdbExecuteOptions) {
    const result = await super.executeCommand(command, options);
    if (command === WINDOW_MANAGER_ROTATION_COMMAND) {
      return createExecResult(`mRotation=${this.timer.now() >= this.rotatesAtMs ? 1 : 0}`, "");
    }
    return result;
  }
}

describe("AwaitIdle missing frame stats", () => {
  test("unavailable reads are neutral between no-frame polls", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const awaitIdle = createAwaitIdle(adb, timer);
    const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 8000);
    let reads = 0;
    const read = spyOn(adb, "executeCommand").mockImplementation(async () => {
      if (++reads % 2 === 0) {
        throw new Error("gfxinfo unavailable");
      }
      return createExecResult(noFrameGfxinfoOutput, "");
    });
    try {
      const metrics = await awaitIdle.waitForUiStabilityWithState("com.example.app", 8000, state);
      expect(metrics?.stabilityWaitMs).toBeLessThan(2000);
      expect(metrics).toHaveProperty("idleEndReason", "noFrameStats");
    } finally {
      read.mockRestore();
    }
  });

  test("valid final read clears noFrameStats and retains percentiles", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const awaitIdle = createAwaitIdle(adb, timer);
    const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 8000);
    // Switch only after the poll that triggers the early exit, on the final read.
    let graceRead = false;
    const read = spyOn(adb, "executeCommand").mockImplementation(async () => {
      const final = graceRead;
      if (timer.now() >= NO_FRAME_STATS_GRACE_MS) {
        graceRead = true;
      }
      return createExecResult(final ? validGfxinfoOutput : noFrameGfxinfoOutput, "");
    });
    try {
      const metrics = await awaitIdle.waitForUiStabilityWithState("com.example.app", 8000, state);
      expect(metrics?.isStable).toBe(false);
      expect(metrics?.stabilityWaitMs).toBeLessThan(2000);
      expect(metrics?.percentile95thMs).toBe(15.7);
      expect(metrics).not.toHaveProperty("idleEndReason");
    } finally {
      read.mockRestore();
    }
  });

  test("ends an 8000ms wait early after both the poll and elapsed grace", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys gfxinfo 'com.example.app' reset", createExecResult("", ""));
    adb.setCommandResponse(
      "dumpsys gfxinfo 'com.example.app'",
      createExecResult(noFrameGfxinfoOutput, ""),
    );
    const awaitIdle = createAwaitIdle(adb, timer);
    const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 8000);
    const metrics = await awaitIdle.waitForUiStabilityWithState("com.example.app", 8000, state);

    expect(metrics?.stabilityWaitMs).toBeGreaterThanOrEqual(NO_FRAME_STATS_GRACE_MS);
    expect(metrics?.stabilityWaitMs).toBeLessThan(2000);
    expect(timer.now()).toBeLessThan(2000);
    expect(metrics?.pollCount).toBeGreaterThan(NO_FRAME_STATS_GRACE_POLLS);
    expect(metrics?.isStable).toBe(false);
    expect(metrics).toHaveProperty("idleEndReason", "noFrameStats");
  });

  test("waits for frames arriving after 500ms without frame stats", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys gfxinfo 'com.example.app' reset", createExecResult("", ""));
    adb.setCommandResponseSequence("dumpsys gfxinfo 'com.example.app'", [
      ...Array.from({ length: 30 }, () => createExecResult(noFrameGfxinfoOutput, "")),
      createExecResult(validGfxinfoOutput, ""),
    ]);
    const awaitIdle = createAwaitIdle(adb, timer);
    const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 8000);
    const metrics = await awaitIdle.waitForUiStabilityWithState("com.example.app", 8000, state);

    expect(metrics?.pollCount).toBeGreaterThan(30);
    expect(metrics?.stabilityWaitMs).toBeGreaterThanOrEqual(500);
    expect(metrics?.stabilityWaitMs).toBeLessThan(NO_FRAME_STATS_GRACE_MS);
    expect(metrics?.isStable).toBe(true);
    expect(metrics).not.toHaveProperty("idleEndReason");
  });

  test("resets the consecutive counter when valid frame stats arrive", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const awaitIdle = createAwaitIdle(adb, timer);
    adb.setCommandResponse("dumpsys gfxinfo 'com.example.app' reset", createExecResult("", ""));
    const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 8000);
    // Neither run reaches ten polls; their combined length would trip an unreset counter.
    adb.setCommandResponseSequence("dumpsys gfxinfo 'com.example.app'", [
      ...Array.from({ length: 6 }, () => createExecResult(noFrameGfxinfoOutput, "")),
      createExecResult(validGfxinfoOutput, ""),
      ...Array.from({ length: 6 }, () => createExecResult(noFrameGfxinfoOutput, "")),
      createExecResult(validGfxinfoOutput, ""),
    ]);
    const metrics = await awaitIdle.waitForUiStabilityWithState("com.example.app", 8000, state);

    expect(metrics?.pollCount).toBeGreaterThan(14);
    expect(metrics?.isStable).toBe(true);
    expect(metrics).not.toHaveProperty("idleEndReason");
  });

  test("restarts the elapsed grace when valid frame stats interrupt a streak", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys gfxinfo 'com.example.app' reset", createExecResult("", ""));
    // Each streak lasts about 660ms; only their combined duration exceeds the grace.
    adb.setCommandResponseSequence("dumpsys gfxinfo 'com.example.app'", [
      ...Array.from({ length: 40 }, () => createExecResult(noFrameGfxinfoOutput, "")),
      createExecResult(validGfxinfoOutput, ""),
      ...Array.from({ length: 40 }, () => createExecResult(noFrameGfxinfoOutput, "")),
      createExecResult(validGfxinfoOutput, ""),
    ]);
    const awaitIdle = createAwaitIdle(adb, timer);
    const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 8000);
    const metrics = await awaitIdle.waitForUiStabilityWithState("com.example.app", 8000, state);

    expect(metrics?.pollCount).toBeGreaterThan(82);
    expect(metrics?.stabilityWaitMs).toBeGreaterThan(NO_FRAME_STATS_GRACE_MS);
    expect(metrics?.isStable).toBe(true);
    expect(metrics).not.toHaveProperty("idleEndReason");
  });
});

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
      awaitIdle.waitForUiStabilityWithState("com.example.app", 100, state, {
        signal: controller.signal,
      }),
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
      createExecResult("mRotation=0", ""),
      createExecResult("mRotation=1", ""),
    ]);

    await createFixedPollAwaitIdle(adb, timer).waitForRotation(
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
      createExecResult("mRotation=0", ""),
      createExecResult("mRotation=1", ""),
    ]);

    await createFixedPollAwaitIdle(adb, timer).waitForRotation(1, 5000);

    expect(timer.now()).toBe(17);
    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual([5000, 4983]);
  });

  test("the default budget is long enough for an emulator under load", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new SlowRotationAdbExecutor(timer, 3_000);

    await createAwaitIdle(adb, timer).waitForRotation(1);

    expect(ROTATION_WAIT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(timer.now()).toBeGreaterThanOrEqual(3_000);
    expect(timer.now()).toBeLessThan(3_000 + 500);
  });

  test("polls with a growing delay instead of hammering dumpsys every 17 ms", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new SlowRotationAdbExecutor(timer, 1_000);

    await createAwaitIdle(adb, timer).waitForRotation(1);

    const sleeps = timer.getSleepHistory();
    expect(sleeps.slice(0, 4)).toEqual([50, 100, 200, 400]);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(400);
    expect(sleeps.length).toBeLessThan(10);
  });

  test("times out after the default budget with the budget in the message", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new SlowRotationAdbExecutor(timer, Number.POSITIVE_INFINITY);

    await expect(createAwaitIdle(adb, timer).waitForRotation(1)).rejects.toThrow(
      `Timeout waiting for rotation to 1 after ${ROTATION_WAIT_TIMEOUT_MS}ms`,
    );
    expect(timer.now()).toBe(ROTATION_WAIT_TIMEOUT_MS);
  });

  test("caps sleeps at the deadline and stops after exactly one final unsuccessful read", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, createExecResult("mRotation=0", ""));
    const awaitIdle = createFixedPollAwaitIdle(adb, timer);
    const statuses: Awaited<ReturnType<Idle["getRotationStatus"]>>[] = [];
    const getRotationStatus = Idle.prototype.getRotationStatus;
    const statusSpy = spyOn(Idle.prototype, "getRotationStatus").mockImplementation(async function (
      this: Idle,
      ...args: Parameters<Idle["getRotationStatus"]>
    ) {
      const status = await getRotationStatus.apply(this, args);
      statuses.push(status);
      return status;
    });

    try {
      await expect(awaitIdle.waitForRotation(1, 40)).rejects.toThrow(
        "Timeout waiting for rotation to 1 after 40ms",
      );
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

    await expect(createFixedPollAwaitIdle(adb, timer).waitForRotation(1, 5000)).rejects.toThrow(
      "Timeout waiting for rotation to 1 after 5000ms",
    );

    expect(adb.getCommandCalls().map(({ timeoutMs }) => timeoutMs)).toEqual([5000, 5000]);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(timer.now()).toBe(10000);
  });

  test("rejects an abort without resolving the pending poll sleep", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, createExecResult("mRotation=0", ""));
    const controller = new AbortController();
    const pending = createFixedPollAwaitIdle(adb, timer).waitForRotation(1, 100, controller.signal);
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
    const pending = createFixedPollAwaitIdle(adb, timer).waitForRotation(1, 100, controller.signal);
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

    await expect(createFixedPollAwaitIdle(adb, timer).waitForRotation(1, 5000)).rejects.toThrow(
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
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, createExecResult("mRotation=0", ""));

    await expect(createFixedPollAwaitIdle(adb, timer).waitForRotation(1, 100)).rejects.toThrow(
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
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, createExecResult("mRotation=0", ""));

    await expect(createFixedPollAwaitIdle(adb, timer).waitForRotation(1, 500)).rejects.toThrow(
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
      createFixedPollAwaitIdle(adb, timer).waitForRotation(1, 100, controller.signal),
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
      createFixedPollAwaitIdle(adb, timer).waitForRotation(1, 100, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(adb.getCommandCalls()).toEqual([]);
  });

  test("completes after the target rotation appears", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence(WINDOW_MANAGER_ROTATION_COMMAND, [
      createExecResult("mRotation=0", ""),
      createExecResult("mRotation=0", ""),
      createExecResult("mRotation=1", ""),
    ]);
    const awaitIdle = createFixedPollAwaitIdle(adb, timer);

    await awaitIdle.waitForRotation(1, 100);

    expect(adb.getCommandCalls()).toHaveLength(3);
    expect(timer.now()).toBe(34);
  });

  test("throws when the rotation polling deadline expires", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, createExecResult("mRotation=0", ""));
    const awaitIdle = createFixedPollAwaitIdle(adb, timer);

    await expect(awaitIdle.waitForRotation(1, 34)).rejects.toThrow(
      "Timeout waiting for rotation to 1 after 34ms",
    );
    expect(adb.getCommandCalls()).toHaveLength(3);
    expect(timer.now()).toBe(34);
  });
});
