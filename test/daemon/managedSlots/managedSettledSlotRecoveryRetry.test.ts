import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  ManagedExecutionRelease,
  MANAGED_EXECUTION_REGISTRY_RETRY_BACKOFF,
} from "../../../src/daemon/managedSlots/managedExecutionRelease";
import { ManagedExecutionReowner } from "../../../src/daemon/managedSlots/managedExecutionReowner";
import { ManagedSlotOwnershipUnconfirmedError } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import { logger } from "../../../src/utils/logger";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function makeHarness() {
  const timer = new FakeTimer();
  const registry = new FakeSlotRegistry(timer, () => false);
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace: "runner",
    runnerIncarnation: "boot",
  });
  if (scope.kind !== "ready") {
    throw new Error(scope.kind);
  }
  const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  await registry.initSlot(key, { role: "app", platform: "android", requestedSpec: {} });
  await registry.commitBinding(
    key,
    { generation: 0, stableDeviceId: null },
    {
      stableDeviceId: "device",
      deviceName: "device",
      resolvedSpec: {},
      specFingerprint: "fp",
      state: "ready",
    },
  );
  await registry.claimExecution(
    key,
    { generation: 1, stableDeviceId: "device" },
    { daemonId: "dead", pid: 100, sessionUuid: "session-a" },
  );
  await registry.updateSlotState(key, { generation: 1, stableDeviceId: "device" }, "settling", {
    settler: { daemonId: "dead", pid: 100 },
  });
  const behavior = {
    failures: 0,
    until: 0,
    blocked: 0,
    openFailures: 0,
    hangOpen: false,
    hangRead: false,
  };
  const calls: Array<{ at: number; end: number }> = [];
  const opens: number[] = [];
  const open = Promise.withResolvers<FakeSlotRegistry>();
  const read =
    Promise.withResolvers<Awaited<ReturnType<FakeSlotRegistry["recoverSettledSlots"]>>>();
  const faulty = new Proxy(registry, {
    get(target, property) {
      if (property === "recoverSettledSlots") {
        return async () => {
          const call = { at: timer.now(), end: timer.now() };
          calls.push(call);
          if (behavior.hangRead) {
            return read.promise;
          }
          if (behavior.failures-- > 0 || timer.now() < behavior.until) {
            timer.setCurrentTime(timer.now() + behavior.blocked);
            call.end = timer.now();
            throw new Error("SQLITE_BUSY: last recovery error");
          }
          return target.recoverSettledSlots();
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const release = new ManagedExecutionRelease({
    registry: () => {
      opens.push(timer.now());
      if (behavior.openFailures-- > 0) {
        throw new Error("open busy");
      }
      return behavior.hangOpen ? open.promise : Promise.resolve(faulty);
    },
    timer,
    work: {
      cancelDeviceSessionExecutions: async () => 0,
      waitForDeviceSessionExecutionsToEnd: async () => true,
      hasActiveDeviceSessionExecutions: () => false,
    },
    sessions: {
      isSessionLive: () => false,
      deviceOf: () => null,
      releaseSession: async () => null,
      forceStuckRelease: async () => false,
      hasDeviceCleanupInProgress: () => false,
    },
  });
  const warnedAt: number[] = [];
  const warn = spyOn(logger, "warn").mockImplementation(() => {
    warnedAt.push(timer.now());
  });
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  cleanups.push(async () => {
    release.close();
    await release.whenIdle();
    warn.mockRestore();
    info.mockRestore();
    debug.mockRestore();
    await registry.close();
  });
  async function step(ms: number) {
    await drainMicrotasks(80);
    await timer.advanceTimeAsync(ms, () => drainMicrotasks(80));
    await drainMicrotasks(80);
  }
  return {
    timer,
    registry,
    faulty,
    key,
    release,
    behavior,
    calls,
    opens,
    open,
    read,
    warn,
    info,
    debug,
    warnedAt,
    step,
  };
}

let fixture: Awaited<ReturnType<typeof makeHarness>>;
beforeEach(async () => {
  fixture = await makeHarness();
});
async function harness(empty = false) {
  if (empty) {
    const assignment = (await fixture.registry.getAssignment(fixture.key))!;
    await fixture.registry.updateSlotState(
      fixture.key,
      { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
      "ready",
    );
  }
  return fixture;
}

test("one transient recovery failure lands at 25 ms and restores ready", async () => {
  const h = await harness();
  h.behavior.failures = 1;
  const recovery = h.release.recoverSettledSlots();
  await h.step(24);
  expect(h.calls).toHaveLength(1);
  await h.step(1);
  expect(await recovery).toHaveLength(1);
  expect(h.calls.map((c) => c.at)).toEqual([0, 25]);
  expect((await h.registry.getAssignment(h.key))?.state).toBe("ready");
  expect(h.warn).not.toHaveBeenCalled();
  expect(h.info).toHaveBeenCalledTimes(2);
  expect(h.info.mock.calls[0]?.[0]).toContain("25 ms");
  expect(h.info.mock.calls[0]?.[0]).toContain("2 attempts");
  expect(h.info.mock.calls[1]?.[0]).toContain("Recovered 1 settled slot(s)");
});

test("three seconds of recovery contention lands within one second of clearing", async () => {
  const h = await harness();
  h.behavior.until = 3_000;
  const recovery = h.release.recoverSettledSlots();
  await h.step(4_000);
  expect(await recovery).toHaveLength(1);
  expect(h.calls.at(-1)?.at).toBe(3_575);
});

test("persistent recovery stays pending past ten seconds and warns once after five seconds", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  let settled = false;
  const recovery = h.release.recoverSettledSlots().then((result) => {
    settled = true;
    return result;
  });
  await h.step(5_000);
  expect(h.warn).not.toHaveBeenCalled();
  await h.step(7_000);
  expect(settled).toBe(false);
  expect(h.calls.map((c) => c.at)).toEqual([
    0,
    25,
    75,
    175,
    375,
    775,
    1_575,
    ...Array.from({ length: 10 }, (_, i) => 2_575 + i * 1_000),
  ]);
  expect(h.warnedAt).toEqual([5_575]);
  expect(h.warn.mock.calls[0]?.[0]).toContain("SQLITE_BUSY: last recovery error");
  expect(h.debug).toHaveBeenCalledTimes(h.calls.length);
  h.release.close();
  expect(await recovery).toEqual([]);
});

test("close wakes recovery and whenIdle without calls or logs after close", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  const recovery = h.release.recoverSettledSlots();
  await h.step(0);
  let idle = false;
  const waiting = h.release.whenIdle().then(() => {
    idle = true;
  });
  await h.step(0);
  expect(idle).toBe(false);
  const logs = [h.debug.mock.calls.length, h.warn.mock.calls.length, h.info.mock.calls.length];
  h.release.close();
  expect(await recovery).toEqual([]);
  await waiting;
  await h.step(10_000);
  expect(h.calls).toHaveLength(1);
  expect([h.debug.mock.calls.length, h.warn.mock.calls.length, h.info.mock.calls.length]).toEqual(
    logs,
  );
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

for (const blocked of [3_300, 300, 6_000]) {
  test(`a blocked ${blocked} ms failure gets quiet time capped at five seconds`, async () => {
    const h = await harness();
    h.behavior.failures = 1;
    h.behavior.blocked = blocked;
    const recovery = h.release.recoverSettledSlots();
    await h.step(0);
    await h.step(Math.min(blocked, 5_000) - 1);
    expect(h.calls).toHaveLength(1);
    await h.step(1);
    expect(await recovery).toHaveLength(1);
    expect(h.calls[1]?.at).toBe(blocked + Math.min(blocked, 5_000));
  });
}

test("concurrent recovery calls share one loop", async () => {
  const h = await harness();
  h.behavior.failures = 1;
  const a = h.release.recoverSettledSlots();
  const b = h.release.recoverSettledSlots();
  expect(a).toBe(b);
  await h.step(25);
  expect(await a).toHaveLength(1);
  expect(await b).toHaveLength(1);
  expect(h.calls).toHaveLength(2);
});

test("registry open failure retries at 25 ms too", async () => {
  const h = await harness();
  h.behavior.openFailures = 1;
  const recovery = h.release.recoverSettledSlots();
  await h.step(25);
  expect(await recovery).toHaveLength(1);
  expect(h.opens).toEqual([0, 25]);
});

test("close wakes a hung registry open without starting its recovery read", async () => {
  const h = await harness();
  h.behavior.hangOpen = true;
  let result: unknown;
  const recovery = h.release.recoverSettledSlots().then((value) => {
    result = value;
  });
  await h.step(0);
  h.release.close();
  await h.step(0);
  try {
    expect(result).toEqual([]);
    await recovery;
    await h.release.whenIdle();
  } finally {
    h.open.resolve(h.faulty);
    await h.step(0);
  }
  await h.step(10_000);
  expect(h.calls).toEqual([]);
  expect(h.debug).not.toHaveBeenCalled();
  expect(h.warn).not.toHaveBeenCalled();
  expect(h.info).not.toHaveBeenCalled();
});

test("zero recovered slots after a failed read still reports elapsed recovery", async () => {
  const h = await harness(true);
  h.behavior.failures = 1;
  const recovery = h.release.recoverSettledSlots();
  await h.step(25);
  expect(await recovery).toEqual([]);
  expect(h.info).toHaveBeenCalledTimes(1);
  expect(h.info.mock.calls[0]?.[0]).toContain("25 ms");
  expect(h.info.mock.calls[0]?.[0]).toContain("2 attempts");
});

test("busy settled-slot recovery gates the rehydrated session until ready then re-owned", async () => {
  const h = await harness();
  h.behavior.until = 3_000;
  const confirmed: number[] = [];
  const reowner = new ManagedExecutionReowner({
    registry: async () => h.faulty,
    owner: () => ({ daemonId: "new", pid: 200 }),
    timer: h.timer,
    isSessionHeld: () => true,
    onOwnershipConfirmed: () => {
      confirmed.push(h.timer.now());
    },
  });
  cleanups.push(async () => {
    reowner.close();
    await reowner.whenIdle();
  });
  const recovery = h.release.recoverSettledSlots();
  await reowner.reown(["session-a"], { rehydrated: true });
  for (let i = 0; i < 3; i++) {
    expect(reowner.automationRefusal("session-a")).toBeInstanceOf(
      ManagedSlotOwnershipUnconfirmedError,
    );
    expect(reowner.automationRefusal("session-a")?.code).toBe("managed_slot_ownership_unconfirmed");
    expect((await h.registry.getAssignment(h.key))?.state).toBe("settling");
    await h.step(1_000);
  }
  await h.step(1_000);
  expect(await recovery).toHaveLength(1);
  const recoveredAt = h.calls.at(-1)!.at;
  expect(recoveredAt).toBe(3_575);
  await h.step(1_000);
  expect(reowner.automationRefusal("session-a")).toBeUndefined();
  expect(confirmed[0]! - recoveredAt).toBeLessThanOrEqual(1_000);
});

test("other drain registry steps retain the default 250 ms to five second policy", async () => {
  expect(
    Array.from({ length: 7 }, (_, i) =>
      MANAGED_EXECUTION_REGISTRY_RETRY_BACKOFF.delayForAttempt(i + 1),
    ),
  ).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
  const h = await harness();
  const calls: number[] = [];
  const faulty = new Proxy(h.registry, {
    get(target, property) {
      if (property === "findExecutionAssignments") {
        return async () => {
          calls.push(h.timer.now());
          throw new Error("lookup busy");
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const release = new ManagedExecutionRelease({
    registry: async () => faulty,
    timer: h.timer,
    work: {
      cancelDeviceSessionExecutions: async () => 0,
      waitForDeviceSessionExecutionsToEnd: async () => true,
      hasActiveDeviceSessionExecutions: () => false,
    },
    sessions: {
      isSessionLive: () => false,
      deviceOf: () => null,
      releaseSession: async () => null,
      forceStuckRelease: async () => false,
      hasDeviceCleanupInProgress: () => false,
    },
  });
  cleanups.push(async () => {
    release.close();
    await release.whenIdle();
  });
  release.onSessionReleased({
    sessionId: "session-a",
    deviceId: "device",
    livenessPolicy: "managed-execution",
  });
  await h.step(17_750);
  expect(calls).toEqual([0, 250, 750, 1_750, 3_750, 7_750, 12_750, 17_750]);
  expect(h.warn.mock.calls[0]?.[0]).toContain("retrying in 250ms");
});

test("wired recovery and re-own pacers alternate blocking failures on the daemon timer", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  h.behavior.blocked = 3_300;
  const reownStarts: number[] = [];
  const registry = new Proxy(h.faulty, {
    get(target, property) {
      if (property === "findExecutionAssignments") {
        return async () => {
          reownStarts.push(h.timer.now());
          h.timer.setCurrentTime(h.timer.now() + 3_300);
          throw new Error("SQLITE_BUSY: re-own lookup");
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const reowner = new ManagedExecutionReowner({
    registry: async () => registry,
    owner: () => ({ daemonId: "new", pid: 200 }),
    timer: h.timer,
    isSessionHeld: () => true,
  });
  cleanups.push(async () => {
    reowner.close();
    await reowner.whenIdle();
  });
  const recovery = h.release.recoverSettledSlots();
  const reown = reowner.reown(["session-a"], { rehydrated: true });
  await h.step(0);
  expect(h.calls.map((c) => c.at)).toEqual([0]);
  expect(reownStarts).toEqual([]);
  await h.step(3_299);
  expect(reownStarts).toEqual([]);
  await h.step(1);
  await reown;
  expect(reownStarts).toEqual([6_600]);
  await h.step(3_300);
  expect(h.calls.map((c) => c.at)).toEqual([0, 13_200]);
  await h.step(3_300);
  expect(reownStarts).toEqual([6_600, 19_800]);
  reowner.close();
  h.release.close();
  await recovery;
  await reowner.whenIdle();
});

test("a hung registry open yields its shared turn after 700 ms without reopening", async () => {
  const h = await harness(true);
  h.behavior.hangOpen = true;
  const recovery = h.release.recoverSettledSlots();
  await h.step(0);
  const confirmed: number[] = [];
  const reowner = new ManagedExecutionReowner({
    registry: async () => h.faulty,
    owner: () => ({ daemonId: "new", pid: 200 }),
    timer: h.timer,
    isSessionHeld: () => true,
    onOwnershipConfirmed: () => {
      confirmed.push(h.timer.now());
    },
  });
  cleanups.push(async () => {
    reowner.close();
    await reowner.whenIdle();
  });
  const reown = reowner.reown(["session-a"], { rehydrated: true });
  await h.step(699);
  expect(h.debug).not.toHaveBeenCalled();
  expect(confirmed).toEqual([]);
  await h.step(1);
  expect(h.debug.mock.calls[0]?.[0]).toContain("timed out after 700ms");
  // The failed turn adds 700 ms of shared quiet time before the queued re-owner runs.
  await h.step(700);
  expect(confirmed).toEqual([1_400]);
  expect(reowner.automationRefusal("session-a")).toBeUndefined();
  await reown;
  await h.step(5_000);
  expect(h.opens).toEqual([0]);
  expect(h.warn).toHaveBeenCalledTimes(1);
  h.release.close();
  expect(await recovery).toEqual([]);
});

test("a recovery read settling after its deadline is consumed without a second read", async () => {
  const h = await harness();
  h.behavior.hangRead = true;
  let result: unknown;
  const recovery = h.release.recoverSettledSlots().then((value) => {
    result = value;
  });
  await h.step(700);
  expect(h.debug.mock.calls[0]?.[0]).toContain("timed out after 700ms");
  const landed = await h.registry.recoverSettledSlots();
  h.read.resolve(landed);
  await h.step(700);
  expect(result).toEqual(landed);
  expect(h.calls).toHaveLength(1);
  expect(h.opens).toEqual([0]);
  await recovery;
});

test("a retained recovery rejection is observed quietly then a fresh attempt succeeds", async () => {
  const h = await harness();
  h.behavior.hangRead = true;
  let result: unknown;
  const recovery = h.release.recoverSettledSlots().then((value) => {
    result = value;
  });
  await h.step(700);
  expect(h.debug.mock.calls[0]?.[0]).toContain("timed out after 700ms");
  h.behavior.hangRead = false;
  h.read.reject(new Error("late recovery read rejection"));
  await h.step(750);
  expect(h.debug.mock.calls[1]?.[0]).toContain("late recovery read rejection");
  expect(result).toHaveLength(1);
  expect(h.calls).toHaveLength(2);
  expect(h.opens).toEqual([0, 1_450]);
  expect(h.warn).not.toHaveBeenCalled();
  await recovery;
});

test("close releases retained recovery immediately and a late rejection has no logs", async () => {
  const h = await harness();
  h.behavior.hangRead = true;
  const recovery = h.release.recoverSettledSlots();
  await h.step(700);
  expect(h.debug).toHaveBeenCalledTimes(1);
  const logs = [h.debug.mock.calls.length, h.warn.mock.calls.length, h.info.mock.calls.length];
  h.release.close();
  expect(await recovery).toEqual([]);
  await h.release.whenIdle();
  h.read.reject(new Error("recovery rejected after close"));
  await h.step(10_000);
  expect([h.debug.mock.calls.length, h.warn.mock.calls.length, h.info.mock.calls.length]).toEqual(
    logs,
  );
  expect(h.calls).toHaveLength(1);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});
