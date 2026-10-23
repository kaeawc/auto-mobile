import { makePool } from "../helpers/makePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { ForeignAndroidSerialSource } from "../../src/devices/deviceDiscoveryContracts";
import { expect, spyOn, test } from "bun:test";
import { ForeignClaims } from "../../src/daemon/foreignClaims";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

test("foreign inventory source preserves local holders and only accepts positive foreign evidence", async () => {
  const refreshed: string[][] = [];
  const claims = new ForeignClaims({
    timer: new FakeTimer(),
    foreignDeviceOwnership: {
      claim: async () => true,
      release: () => {},
      refresh: async (serials) => {
        refreshed.push([...serials]);
      },
      foreignOwnerPid: (serial) => (serial === "unknown" ? undefined : 42),
    },
    iosForeignDeviceOwnership: undefined,
    getDevice: (serial) => (serial === "held" ? { sessionId: "our-session" } : undefined),
    getDevicesByPlatform: () => [],
  });
  expect(await claims.foreignSerials(["held", "foreign", "unknown"])).toEqual(new Set(["foreign"]));
  expect(refreshed).toEqual([["held", "foreign", "unknown"]]);
});

test("failed ownership refresh warns and discards stale positive foreign evidence", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const claims = new ForeignClaims({
      timer: new FakeTimer(),
      foreignDeviceOwnership: {
        claim: async () => true,
        release: () => {},
        refresh: async () => {
          throw new Error("claim read failed");
        },
        foreignOwnerPid: () => 42,
      },
      iosForeignDeviceOwnership: undefined,
      getDevice: () => undefined,
      getDevicesByPlatform: () => [],
    });
    expect(await claims.foreignSerials(["emulator-5610"])).toEqual(new Set());
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ownership refresh failed"),
      expect.any(Error),
    );
  } finally {
    warn.mockRestore();
  }
});

test("inventory ownership coalesces concurrent reads and bounds each wait by its signal", async () => {
  const pending = Promise.withResolvers<void>();
  let calls = 0;
  const signals: (AbortSignal | undefined)[] = [];
  const timer = new FakeTimer();
  const claims = new ForeignClaims({
    timer,
    foreignDeviceOwnership: {
      claim: async () => true,
      release: () => {},
      refresh: async (_serials, signal?: AbortSignal) => {
        calls++;
        signals.push(signal);
        await pending.promise;
      },
      foreignOwnerPid: () => 42,
    },
    iosForeignDeviceOwnership: undefined,
    getDevice: () => undefined,
    getDevicesByPlatform: () => [],
  });
  const controller = new AbortController();
  const first = claims.foreignSerials(["emulator-5610"], controller.signal);
  const second = claims.foreignSerials(["emulator-5610"]);
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(signals[0]).toBeDefined();
  controller.abort(new Error("request expired"));
  await expect(first).rejects.toThrow("request expired");
  pending.resolve();
  expect(await second).toEqual(new Set(["emulator-5610"]));
  expect(await claims.foreignSerials(["emulator-5610"])).toEqual(new Set(["emulator-5610"]));
  expect(calls).toBe(1);
  timer.advanceTime(1_000);
  await claims.foreignSerials(["emulator-5610"]);
  expect(calls).toBe(2);
});

test("DevicePool initialization wires its foreign claims into the device manager", async () => {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  let wired: ForeignAndroidSerialSource | undefined;
  class WiredDeviceManager extends FakeDeviceUtils {
    withForeignAndroidSerialSource(source: ForeignAndroidSerialSource): this {
      wired = source;
      return this;
    }
  }
  const manager = new WiredDeviceManager();
  try {
    makePool(sessions, "daemon", {
      timer,
      deviceManager: manager,
      foreignDeviceOwnership: {
        claim: async () => true,
        release: () => {},
        refresh: async () => {},
        foreignOwnerPid: () => 42,
      },
    });
    expect(wired).toBeDefined();
    expect(await wired!.foreignSerials(["emulator-5610"])).toEqual(new Set(["emulator-5610"]));
  } finally {
    sessions.stopCleanupTimer();
    timer.reset();
  }
});

test("readiness candidate subsets reuse ownership verdicts from the full inventory", async () => {
  let calls = 0;
  const claims = new ForeignClaims({
    timer: new FakeTimer(),
    foreignDeviceOwnership: {
      claim: async () => true,
      release: () => {},
      refresh: async () => {
        calls++;
      },
      foreignOwnerPid: () => 42,
    },
    iosForeignDeviceOwnership: undefined,
    getDevice: () => undefined,
    getDevicesByPlatform: () => [],
  });
  await claims.foreignSerials(["emulator-5556", "emulator-5610"]);
  expect(await claims.foreignSerials(["emulator-5610"])).toEqual(new Set(["emulator-5610"]));
  expect(calls).toBe(1);
});
