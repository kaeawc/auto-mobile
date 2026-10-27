import { makePool } from "../helpers/makePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { ForeignAndroidSerialSource } from "../../src/devices/deviceDiscoveryContracts";
import { expect, spyOn, test } from "bun:test";
import { ForeignClaims } from "../../src/daemon/foreignClaims";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import type { BackoffPolicy } from "../../src/utils/Backoff";

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

function probeHarness(inventoryProbeBackoff?: BackoffPolicy) {
  const timer = new FakeTimer();
  const reads = new Map<string, number[]>();
  const foreign = new Set(["foreign"]);
  let fail = false;
  const claims = new ForeignClaims({
    timer,
    inventoryProbeBackoff,
    foreignDeviceOwnership: {
      claim: async () => true,
      release: () => {},
      refresh: async (serials) => {
        for (const serial of serials) {
          reads.set(serial, [...(reads.get(serial) ?? []), timer.now()]);
        }
        if (fail) {
          throw new Error("read failed");
        }
      },
      foreignOwnerPid: (serial) => (foreign.has(serial) ? 42 : undefined),
    },
    iosForeignDeviceOwnership: undefined,
    getDevice: () => undefined,
    getDevicesByPlatform: () => [],
  });
  return {
    timer,
    reads,
    foreign,
    claims,
    setFailure: (value: boolean) => {
      fail = value;
    },
  };
}

test("foreign probes back off to eight seconds while free serials refresh every second", async () => {
  const h = probeHarness();
  for (let second = 0; second <= 60; second++) {
    expect(await h.claims.foreignSerials(["foreign", "free"])).toEqual(new Set(["foreign"]));
    if (second < 60) {
      h.timer.advanceTime(1_000);
    }
  }
  expect(h.reads.get("foreign")).toEqual(
    [0, 1, 3, 7, 15, 23, 31, 39, 47, 55].map((s) => s * 1_000),
  );
  expect(h.reads.get("free")).toEqual(Array.from({ length: 61 }, (_, s) => s * 1_000));
});

test("foreign cache lasts until expiry and a free verdict lasts at most one second", async () => {
  const h = probeHarness();
  for (const delta of [0, 1_000, 2_000, 4_000]) {
    h.timer.advanceTime(delta);
    await h.claims.foreignSerials(["foreign"]);
  }
  h.foreign.clear();
  h.timer.advanceTime(7_999);
  expect(await h.claims.foreignSerials(["foreign"])).toEqual(new Set(["foreign"]));
  h.timer.advanceTime(1);
  expect(await h.claims.foreignSerials(["foreign"])).toEqual(new Set());
  h.foreign.add("foreign");
  h.timer.advanceTime(999);
  expect(await h.claims.foreignSerials(["foreign"])).toEqual(new Set());
  h.timer.advanceTime(1);
  expect(await h.claims.foreignSerials(["foreign"])).toEqual(new Set(["foreign"]));
  h.timer.advanceTime(1_000);
  await h.claims.foreignSerials(["foreign"]);
  expect(h.reads.get("foreign")).toEqual([0, 1_000, 3_000, 7_000, 15_000, 16_000, 17_000]);
});

test("disappearing inventory serials lose their probe streak and cached verdict", async () => {
  const h = probeHarness();
  await h.claims.foreignSerials(["foreign"]);
  h.timer.advanceTime(1_000);
  await h.claims.foreignSerials(["foreign"]);
  await h.claims.foreignSerials([]);
  await h.claims.foreignSerials(["foreign"]);
  h.timer.advanceTime(1_000);
  await h.claims.foreignSerials(["foreign"]);
  expect(h.reads.get("foreign")).toEqual([0, 1_000, 1_000, 2_000]);
});

test("a failed refresh clears the foreign streak and retries immediately", async () => {
  const h = probeHarness();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await h.claims.foreignSerials(["foreign"]);
    h.timer.advanceTime(1_000);
    await h.claims.foreignSerials(["foreign"]);
    h.timer.advanceTime(2_000);
    h.setFailure(true);
    expect(await h.claims.foreignSerials(["foreign"])).toEqual(new Set());
    h.setFailure(false);
    await h.claims.foreignSerials(["foreign"]);
    h.timer.advanceTime(1_000);
    await h.claims.foreignSerials(["foreign"]);
    expect(h.reads.get("foreign")).toEqual([0, 1_000, 3_000, 3_000, 4_000]);
  } finally {
    warn.mockRestore();
  }
});

test("inventory probe policy is injectable and explicit binds bypass its cached verdict", async () => {
  const attempts: number[] = [];
  const h = probeHarness({
    delayForAttempt: (attempt) => {
      attempts.push(attempt);
      return 1_000 * attempt;
    },
  });
  await h.claims.foreignSerials(["foreign"]);
  h.timer.advanceTime(1_000);
  await h.claims.foreignSerials(["foreign"]);
  h.foreign.clear();
  await h.claims.assertNotClaimedByForeignDaemon("foreign", "android");
  expect(h.reads.get("foreign")).toEqual([0, 1_000, 1_000]);
  expect(await h.claims.foreignSerials(["foreign"])).toEqual(new Set(["foreign"]));
  h.timer.advanceTime(2_000);
  expect(await h.claims.foreignSerials(["foreign"])).toEqual(new Set());
  expect(attempts).toEqual([1, 2, 1]);
});
