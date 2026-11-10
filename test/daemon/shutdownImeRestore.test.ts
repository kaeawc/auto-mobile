import { describe, expect, spyOn, test } from "bun:test";
import { restorePendingImesForShutdown } from "../../src/daemon/shutdownImeRestore";
import type { PendingImeRestore } from "../../src/features/action/sendkeys/PendingImeRestore";
import { logger } from "../../src/utils/logger";
import { FakePendingImeRestoreRegistry } from "../fakes/FakePendingImeRestoreRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

function pending(restore: PendingImeRestore["restore"]): PendingImeRestore {
  return {
    snapshot: { prior: "keyboard/.Ime", wasEnabled: false, priorSubtype: { id: 7 } },
    userId: 0,
    restore,
  };
}

describe("restorePendingImesForShutdown (#17768)", () => {
  test("graceful shutdown restores every keyboard still pending", async () => {
    const registry = new FakePendingImeRestoreRegistry();
    const restored: string[] = [];
    registry.store(
      "emulator-5554",
      pending(async () => void restored.push("emulator-5554")),
    );
    registry.store(
      "emulator-5556",
      pending(async () => void restored.push("emulator-5556")),
    );
    const timer = new FakeTimer();

    await restorePendingImesForShutdown(timer, 1_000, registry);

    expect(restored.toSorted()).toEqual(["emulator-5554", "emulator-5556"]);
    expect(registry.entries.size).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a restore failure is logged and does not throw or stop the other restores", async () => {
    const registry = new FakePendingImeRestoreRegistry();
    const restored: string[] = [];
    registry.store(
      "emulator-5554",
      pending(async () => {
        throw new Error("ime set refused");
      }),
    );
    registry.store(
      "emulator-5556",
      pending(async () => void restored.push("emulator-5556")),
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await restorePendingImesForShutdown(new FakeTimer(), 1_000, registry);
      expect(restored).toEqual(["emulator-5556"]);
      expect(warn).toHaveBeenCalledWith(
        "[SendKeys] Shutdown IME restoration failed on emulator-5554",
        expect.objectContaining({ message: "ime set refused" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("the bound aborts a restore that is still running", async () => {
    const registry = new FakePendingImeRestoreRegistry();
    const timer = new FakeTimer();
    let fence: AbortSignal | undefined;
    registry.flush = async (_deviceId, options) => {
      fence = options?.signal;
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve()),
      );
    };
    registry.store(
      "emulator-5554",
      pending(async () => {}),
    );

    const done = restorePendingImesForShutdown(timer, 1_000, registry);
    await Promise.resolve();
    expect(fence?.aborted).toBe(false);
    timer.advanceTime(1_000);
    await done;
    expect(fence?.aborted).toBe(true);
  });

  test("does nothing and arms no timer when no keyboard is pending", async () => {
    const registry = new FakePendingImeRestoreRegistry();
    const timer = new FakeTimer();
    await restorePendingImesForShutdown(timer, 1_000, registry);
    expect(registry.flushes).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
