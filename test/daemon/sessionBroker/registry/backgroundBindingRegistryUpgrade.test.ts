import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BackgroundBindingRegistryUpgrade } from "../../../../src/daemon/sessionBroker/registry/BackgroundBindingRegistryUpgrade";
import {
  LegacySlotDeviceRetirement,
  type LegacySlotRetirementStore,
  type LegacySlotSnapshot,
  type LegacySlotDeviceStopper,
} from "../../../../src/daemon/sessionBroker/registry/legacySlotDeviceRetirement";
import type { DeviceInfo } from "../../../../src/models/DeviceInfo";
import { logger } from "../../../../src/utils/logger";
import { fixedBackoff, sequenceBackoff } from "../../../../src/utils/Backoff";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainMicrotasks } from "../../../helpers/fakeTimerStepping";

class FakeStore implements LegacySlotRetirementStore {
  transactionOpen = false;
  removed = false;
  async withLegacyRows(
    operation: (snapshot: LegacySlotSnapshot, remove: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    await operation(
      { devices: [{ platform: "android", stableId: null, name: "amslot-old" }], owners: [] },
      async () => {
        this.transactionOpen = true;
        this.removed = true;
        this.transactionOpen = false;
      },
    );
  }
}

class FakeStopper implements LegacySlotDeviceStopper {
  readonly discovered = Promise.withResolvers<DeviceInfo | undefined>();
  inspections = 0;
  stops = 0;
  signal: AbortSignal | undefined;
  constructor(private readonly store: FakeStore) {}
  async inspect(_target: unknown, signal: AbortSignal): Promise<DeviceInfo | undefined> {
    expect(this.store.transactionOpen).toBe(false);
    this.signal = signal;
    this.inspections++;
    return this.stops === 0 ? this.discovered.promise : undefined;
  }
  async stop(): Promise<void> {
    expect(this.store.transactionOpen).toBe(false);
    this.stops++;
  }
}

function harness() {
  const timer = new FakeTimer();
  const store = new FakeStore();
  const devices = new FakeStopper(store);
  let opens = 0;
  const upgrade = new BackgroundBindingRegistryUpgrade(
    async (signal) => {
      opens++;
      await new LegacySlotDeviceRetirement({
        timer,
        devices,
        signal,
        isOwnerLive: () => false,
      }).retire(store);
    },
    { timer },
  );
  return { timer, store, devices, upgrade, opens: () => opens };
}

const running: DeviceInfo = {
  platform: "android",
  name: "amslot-old",
  deviceId: "emulator-5554",
  isRunning: true,
};

describe("background registry upgrade", () => {
  test("start returns immediately, shares one flight, and native work never holds a transaction", async () => {
    const { timer, store, devices, upgrade, opens } = harness();
    upgrade.start();
    upgrade.start();
    expect(opens()).toBe(1);
    expect(store.removed).toBe(false);
    devices.discovered.resolve(running);
    // Joining after successful retirement must not abort the native work early.
    for (let i = 0; i < 20 && !store.removed; i++) {
      await Promise.resolve();
    }
    expect(store.removed).toBe(true);
    expect(devices.stops).toBe(1);
    await upgrade.close();
    upgrade.start();
    expect(opens()).toBe(1);
    timer.reset();
  });

  test.each(["timeout", "shutdown"])(
    "%s aborts and joins; a late result cannot stop or delete",
    async (reason) => {
      const { timer, store, devices, upgrade } = harness();
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        upgrade.start();
        if (reason === "timeout") {
          timer.advanceTime(30_000);
        }
        await upgrade.close();
        expect(devices.signal?.aborted).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
        devices.discovered.resolve(running);
        await Promise.resolve();
        await Promise.resolve();
        expect(devices.stops).toBe(0);
        expect(store.removed).toBe(false);
      } finally {
        warn.mockRestore();
        timer.reset();
      }
    },
  );

  test("a late native rejection after shutdown is handled", async () => {
    const { timer, devices, upgrade } = harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      upgrade.start();
      await upgrade.close();
      devices.discovered.reject(new Error("late discovery failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      timer.reset();
    }
  });
});

class FakeRegistryOpener {
  readonly signals: AbortSignal[] = [];
  readonly pending = Promise.withResolvers<void>();
  failures = 0;
  defer = false;

  async open(signal: AbortSignal): Promise<void> {
    this.signals.push(signal);
    if (this.defer) {
      return this.pending.promise;
    }
    if (this.signals.length <= this.failures) {
      throw new Error("retirement deferred");
    }
  }
}

describe("background registry upgrade retries", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test("two deferrals retry at injected backoff delays and stop after success", async () => {
    const timer = new FakeTimer();
    const opener = new FakeRegistryOpener();
    opener.failures = 2;
    const upgrade = new BackgroundBindingRegistryUpgrade((signal) => opener.open(signal), {
      timer,
      backoff: sequenceBackoff([10, 25]),
    });
    try {
      expect(upgrade.start()).toBeUndefined();
      upgrade.start();
      await drainMicrotasks(20);
      expect(opener.signals).toHaveLength(1);
      expect(timer.getPendingTimeouts()).toEqual([10]);
      timer.advanceTime(9);
      await drainMicrotasks(20);
      expect(opener.signals).toHaveLength(1);
      timer.advanceTime(1);
      await drainMicrotasks(20);
      expect(opener.signals).toHaveLength(2);
      expect(timer.getPendingTimeouts()).toEqual([25]);
      timer.advanceTime(24);
      await drainMicrotasks(20);
      expect(opener.signals).toHaveLength(2);
      timer.advanceTime(1);
      await drainMicrotasks(20);
      expect(opener.signals).toHaveLength(3);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      upgrade.start();
      timer.advanceTime(1_000_000);
      await drainMicrotasks(20);
      expect(opener.signals).toHaveLength(3);
      expect(timer.getPendingSleepCount()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toContain("[Daemon] Binding registry upgrade deferred:");
      expect(warn.mock.calls[0]?.[0]).toContain("retirement deferred");
      expect(warn.mock.calls[0]?.[0]).toContain("attempt 1");
      expect(warn.mock.calls[0]?.[0]).toContain("10ms");
      expect(warn.mock.calls[1]?.[0]).toContain("attempt 2");
      expect(warn.mock.calls[1]?.[0]).toContain("25ms");
    } finally {
      await upgrade.close();
    }
  });

  test("close cancels and resolves a pending retry wait without another open", async () => {
    const timer = new FakeTimer();
    const opener = new FakeRegistryOpener();
    opener.failures = 10;
    const upgrade = new BackgroundBindingRegistryUpgrade((signal) => opener.open(signal), {
      timer,
      backoff: fixedBackoff(50),
    });
    try {
      upgrade.start();
      await drainMicrotasks(20);
      expect(timer.getPendingTimeouts()).toEqual([50]);
      await upgrade.close();
      expect(opener.signals[0]?.aborted).toBe(true);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      upgrade.start();
      timer.advanceTime(1_000_000);
      await drainMicrotasks(20);
      expect(opener.signals).toHaveLength(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.getPendingSleepCount()).toBe(0);
    } finally {
      await upgrade.close();
    }
  });

  test.each(["resolve", "reject"])(
    "close aborts and joins an in-flight open that will %s",
    async (outcome) => {
      const timer = new FakeTimer();
      const opener = new FakeRegistryOpener();
      opener.defer = true;
      const upgrade = new BackgroundBindingRegistryUpgrade((signal) => opener.open(signal), {
        timer,
      });
      upgrade.start();
      let closed = false;
      const closing = upgrade.close().then(() => {
        closed = true;
      });
      await drainMicrotasks(20);
      expect(opener.signals[0]?.aborted).toBe(true);
      expect(closed).toBe(false);
      if (outcome === "resolve") {
        opener.pending.resolve();
      } else {
        opener.pending.reject(new Error("open aborted"));
      }
      await closing;
      expect(closed).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      expect(timer.getPendingTimeoutCount()).toBe(0);
      upgrade.start();
      timer.advanceTime(1_000_000);
      await drainMicrotasks(20);
      expect(opener.signals).toHaveLength(1);
    },
  );

  test("start after close before any attempt is a no-op", async () => {
    const timer = new FakeTimer();
    const opener = new FakeRegistryOpener();
    const upgrade = new BackgroundBindingRegistryUpgrade((signal) => opener.open(signal), {
      timer,
    });
    await upgrade.close();
    upgrade.start();
    timer.advanceTime(1_000_000);
    await drainMicrotasks(20);
    expect(opener.signals).toHaveLength(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("default backoff doubles from five seconds and caps at five minutes", async () => {
    const timer = new FakeTimer();
    const opener = new FakeRegistryOpener();
    opener.failures = 9;
    const upgrade = new BackgroundBindingRegistryUpgrade((signal) => opener.open(signal), {
      timer,
    });
    try {
      upgrade.start();
      for (const delay of [
        5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
      ]) {
        await drainMicrotasks(20);
        expect(timer.getPendingTimeouts()).toEqual([delay]);
        timer.advanceTime(delay);
      }
      await drainMicrotasks(20);
      expect(opener.signals).toHaveLength(10);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await upgrade.close();
    }
  });
});
