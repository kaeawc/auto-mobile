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
  } = {},
) {
  return waitForEmulatorShutdownWithEscalation({
    context: {
      deviceManager: manager,
      device,
      timer,
      deadlineMs: timer.now() + TOTAL_MS,
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

  test("with no emulator process left in the table the retryable shutdown timeout stands", async () => {
    stopper.outcome = { kind: "unidentified", identity: { kind: "absent" } };

    const error = await run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeviceShutdownTimeoutError);
    expect(error).not.toBeInstanceOf(EmulatorTeardownEscalationError);
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
