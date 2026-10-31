import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import type { ResetResult } from "../../../src/daemon/sessionBroker/devicePort";
import { adaptWatchSessionDeviceCatalog } from "../../../src/devices/sessionCatalog";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { iosCatalog } from "../../devices/sessionRequirements/fixtures";
import { WATCH_DEVICE_TYPE, WATCH_RUNTIME, WATCH_RUNTIME_ID } from "../../fakes/FakeWatchSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil, drainUntilQuiescent } from "../../helpers/fakeTimerStepping";
import { openExportHarness } from "./fixtures/exportHarness";

// A released Apple Watch resetting in the iOS reuse mode is waited on and queued like an iPhone
// (#15882): a matching watch request may wait for that reset instead of creating another watch,
// and watch resets share the iOS reset-boot limit.

function watchConfig(requestId: string): SessionConfig {
  return {
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform: "watchos",
      spec: { runtime: WATCH_RUNTIME_ID, deviceType: WATCH_DEVICE_TYPE.identifier },
    },
  };
}

function watchCatalog() {
  return adaptWatchSessionDeviceCatalog({
    runtimes: [WATCH_RUNTIME],
    deviceTypes: [WATCH_DEVICE_TYPE],
  });
}

describe("watch reset readiness", () => {
  let harness: Awaited<ReturnType<typeof openExportHarness>>;
  let broker: SessionBroker;
  let finishReset: ReturnType<typeof Promise.withResolvers<ResetResult>>;
  let resetStarted: ReturnType<typeof Promise.withResolvers<void>>;

  beforeAll(async () => {
    const warm = await openExportHarness();
    await warm.broker.close();
    await warm.registry.close();
  });
  beforeEach(async () => {
    harness = await openExportHarness();
    harness.options.timer = harness.timer;
    harness.options.reuseCleanDevices = true;
    harness.options.limits = { idlePoolCap: 1 };
    harness.options.catalog = async (platform) =>
      platform === "watchos" ? watchCatalog() : iosCatalog();
    harness.options.devices = {
      prepare: async (resource, options) => {
        const result = await harness.devices.prepare(resource, options);
        harness.timer.advanceTime(30);
        return { ...result, timing: { createMs: 10, bootMs: 20 } };
      },
      release: (sessionId) => harness.devices.release(sessionId),
      destroy: (resource) => harness.devices.destroy(resource),
      reset: async (resource) => {
        await harness.devices.reset(resource);
        harness.timer.advanceTime(10);
        return "clean";
      },
    };
    broker = new SessionBroker(harness.options);
    const seed = await broker.prepare(watchConfig("seed"), "token");
    await broker.release(seed.sessionUuid!);
    finishReset = Promise.withResolvers<ResetResult>();
    resetStarted = Promise.withResolvers<void>();
    harness.options.devices.reset = async () => {
      resetStarted.resolve();
      return finishReset.promise;
    };
  });
  afterEach(async () => {
    finishReset.resolve("clean");
    await broker.close();
    await harness.broker.close();
    await harness.registry.close();
  });

  test("one of two concurrent watch acquisitions waits for the resetting watch", async () => {
    const ready = await broker.prepare(watchConfig("release"), "token");
    const released = broker.release(ready.sessionUuid!);
    await resetStarted.promise;
    const originalAdmit = harness.store.admit.bind(harness.store);
    const decisions: string[] = [];
    const admission = spyOn(harness.store, "admit").mockImplementation(async (input) => {
      const result = await originalAdmit(input);
      decisions.push(result.kind);
      return result;
    });
    try {
      const first = broker.prepare(watchConfig("first"), "token");
      const second = broker.prepare(watchConfig("second"), "token");
      await drainUntil(() => decisions.length === 2, { description: "concurrent admission" });
      expect(decisions.sort()).toEqual(["create", "wait"]);
      finishReset.resolve("clean");
      expect((await first).outcome).toBe("ready");
      expect((await second).outcome).toBe("ready");
      await released;
    } finally {
      admission.mockRestore();
    }
  });
});

describe("watch reset boot slots", () => {
  test("watch resets queue for the iOS reset-boot limit on a port without its own slots", async () => {
    const harness = await openExportHarness(":memory:", new FakeTimer());
    const releaseErase = Promise.withResolvers<void>();
    let starts = 0;
    const broker = new SessionBroker({
      ...harness.options,
      timer: harness.timer,
      reuseCleanDevices: true,
      catalog: async () => watchCatalog(),
      limits: { totalDeviceCap: 2, sessionCap: 2, idlePoolCap: 2, maxConcurrentResetBoots: 1 },
      devices: {
        prepare: (resource, options) => harness.devices.prepare(resource, options),
        release: (sessionId) => harness.devices.release(sessionId),
        destroy: (resource) => harness.devices.destroy(resource),
        reset: async (resource) => {
          starts++;
          if (starts === 1) {
            await releaseErase.promise;
          }
          await harness.devices.reset(resource);
          return { outcome: "clean", mode: "erase", phases: {} };
        },
      },
    });
    try {
      const first = await broker.prepare(watchConfig("first"), "token");
      const second = await broker.prepare(watchConfig("second"), "token");
      const releases = [broker.release(first.sessionUuid!), broker.release(second.sessionUuid!)];
      await drainUntil(() => starts === 1, { description: "first watch reset holds the slot" });
      await drainUntilQuiescent(harness.timer);
      harness.timer.advanceTime(5_000);
      releaseErase.resolve();
      const [firstReleased, secondReleased] = await Promise.all(releases);
      expect(firstReleased.timing?.reset?.phases.bootQueue).toBe(0);
      expect(secondReleased.timing?.reset?.phases.bootQueue).toBe(5_000);
    } finally {
      releaseErase.resolve();
      await broker.close();
      await harness.broker.close();
      await harness.registry.close();
    }
  });
});
