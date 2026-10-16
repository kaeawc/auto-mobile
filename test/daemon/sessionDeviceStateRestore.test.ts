import { expect, spyOn, test } from "bun:test";
import {
  SessionDeviceStateRestore,
  type SessionDeviceStateRestoreHost,
} from "../../src/daemon/sessionDeviceStateRestore";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BackoffPolicy } from "../../src/utils/Backoff";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const flush = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

async function create(restoreResult: (call: number) => Promise<void>) {
  const timer = new FakeTimer();
  const calls: Array<{ deviceId: string; previousEnabled: boolean }> = [];
  const tracked: string[] = [];
  const host: SessionDeviceStateRestoreHost = {
    timer,
    dispatchDeviceRestore: (_deviceId, restore) => {
      const controller = new AbortController();
      return restore(controller.signal, controller.signal, () => {});
    },
    restoreGeneration: () => 0,
    hasIdentityReplacementFence: () => false,
    trackSessionSetup: (_session, createSetup) => createSetup(),
    isPublished: () => true,
    trackPendingDeviceCleanup: (deviceId) => tracked.push(deviceId),
  };
  const backoff: BackoffPolicy = { delayForAttempt: () => 5 };
  const restore = new SessionDeviceStateRestore(host, {
    screenReader: (device) => ({
      restore: (state) => {
        calls.push({ deviceId: device.deviceId, previousEnabled: state.previousEnabled });
        return restoreResult(calls.length);
      },
    }),
    screenReaderBackoff: backoff,
  });
  // A real Session (from a manager used only as a factory) keeps the fixture typed.
  const factory = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  factory.stopCleanupTimer();
  const session = await factory.createSession("s1", "emulator-5554", "android");
  factory.setScreenReader(session, { platform: "android", previousEnabled: false });
  return { timer, restore, calls, tracked, session };
}

test("a successful screen-reader restore clears the slot and leaves no pending work", async () => {
  const h = await create(async () => {});
  const { pending } = await h.restore.getPendingScreenReaderRestoration(h.session, null);
  expect(pending).toBeNull();
  expect(h.calls).toEqual([{ deviceId: "emulator-5554", previousEnabled: false }]);
  expect(h.session.cacheData.screenReader).toBeUndefined();
  expect(h.restore.screenReaderRestores.targets.size).toBe(0);
});

test("a concurrent ask for the same baseline joins the one restore", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await create(() => gate.promise);
  const first = h.restore.getPendingScreenReaderRestoration(h.session, null);
  const second = h.restore.getPendingScreenReaderRestoration(h.session, null);
  await flush();
  expect(h.calls).toHaveLength(1);
  gate.resolve();
  expect((await first).pending).toBeNull();
  expect((await second).pending).toBeNull();
});

test("a failing screen-reader restore retries twice, then abandons and remembers the state", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const h = await create(() => Promise.reject(new Error("toggle failed")));
    const { pending } = await h.restore.getPendingScreenReaderRestoration(h.session, null);
    expect(pending).not.toBeNull();
    for (let i = 0; i < 2; i++) {
      await flush();
      h.timer.advanceTime(5);
    }
    await pending;
    expect(h.calls).toHaveLength(3);
    expect(h.restore.abandonedScreenReaders.get("emulator-5554")).toEqual({
      platform: "android",
      previousEnabled: false,
    });
    expect(h.session.cacheData.screenReader).toBeUndefined();
    expect(h.restore.screenReaderRestores.targets.size).toBe(0);
  } finally {
    warn.mockRestore();
  }
});

test("retiring a device forgets its abandoned screen-reader state and bumps the generation", async () => {
  const h = await create(async () => {});
  h.restore.abandonedScreenReaders.set("emulator-5554", {
    platform: "android",
    previousEnabled: true,
  });
  h.restore.retireScreenReaderRestoration("emulator-5554");
  expect(h.restore.abandonedScreenReaders.has("emulator-5554")).toBe(false);
  expect(h.restore.screenReaderRestores.generation("emulator-5554")).toBe(1);
});
