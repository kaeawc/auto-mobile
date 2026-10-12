import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerBoundedAcquisitionCleanup } from "../../src/utils/boundedAcquisitionCleanup";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";

class RecordingManager {
  readonly registered: Array<{ deviceId: string; cleanup: Promise<unknown>; capMs?: number }> = [];
  registerAcquisitionDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    capMs?: number,
  ): void {
    this.registered.push({ deviceId, cleanup, capMs });
  }
}

describe("registerBoundedAcquisitionCleanup", () => {
  let timer: FakeTimer;
  let manager: RecordingManager;
  let warn: ReturnType<typeof spyOn>;
  const capMs = 5_000;
  const deviceId = "device-a";
  const label = "persist adopted recording ownership for session holder";

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new RecordingManager();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    timer.reset();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("never-settling cleanup resolves exactly at the cap with one warning", async () => {
    registerBoundedAcquisitionCleanup(manager, deviceId, new Promise<void>(() => {}), {
      timer,
      capMs,
      label,
    });
    expect(manager.registered).toHaveLength(1);
    expect(manager.registered[0].deviceId).toBe(deviceId);
    expect(manager.registered[0].capMs).toBe(capMs);
    let settled = false;
    const done = manager.registered[0].cleanup.then(() => {
      settled = true;
    });
    timer.advanceTime(capMs - 1);
    await drainMicrotasks(10);
    expect(settled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    timer.advanceTime(1);
    await drainUntil(() => settled, { description: "bounded acquisition cleanup" });
    await expect(done).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = warn.mock.calls[0][0];
    expect(warning).toContain(label);
    expect(warning).toContain(deviceId);
    expect(warning).toContain(String(capMs));
    expect(warning).toContain("no longer held");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("early resolution resolves without warning and clears the deadline timer", async () => {
    let resolve!: () => void;
    const cleanup = new Promise<void>((done) => {
      resolve = done;
    });
    registerBoundedAcquisitionCleanup(manager, deviceId, cleanup, { timer, capMs, label });
    expect(timer.getPendingTimeoutCount()).toBe(1);
    resolve();
    await expect(manager.registered[0].cleanup).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("early rejection resolves with one warning carrying the error and clears the timer", async () => {
    const error = new Error("ownership write unavailable");
    registerBoundedAcquisitionCleanup(manager, deviceId, Promise.reject(error), {
      timer,
      capMs,
      label,
    });
    await expect(manager.registered[0].cleanup).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(error.message);
    expect(warn.mock.calls[0][1]).toBe(error);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
