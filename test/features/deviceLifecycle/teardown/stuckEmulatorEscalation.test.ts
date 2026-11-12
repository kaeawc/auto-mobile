/**
 * #14018: a soft `adb emu kill` the console acknowledges but the guest never honors must not be
 * retried forever. The soft kill is bounded by a budget, then escalates to a SIGTERM->SIGKILL of
 * the process-table-identified emulator (by pid), verifies the device left discovery, and returns
 * a typed failure when it cannot be stopped.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  EmulatorTeardownEscalationError,
  STUCK_EMULATOR_MAX_SOFT_ATTEMPTS,
  waitForEmulatorShutdownWithEscalation,
} from "../../../../src/features/deviceLifecycle/teardown/stuckEmulatorEscalation";
import { isEmulatorStopDispatchedError } from "../../../../src/utils/android-cmdline-tools/EmulatorProcessStop";
import type { BackoffPolicy } from "../../../../src/utils/Backoff";
import type { BootedDevice } from "../../../../src/models";
import { DeviceShutdownTimeoutError } from "../../../../src/models/DeviceShutdownTimeoutError";
import { FakeDeviceUtils } from "../../../fakes/FakeDeviceUtils";
import { FakeEmulatorProcessStopper } from "../../../fakes/FakeEmulatorProcessStopper";
import { FakeTimer } from "../../../fakes/FakeTimer";

const device: BootedDevice = { name: "Pixel_8", platform: "android", deviceId: "emulator-5554" };
const TOTAL_MS = 30_000;

class RecordingBackoff implements BackoffPolicy {
  readonly attempts: number[] = [];
  delayForAttempt(attempt: number): number {
    this.attempts.push(attempt);
    return 500 * attempt;
  }
}

let timer: FakeTimer;
let manager: FakeDeviceUtils;
let stopper: FakeEmulatorProcessStopper;
let backoff: RecordingBackoff;
let softKills: number;
let stopTimes: number[];
let softKillTimes: number[];

const emulatorGone = () => manager.setBootedDevices("android", []);

beforeEach(() => {
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  manager = new FakeDeviceUtils();
  manager.setBootedDevices("android", [device]);
  stopper = new FakeEmulatorProcessStopper();
  backoff = new RecordingBackoff();
  softKills = 0;
  softKillTimes = [];
  stopTimes = [];
  stopper.onStop = () => stopTimes.push(timer.now());
});

function run(
  overrides: {
    avdName?: string | undefined;
    redispatchSoftKill?: () => Promise<void>;
    requestAbortSignal?: AbortSignal;
    remainingMs?: number;
  } = {},
) {
  return waitForEmulatorShutdownWithEscalation({
    context: {
      deviceManager: manager,
      device,
      timer,
      deadlineMs: timer.now() + (overrides.remainingMs ?? TOTAL_MS),
      requestAbortSignal: overrides.requestAbortSignal,
      timeoutMs: TOTAL_MS,
    },
    skipAndroidNameEnrichment: false,
    stopper,
    avdName: "avdName" in overrides ? overrides.avdName : "Pixel_8",
    backoff,
    redispatchSoftKill:
      overrides.redispatchSoftKill ??
      (async () => {
        softKills++;
        softKillTimes.push(timer.now());
      }),
  });
}

describe("waitForEmulatorShutdownWithEscalation", () => {
  test("a device already gone is confirmed without a re-kill or signal", async () => {
    emulatorGone();
    await expect(run()).resolves.toBeUndefined();
    expect(softKills).toBe(0);
    expect(stopper.stopCalls).toEqual([]);
  });

  test("a soft re-kill that finally takes effect is confirmed without escalating", async () => {
    await expect(
      run({
        redispatchSoftKill: async () => {
          softKills++;
          emulatorGone();
        },
      }),
    ).resolves.toBeUndefined();
    expect(softKills).toBe(1);
    expect(backoff.attempts).toEqual([1]);
    expect(stopper.stopCalls).toEqual([]);
  });

  test("an unresponsive guest gets a bounded number of soft kills, then a pid-level stop", async () => {
    stopper.outcome = { kind: "stopped", pid: 4242, signal: "SIGKILL" };
    stopper.onStop = () => {
      stopTimes.push(timer.now());
      emulatorGone();
    };
    const started = timer.now();

    await expect(run()).resolves.toBeUndefined();

    // The caller already sent the first soft kill; the budget covers the re-sends.
    expect(softKills).toBe(STUCK_EMULATOR_MAX_SOFT_ATTEMPTS - 1);
    expect(backoff.attempts).toEqual(
      Array.from({ length: STUCK_EMULATOR_MAX_SOFT_ATTEMPTS - 1 }, (_, i) => i + 1),
    );
    expect(stopper.stopCalls).toHaveLength(1);
    const [target, options] = stopper.stopCalls[0]!;
    expect(target).toEqual({ serial: "emulator-5554", avdName: "Pixel_8" });
    expect(options.deadlineMs).toBe(started + TOTAL_MS);
    // Escalation happens only after the soft budget, and leaves the stopper its grace time.
    expect(stopTimes[0]! - started).toBeGreaterThanOrEqual(TOTAL_MS / 3 - 1_000);
    expect(options.deadlineMs - stopTimes[0]!).toBeGreaterThanOrEqual(TOTAL_MS / 3);
    expect(softKillTimes.every((at) => at <= stopTimes[0]!)).toBe(true);
  });

  test("a failing soft re-kill does not stop the budget from running out into escalation", async () => {
    stopper.outcome = { kind: "stopped", pid: 4242, signal: "SIGTERM" };
    stopper.onStop = emulatorGone;
    let attempts = 0;
    await expect(
      run({
        redispatchSoftKill: async () => {
          attempts++;
          throw new Error("console refused");
        },
      }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(STUCK_EMULATOR_MAX_SOFT_ATTEMPTS - 1);
    expect(stopper.stopCalls).toHaveLength(1);
  });

  test("a stopper that reports the pid still running yields a typed failure carrying the evidence", async () => {
    stopper.outcome = {
      kind: "still-running",
      pid: 4242,
      command: "qemu-system-aarch64 -avd Pixel_8 -port 5554",
      signalled: true,
    };

    const error = await run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmulatorTeardownEscalationError);
    const failure = error as EmulatorTeardownEscalationError;
    expect(failure.reason).toBe("still-running");
    expect(failure.pid).toBe(4242);
    expect(failure.serial).toBe("emulator-5554");
    expect(failure.softAttempts).toBe(STUCK_EMULATOR_MAX_SOFT_ATTEMPTS);
    expect(failure.code).toBe("emulator_teardown_failed");
    expect(failure.retryable).toBe(false);
    // A stop was dispatched, so a late exit must stay intentional.
    expect(isEmulatorStopDispatchedError(failure)).toBe(true);
    expect(failure.message).toContain("4242");
  });

  test("a stop that succeeded but leaves the serial in discovery is not a confirmed stop", async () => {
    stopper.outcome = { kind: "stopped", pid: 4242, signal: "SIGKILL" };

    const error = (await run().catch((e: unknown) => e)) as EmulatorTeardownEscalationError;

    expect(error).toBeInstanceOf(EmulatorTeardownEscalationError);
    expect(error.reason).toBe("still-listed");
    expect(error.pid).toBe(4242);
  });

  test("an identity mismatch is refused, never signalled around", async () => {
    stopper.outcome = { kind: "identity-mismatch", pid: 77, runningAvdName: "Other_AVD" };

    const error = (await run().catch((e: unknown) => e)) as EmulatorTeardownEscalationError;

    expect(error).toBeInstanceOf(EmulatorTeardownEscalationError);
    expect(error.reason).toBe("identity-mismatch");
    expect(error.message).toContain("Other_AVD");
    expect(stopper.stopCalls).toHaveLength(1);
  });

  test("an ambiguous process table is a typed failure rather than a guess", async () => {
    stopper.outcome = {
      kind: "unidentified",
      identity: {
        kind: "ambiguous",
        candidates: [
          { pid: 1001, command: "qemu-system-aarch64 -avd A -port 5554" },
          { pid: 1002, command: "qemu-system-aarch64 -avd B -port 5554" },
        ],
      },
    };

    const error = (await run().catch((e: unknown) => e)) as EmulatorTeardownEscalationError;

    expect(error).toBeInstanceOf(EmulatorTeardownEscalationError);
    expect(error.reason).toBe("unidentified");
  });

  test("an emulator whose process already exited is confirmed once adb drops the serial", async () => {
    // #17957: a re-kill's own stop made the emulator exit, so the escalation found no process,
    // and adb dropped the serial about 3 s later. That is a successful kill, not a timeout.
    stopper.outcome = { kind: "unidentified", identity: { kind: "absent" } };
    stopper.onStop = () => {
      stopTimes.push(timer.now());
      timer.setTimeout(emulatorGone, 3_000);
    };

    await expect(run()).resolves.toBeUndefined();
    expect(stopper.stopCalls).toHaveLength(1);
  });

  test("with no emulator process left but the serial still listed, the retryable timeout quotes the real wait", async () => {
    stopper.outcome = { kind: "unidentified", identity: { kind: "absent" } };
    const started = timer.now();

    // Part of the 30 s shutdown budget was already spent before the disappearance wait began.
    const error = await run({ remainingMs: 12_000 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeviceShutdownTimeoutError);
    expect(error).not.toBeInstanceOf(EmulatorTeardownEscalationError);
    // It waited out the whole remaining budget, not just the soft-kill windows...
    expect(timer.now() - started).toBeGreaterThanOrEqual(12_000);
    // ...and says how long it waited, not the unrelated 30000ms total budget.
    const message = (error as Error).message;
    expect(message).toContain("after 12000ms");
    expect(message).not.toContain(`${TOTAL_MS}ms`);
  });

  test("an exited emulator is confirmed by one final poll when the stopper used up the deadline", async () => {
    // #17957 review: the process-table read itself ran past the deadline, and by then adb had
    // dropped the serial. One bounded discovery must confirm it rather than report a timeout.
    stopper.outcome = { kind: "unidentified", identity: { kind: "absent" } };
    stopper.onStop = () => {
      timer.advanceTime(TOTAL_MS);
      emulatorGone();
    };

    await expect(run()).resolves.toBeUndefined();
    expect(stopper.stopCalls).toHaveLength(1);
  });

  test("past the deadline with the serial still listed, the final poll's timeout quotes the total wait", async () => {
    stopper.outcome = { kind: "unidentified", identity: { kind: "absent" } };
    const started = timer.now();
    let pastDeadlineAt = 0;
    stopper.onStop = () => {
      timer.advanceTime(TOTAL_MS);
      pastDeadlineAt = timer.now();
    };

    const error = await run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeviceShutdownTimeoutError);
    expect(error).not.toBeInstanceOf(EmulatorTeardownEscalationError);
    const elapsed = timer.now() - started;
    expect(elapsed).toBeGreaterThan(TOTAL_MS);
    // One bounded poll, not a fresh polling window past the deadline.
    expect(timer.now() - pastDeadlineAt).toBeLessThan(2_000);
    const message = (error as Error).message;
    expect(message).toContain(`after ${elapsed}ms`);
    expect(message).toContain("still reported as booted");
  });

  test("past the deadline with discovery wedged, it reports the total wait without another read", async () => {
    let discoveryReads = 0;
    manager.getBootedDevicesDetailed = () => {
      discoveryReads++;
      return new Promise(() => {});
    };
    stopper.outcome = { kind: "unidentified", identity: { kind: "absent" } };
    const started = timer.now();
    let readsAtStop = 0;
    stopper.onStop = () => {
      timer.advanceTime(TOTAL_MS);
      readsAtStop = discoveryReads;
    };

    const error = await run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeviceShutdownTimeoutError);
    expect(discoveryReads).toBe(readsAtStop);
    const message = (error as Error).message;
    expect(message).toContain(`after ${timer.now() - started}ms`);
    expect(message).toContain("platform discovery did not complete");
  });

  test("without an AVD name there is no identity to signal, so it fails typed without a stop call", async () => {
    const error = (await run({ avdName: undefined }).catch(
      (e: unknown) => e,
    )) as EmulatorTeardownEscalationError;

    expect(error).toBeInstanceOf(EmulatorTeardownEscalationError);
    expect(error.reason).toBe("no-identity");
    expect(stopper.stopCalls).toEqual([]);
  });

  test("caller cancellation propagates instead of escalating", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(run({ requestAbortSignal: controller.signal })).rejects.toThrow();
    expect(stopper.stopCalls).toEqual([]);
  });
});
