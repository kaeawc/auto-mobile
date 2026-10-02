import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { MockLocationClearRegistry } from "../../../src/features/utility/MockLocationClear";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import {
  LocationRouteRegistry,
  registerLocationRouteSessionCleanup,
} from "../../../src/features/utility/LocationRoutePlayer";
import type { SessionManager } from "../../../src/daemon/sessionManager";
import { logger } from "../../../src/utils/logger";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const ios: BootedDevice = {
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  name: "iPhone",
};
const other: BootedDevice = { ...ios, deviceId: "22345678-1234-1234-1234-123456789ABC" };
const clearArgs = (device = ios) => ["location", device.deviceId, "clear"];
const flush = async () => {
  for (let index = 0; index < 40; index++) {
    await Promise.resolve();
  }
};
const warn = spyOn(logger, "warn").mockImplementation(() => {});
afterEach(() => warn.mockClear());
afterAll(() => warn.mockRestore());

function harness(simctl = new FakeSimCtlClient()) {
  const timer = new FakeTimer();
  const registry = new LocationRouteRegistry(timer);
  const clears = new MockLocationClearRegistry({ timer, simctlFactory: () => simctl });
  let release!: Parameters<SessionManager["onSessionRelease"]>[0];
  let unbound!: Parameters<SessionManager["onSessionDeviceUnbound"]>[0];
  const pending: Array<{ deviceId: string; promise: Promise<unknown> }> = [];
  registerLocationRouteSessionCleanup(
    {
      onSessionRelease: (callback) => {
        release = callback;
      },
      onSessionDeviceUnbound: (callback) => {
        unbound = callback;
      },
      registerPendingDeviceCleanup: (deviceId, promise) => {
        pending.push({ deviceId, promise });
      },
    },
    { registry, mockLocationClears: clears },
  );
  return {
    timer,
    registry,
    clears,
    simctl,
    pending,
    unbound,
    release: (sessionId: string, deviceId = ios.deviceId) =>
      release(sessionId, deviceId, "test", {
        sessionId,
        deviceId,
        releaseReason: "test",
        releasedAtMs: 0,
        terminal: true,
        heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 1000, ageMs: 0 },
      }),
  };
}

describe("session mock location clear", () => {
  test("static set clears once on release, strictly after an in-flight route settles", async () => {
    const calls: string[] = [];
    class RecordedSimctl extends FakeSimCtlClient {
      override async executeCommandArgs(args: string[], timeoutMs?: number) {
        calls.push(args[2]);
        return super.executeCommandArgs(args, timeoutMs);
      }
    }
    const h = harness(new RecordedSimctl());
    const state = new DeviceState(ios, {
      simctl: h.simctl,
      timer: h.timer,
      routeRegistry: h.registry,
      onLocationApplied: () => h.clears.markSet("s", ios),
    });
    await state.setState({ location: { mode: "static", latitude: 1, longitude: 2 } });
    const fix = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    h.registry.start(
      ios.deviceId,
      [
        { latitude: 0, longitude: 0 },
        { latitude: 1, longitude: 1 },
      ],
      1000,
      500,
      true,
      async (_point, options) => {
        signal = options.signal;
        calls.push("emit");
        await fix.promise;
        calls.push("settled");
      },
    );
    h.timer.advanceTime(0);
    h.release("s");
    expect(signal?.aborted).toBe(true);
    expect(h.pending).toHaveLength(2); // Both quarantines are published synchronously.
    await flush();
    expect(calls).toEqual(["set", "emit"]);
    fix.resolve();
    await Promise.all(h.pending.map((entry) => entry.promise));
    expect(calls).toEqual(["set", "emit", "settled", "clear"]);
    expect(h.simctl.getMethodCalls("executeCommandArgs")[1]).toMatchObject({ args: clearArgs() });
    expect(h.clears.clearAfter("s", ios.deviceId, Promise.resolve())).toBeNull();
  });

  test("rebind clears only the old device", async () => {
    const h = harness();
    h.clears.markSet("s", ios);
    h.clears.markSet("s", other);
    h.unbound("s", ios.deviceId);
    await Promise.all(h.pending.map((entry) => entry.promise));
    expect(h.simctl.getMethodCalls("executeCommandArgs")).toEqual([
      { args: clearArgs(), timeoutMs: 5000 },
    ]);
    h.clears.retireDevice(other.deviceId);
  });

  test("a session with no marker or a different owner issues no clear", async () => {
    const h = harness();
    h.release("empty");
    h.clears.markSet("owner", ios);
    h.release("different");
    await flush();
    expect(h.pending).toEqual([]);
    expect(h.simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    await h.clears.clearAfter("owner", ios.deviceId, Promise.resolve());
    expect(h.simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
  });

  test("failed clear warns and keeps quarantine pending through the 250ms retry", async () => {
    const h = harness();
    h.simctl.setCommandArgsResultSequence(clearArgs(), [new Error("busy"), { stdout: "" }]);
    h.clears.markSet("s", ios);
    h.release("s");
    let settled = false;
    const pending = h.pending[0].promise.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ios.deviceId), expect.any(Error));
    h.timer.advanceTime(249);
    await flush();
    expect(h.simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
    h.timer.advanceTime(1);
    await pending;
    expect(h.simctl.getMethodCalls("executeCommandArgs")).toHaveLength(2);
    expect(settled).toBe(true);
  });

  test("removal interrupts retry sleep and releases quarantine", async () => {
    const h = harness();
    h.simctl.setCommandArgsError(clearArgs(), new Error("busy"));
    h.clears.markSet("s", ios);
    h.release("s");
    await flush();
    h.clears.retireDevice(ios.deviceId);
    await h.pending[0].promise;
    h.timer.advanceTime(10_000);
    await flush();
    expect(h.simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
    expect(h.clears.clearAfter("s", ios.deviceId, Promise.resolve())).toBeNull();
  });

  test("removal aborts an in-flight attempt, even when the client ignores cancellation", async () => {
    let signal: AbortSignal | undefined;
    const never =
      Promise.withResolvers<Awaited<ReturnType<FakeSimCtlClient["executeCommandArgs"]>>>();
    const timer = new FakeTimer();
    const clears = new MockLocationClearRegistry({
      timer,
      simctlFactory: () => ({
        executeCommandArgs: (_args, _timeout, attemptSignal) => {
          signal = attemptSignal;
          return never.promise;
        },
      }),
    });
    clears.markSet("s", ios);
    const pending = clears.clearAfter("s", ios.deviceId, Promise.resolve());
    await flush();
    clears.retireDevice(ios.deviceId);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a hung attempt is bounded at 5s and retried with an aborted signal", async () => {
    const timer = new FakeTimer();
    const simctl = new FakeSimCtlClient();
    let attempts = 0;
    let signal: AbortSignal | undefined;
    const clears = new MockLocationClearRegistry({
      timer,
      simctlFactory: () => ({
        executeCommandArgs: (args, timeout, attemptSignal) => {
          signal = attemptSignal;
          attempts++;
          return attempts === 1 ? new Promise(() => {}) : simctl.executeCommandArgs(args, timeout);
        },
      }),
    });
    clears.markSet("s", ios);
    const pending = clears.clearAfter("s", ios.deviceId, Promise.resolve());
    await flush();
    timer.advanceTime(5000);
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(attempts).toBe(1);
    timer.advanceTime(250);
    await pending;
    expect(attempts).toBe(2);
  });

  test("a new session supersedes an older retry without clearing the new fix", async () => {
    const h = harness();
    h.simctl.setCommandArgsResultSequence(clearArgs(), [new Error("busy"), { stdout: "" }]);
    h.clears.markSet("old", ios);
    const pending = h.clears.clearAfter("old", ios.deviceId, Promise.resolve());
    await flush();
    h.clears.markSet("new", ios);
    await pending;
    h.timer.advanceTime(250);
    await flush();
    expect(h.simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
    await h.clears.clearAfter("new", ios.deviceId, Promise.resolve());
    expect(h.simctl.getMethodCalls("executeCommandArgs")).toHaveLength(2);
  });

  test("two sessions clear only their own simulator, with idempotent markers", async () => {
    const h = harness();
    h.clears.markSet("a", ios);
    h.clears.markSet("a", ios);
    h.clears.markSet("b", other);
    h.release("a");
    await h.pending[0].promise;
    expect(h.simctl.getMethodCalls("executeCommandArgs")[0].args).toEqual(clearArgs());
    h.release("b", other.deviceId);
    await h.pending[1].promise;
    expect(h.simctl.getMethodCalls("executeCommandArgs")[1].args).toEqual(clearArgs(other));
  });

  for (const device of [
    { ...ios, platform: "android" as const },
    { ...ios, deviceId: "00008110-0012345678901234" },
  ]) {
    test(`never marks ${device.platform} ${device.deviceId}`, async () => {
      const h = harness();
      h.clears.markSet("s", device);
      expect(h.clears.clearAfter("s", device.deviceId, Promise.resolve())).toBeNull();
      h.release("s", device.deviceId);
      await flush();
      expect(h.pending).toEqual([]);
      expect(h.simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    });
  }
});
