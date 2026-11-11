import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { resolveAcquiredProcessId } from "../../src/server/deviceToolsAcquisitionMetadata";
import type { DeviceBootResult } from "../../src/devices/deviceBootSelection";
import { logger } from "../../src/utils/logger";
import { FakeEmulatorProcessStopper } from "../fakes/FakeEmulatorProcessStopper";
import { FakeTimer } from "../fakes/FakeTimer";

const boot: DeviceBootResult = {
  device: { platform: "android", deviceId: "emulator-5558", name: "lane17951-api35" },
  source: "booted",
  provisioned: false,
};

describe("acquired emulator process lookup budget", () => {
  let info: Mock<typeof logger.info>;
  let warn: Mock<typeof logger.warn>;

  beforeEach(() => {
    info = spyOn(logger, "info").mockImplementation(() => {});
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
  });

  test.each([0, 25, 50, 249, 250])(
    "skips optional metadata with only %s ms remaining",
    async (remainingMs) => {
      const timer = new FakeTimer();
      const stopper = new FakeEmulatorProcessStopper();
      const result = await resolveAcquiredProcessId(
        boot,
        boot.device.name,
        { timer, androidEmulatorProcessStopper: stopper },
        { deadlineMs: timer.now() + remainingMs },
      );

      expect(result).toBeUndefined();
      expect(stopper.identifyCalls).toEqual([]);
      expect(timer.getPendingTimeouts()).toEqual([]);
      expect(timer.getSleepHistory()).toEqual([]);
    },
  );

  test.each([
    { remainingMs: 10_000, expectedBudgetMs: 5_000 },
    { remainingMs: 1_000, expectedBudgetMs: 750 },
  ])(
    "times out after $expectedBudgetMs ms with $remainingMs ms remaining",
    async ({ remainingMs, expectedBudgetMs }) => {
      const timer = new FakeTimer();
      const stopper = new FakeEmulatorProcessStopper();
      // Ignore cancellation to prove the caller bounds even a stuck implementation.
      const identify = spyOn(stopper, "identify").mockImplementation(
        () => new Promise<never>(() => {}),
      );
      timer.advanceTime(100);
      const deadlineMs = timer.now() + remainingMs;
      const lookup = resolveAcquiredProcessId(
        boot,
        boot.device.name,
        { timer, androidEmulatorProcessStopper: stopper },
        { deadlineMs },
      );

      const options = identify.mock.calls[0][1];
      expect(options.deadlineMs).toBe(Math.min(100 + 5_000, deadlineMs - 250));
      timer.advanceTime(expectedBudgetMs - 1);
      expect(options.signal?.aborted).toBe(false);
      expect(info).not.toHaveBeenCalled();
      expect(timer.getPendingTimeouts()).toHaveLength(1);
      timer.advanceTime(1);

      expect(await lookup).toBeUndefined();
      expect(options.signal?.aborted).toBe(true);
      expect(timer.now()).toBe(100 + expectedBudgetMs);
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        `[DeviceTools] Could not identify the host process for ${boot.device.deviceId}: Acquired emulator process identification timed out after ${expectedBudgetMs}ms`,
      );
      expect(warn).not.toHaveBeenCalled();
      expect(timer.getPendingTimeouts()).toEqual([]);
      expect(timer.getSleepHistory()).toEqual([]);
    },
  );

  test("returns the pid after a slow process-table read", async () => {
    const timer = new FakeTimer();
    const stopper = new FakeEmulatorProcessStopper();
    const identify = spyOn(stopper, "identify").mockImplementation(async () => {
      await timer.sleep(1_200);
      return { kind: "match", pid: 39314, avdName: boot.device.name, port: 5558, command: "qemu" };
    });
    const lookup = resolveAcquiredProcessId(
      boot,
      boot.device.name,
      { timer, androidEmulatorProcessStopper: stopper },
      { deadlineMs: 10_000 },
    );

    timer.advanceTime(1_200);

    expect(await lookup).toBe(39314);
    expect(timer.now()).toBe(1_200);
    expect(identify.mock.calls[0][1].signal?.aborted).toBe(false);
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([1_200]);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns and omits metadata when identification throws", async () => {
    const timer = new FakeTimer();
    const stopper = new FakeEmulatorProcessStopper();
    // Identical text must not cause an ordinary error to be classified as our timeout.
    const error = new Error("Acquired emulator process identification timed out after 5000ms");
    spyOn(stopper, "identify").mockImplementation(() => {
      throw error;
    });

    const result = await resolveAcquiredProcessId(
      boot,
      boot.device.name,
      { timer, androidEmulatorProcessStopper: stopper },
      { deadlineMs: 10_000 },
    );

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[DeviceTools] Could not identify the host process for ${boot.device.deviceId}: ${error.message}`,
      error,
    );
    expect(info).not.toHaveBeenCalled();
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("skips identification when the request is already cancelled", async () => {
    const timer = new FakeTimer();
    const stopper = new FakeEmulatorProcessStopper();
    const controller = new AbortController();
    controller.abort();
    const result = await resolveAcquiredProcessId(
      boot,
      boot.device.name,
      { timer, androidEmulatorProcessStopper: stopper },
      { deadlineMs: 1_000, signal: controller.signal },
    );

    expect(result).toBeUndefined();
    expect(stopper.identifyCalls).toEqual([]);
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
});
