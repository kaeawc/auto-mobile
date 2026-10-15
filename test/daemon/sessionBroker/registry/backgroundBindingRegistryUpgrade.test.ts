import { describe, expect, spyOn, test } from "bun:test";
import {
  BackgroundBindingRegistryUpgrade,
  LegacySlotDeviceRetirement,
  type LegacySlotRetirementStore,
  type LegacySlotSnapshot,
  type LegacySlotDeviceStopper,
} from "../../../../src/daemon/sessionBroker/registry/legacySlotDeviceRetirement";
import type { DeviceInfo } from "../../../../src/models/DeviceInfo";
import { logger } from "../../../../src/utils/logger";
import { FakeTimer } from "../../../fakes/FakeTimer";

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
  const upgrade = new BackgroundBindingRegistryUpgrade(async (signal) => {
    opens++;
    await new LegacySlotDeviceRetirement({
      timer,
      devices,
      signal,
      isOwnerLive: () => false,
      warn: () => {},
    }).retire(store);
  });
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
