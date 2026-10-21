import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rollBackCreatedIosSimulator } from "../../../src/daemon/readiness/CreatedIosSimulatorRollback";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { BootedDevice } from "../../../src/models";
import { logger } from "../../../src/utils/logger";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeIOSCtrlProxyManager } from "../../fakes/FakeIOSCtrlProxyManager";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";

class RollbackSimctl extends FakeSimctl {
  shutdownMs = 45_000;
  deleteMs = 0;
  killTimeouts: Array<number | undefined> = [];
  deleteTimeouts: Array<number | undefined> = [];
  listingTimeouts: Array<number | undefined> = [];

  constructor(private readonly timer: FakeTimer) {
    super();
  }

  override async killSimulator(
    _device: BootedDevice,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    this.killTimeouts.push(options.timeoutMs);
    this.timer.advanceTime(this.shutdownMs);
  }

  override async deleteSimulator(
    _udid: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    this.deleteTimeouts.push(options.timeoutMs);
    this.timer.advanceTime(this.deleteMs);
  }

  override async listSimulatorImages(timeoutMs?: number) {
    this.listingTimeouts.push(timeoutMs);
    return super.listSimulatorImages();
  }
}

function harness() {
  const timer = new FakeTimer();
  timer.advanceTime(123_000);
  timer.enableAutoAdvance();
  const start = timer.now();
  const simctl = new RollbackSimctl(timer);
  const manager = new FakeIOSCtrlProxyManager(timer);
  const provider = new FakeDeviceClientProvider(
    new FakeAdbExecutor(),
    new FakeDeviceUtils(),
    simctl,
    { iosCtrlProxyManager: manager },
  );
  const created = { name: "Created iPhone", deviceId: "rollback-test-udid" };
  return {
    timer,
    start,
    simctl,
    manager,
    created,
    rollback: () =>
      rollBackCreatedIosSimulator(
        { simctl: () => simctl, provider, runnerReadinessTimer: timer },
        created,
        new Error("original readiness failure"),
      ),
  };
}

describe("created iOS simulator rollback deadline", () => {
  let retire: ReturnType<typeof spyOn<typeof IOSCtrlProxyClient, "retireInstance">>;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

  beforeEach(() => {
    retire = spyOn(IOSCtrlProxyClient, "retireInstance").mockResolvedValue(undefined);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    retire.mockRestore();
    warn.mockRestore();
  });

  test("delete receives only the budget remaining after shutdown", async () => {
    const h = harness();
    await h.rollback();
    expect(h.simctl.killTimeouts).toEqual([60_000]);
    expect(h.simctl.deleteTimeouts).toEqual([15_000]);
    expect(h.simctl.listingTimeouts).toEqual([10_000]);
  });

  test.each([0, 9_750])(
    "absence polling respects the shared deadline after %dms delete",
    async (deleteMs) => {
      const h = harness();
      h.simctl.deleteMs = deleteMs;
      h.simctl.setAvailableSimulators([
        { ...h.created, platform: "ios", isRunning: false, isAvailable: true, state: "Shutdown" },
      ]);
      await expect(h.rollback()).resolves.toBeUndefined();
      const absenceBudget = Math.min(10_000, 15_000 - deleteMs);
      expect(h.timer.now() - h.start).toBe(45_000 + deleteMs + absenceBudget);
      expect(h.simctl.listingTimeouts[0]).toBe(absenceBudget);
      expect(
        h.simctl.listingTimeouts.every(
          (timeout) => timeout !== undefined && timeout > 0 && timeout <= absenceBudget,
        ),
      ).toBe(true);
    },
  );

  test.each(["retire", "shutdown", "delete"] as const)(
    "budget exhausted during %s skips remaining steps",
    async (step) => {
      const h = harness();
      if (step === "retire") {
        retire.mockImplementation(async () => {
          h.timer.advanceTime(60_000);
        });
      } else if (step === "shutdown") {
        h.simctl.shutdownMs = 60_000;
      } else {
        h.simctl.deleteMs = 15_000;
      }
      await expect(h.rollback()).resolves.toBeUndefined();
      expect(h.simctl.killTimeouts).toHaveLength(step === "retire" ? 0 : 1);
      expect(h.simctl.deleteTimeouts).toHaveLength(step === "delete" ? 1 : 0);
      expect(h.simctl.listingTimeouts).toHaveLength(0);
      expect(
        warn.mock.calls.some(([message]) => String(message).includes("budget exhausted")),
      ).toBe(true);
    },
  );
});
