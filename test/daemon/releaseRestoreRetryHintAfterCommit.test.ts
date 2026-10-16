import { afterEach, expect, spyOn, test } from "bun:test";
import { SESSION_RELEASE_TEARDOWN_CAP_MS, SessionManager } from "../../src/daemon/sessionManager";
import { getAbortSignal } from "../../src/utils/AbortContext";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { defaultDeviceClockRestoreRegistry } from "../../src/features/utility/DeviceClock";

const deviceId = "emulator-5554";
const dispose: Array<() => void> = [];
const flush = () => drainMicrotasks(100);

afterEach(() => {
  for (const cleanup of dispose.splice(0).reverse()) {
    cleanup();
  }
});

test("keep-awake retries pending at commit advertise their remaining teardown cap", async () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let attempts = 0;
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
    keepScreenAwakeRestorer: () => ({
      restore: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("first restore failed");
        }
        await new Promise<void>((_resolve, reject) => {
          const signal = getAbortSignal();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });

        return { status: "restored" as const };
      },
    }),
  });
  dispose.push(() => {
    manager.stopCleanupTimer();
    timer.reset();
    warn.mockRestore();
  });
  await manager.createSession("owner", deviceId, "android");
  manager.setKeepScreenAwake("owner", { applied: true });
  const startedAt = timer.now();

  await manager.releaseSession("owner");
  await flush();
  const committedAt = timer.now();
  const hint = manager.getDeviceCleanupRetryAfterMs(deviceId);
  expect(manager.getSessionForDevice(deviceId)).toBeNull();
  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(true);
  expect(hint).toBe(SESSION_RELEASE_TEARDOWN_CAP_MS - (committedAt - startedAt));
  timer.advanceTime(250);
  await flush();
  expect(attempts).toBe(2);
  expect(manager.getDeviceCleanupRetryAfterMs(deviceId)).toBe(hint - 250);
  timer.advanceTime(hint - 251);
  await flush();
  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(true);
  timer.advanceTime(1);
  await flush();
  expect(timer.now()).toBe(committedAt + hint);
  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(false);
  expect(manager.getDeviceCleanupRetryAfterMs(deviceId)).toBe(1_000);
  expect(manager["deviceCleanupQuarantine"].boundCount(deviceId)).toBe(0);
});

test("only the capped cleanup contributes a bound while an own-budget clock retry stays pending", async () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const clockRetry = Promise.withResolvers<void>();
  let clockAttempts = 0;
  let clockSignal: AbortSignal | undefined;
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
    keepScreenAwakeRestorer: () => ({
      restore: async () => ({ status: "restored" as const }),
    }),
    biometricEnrollmentRestorer: () => ({ restore: async () => {} }),
    restorers: {
      networkCondition: () => ({
        restore: () =>
          new Promise<void>((_resolve, reject) => {
            const signal = getAbortSignal();
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      }),
      clock: () => ({
        restore: async (_state, signal) => {
          clockAttempts++;
          if (clockAttempts === 1) {
            throw new Error("first clock restore failed");
          }
          clockSignal = signal;
          await clockRetry.promise;
        },
      }),
    },
  });
  dispose.push(() => {
    clockRetry.resolve();
    manager.retireClockRestoration(deviceId);
    defaultDeviceClockRestoreRegistry.retire(deviceId);
    manager.stopCleanupTimer();
    timer.reset();
    warn.mockRestore();
  });
  const session = await manager.createSession("owner", deviceId, "android");
  manager.setNetworkCondition("owner", { initialProfile: "none" });
  manager.setClock(session, { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: false });
  const release = manager.releaseSession("owner");
  await flush();
  timer.advanceTime(1_000);
  await flush();
  await release;

  expect(manager.getSessionForDevice(deviceId)).toBeNull();
  expect(manager["deviceCleanupQuarantine"].workCount(deviceId)).toBe(2);
  expect(manager["deviceCleanupQuarantine"].boundCount(deviceId)).toBe(1);
  expect(manager.getDeviceCleanupRetryAfterMs(deviceId)).toBe(
    SESSION_RELEASE_TEARDOWN_CAP_MS - 1_000,
  );
  timer.advanceTime(250);
  await flush();
  expect(clockAttempts).toBe(2);
  timer.advanceTime(SESSION_RELEASE_TEARDOWN_CAP_MS - 1_250);
  await flush();

  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(true);
  expect(clockSignal).toBeDefined();
  expect(clockSignal?.aborted).toBe(false);
  expect(manager["deviceCleanupQuarantine"].workCount(deviceId)).toBe(1);
  expect(manager["deviceCleanupQuarantine"].boundCount(deviceId)).toBe(0);
  expect(manager.getDeviceCleanupRetryAfterMs(deviceId)).toBe(1_000);
  clockRetry.resolve();
  await flush();
  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(false);
});

test("a release with no pending restores leaves no cleanup bound or timer", async () => {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
    keepScreenAwakeRestorer: () => ({
      restore: async () => ({ status: "restored" as const }),
    }),
    biometricEnrollmentRestorer: () => ({ restore: async () => {} }),
    restorers: { networkCondition: () => ({ restore: async () => {} }) },
  });
  dispose.push(() => {
    manager.stopCleanupTimer();
    timer.reset();
  });
  await manager.createSession("owner", deviceId, "android");
  manager.setKeepScreenAwake("owner", { applied: true });
  manager.setBiometricEnrollment("owner", { initialEnrollment: "not_enrolled" });
  manager.setNetworkCondition("owner", { initialProfile: "none" });
  const cleanupIntervals = timer.getPendingIntervalCount();

  expect(await manager.releaseSession("owner")).toBe(deviceId);
  await flush();
  expect(manager.getSessionForDevice(deviceId)).toBeNull();
  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(false);
  expect(manager.getPendingDeviceCleanup(deviceId)).toBeNull();
  expect(manager["deviceCleanupQuarantine"].boundCount(deviceId)).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  expect(timer.getPendingSleepCount()).toBe(0);
  expect(timer.getPendingIntervalCount()).toBe(cleanupIntervals);
});

test("a bind refused while a released session's capped network restore is still pending is told the remaining cap, not 1 s", async () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  // A wedged emulator console: the restore settles only when the teardown shield aborts it.
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
    keepScreenAwakeRestorer: () => ({
      restore: async () => ({ status: "restored" as const }),
    }),
    biometricEnrollmentRestorer: () => ({ restore: async () => {} }),
    restorers: {
      networkCondition: () => ({
        restore: () =>
          new Promise<void>((_resolve, reject) => {
            const signal = getAbortSignal();
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      }),
    },
  });
  dispose.push(() => {
    manager.stopCleanupTimer();
    timer.reset();
    warn.mockRestore();
  });
  await manager.createSession("owner", deviceId, "android");
  manager.setNetworkCondition("owner", { initialProfile: "none" });

  const release = manager.releaseSession("owner");
  // The first restore attempt gets 1 s; the release then commits and hands the still-running
  // restore back as pending device cleanup, bounded by the 10 s teardown cap.
  await flush();
  timer.advanceTime(1_000);
  await flush();
  await release;

  expect(manager.getSessionForDevice(deviceId)).toBeNull();
  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(true);
  const hint = manager.getDeviceCleanupRetryAfterMs(deviceId);

  // The device does not leave quarantine within the default 1 s hint ...
  timer.advanceTime(1_000);
  await flush();
  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(true);
  expect(manager.getDeviceCleanupRetryAfterMs(deviceId)).toBe(
    SESSION_RELEASE_TEARDOWN_CAP_MS - 2_000,
  );
  // ... it leaves at the teardown cap, measured from the start of teardown.
  timer.advanceTime(SESSION_RELEASE_TEARDOWN_CAP_MS - 2_001);
  await flush();
  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(true);
  timer.advanceTime(1);
  await flush();
  expect(manager.hasDeviceCleanupInProgress(deviceId)).toBe(false);
  expect(manager.getDeviceCleanupRetryAfterMs(deviceId)).toBe(1_000);
  expect(manager["deviceCleanupQuarantine"].boundCount(deviceId)).toBe(0);

  // Contract (#11360 / #12105): `retryAfterMs` is a time the device actually leaves quarantine
  // within. 9 s of the cap remained when the hint was read.
  expect(hint).toBe(SESSION_RELEASE_TEARDOWN_CAP_MS - 1_000);
});
