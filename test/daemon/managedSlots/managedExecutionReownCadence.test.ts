import { afterEach, expect, spyOn, test } from "bun:test";
import {
  MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS,
  ManagedExecutionReowner,
  type ManagedExecutionReownerDependencies,
  type ManagedExecutionReownRegistry,
} from "../../../src/daemon/managedSlots/managedExecutionReowner";
import { MANAGED_EXECUTION_REGISTRY_RETRY_BACKOFF } from "../../../src/daemon/managedSlots/managedExecutionRelease";
import {
  ManagedSlotDiscoveryIncompleteError,
  ManagedSlotOwnershipUnconfirmedError,
} from "../../../src/daemon/managedSlots/managedSlotRefusal";
import { logger } from "../../../src/utils/logger";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const OWNER = { daemonId: "new-daemon", pid: 200 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function harness(policy?: ManagedExecutionReownerDependencies["retryBackoff"]) {
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
  for (const [slotIndex, sessionUuid] of ["a", "b"].entries()) {
    const key = { scopeKey: scope.scope.scopeKey, slotIndex };
    await registry.initSlot(key, { role: "app", platform: "android", requestedSpec: {} });
    await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: sessionUuid,
        deviceName: sessionUuid,
        resolvedSpec: {},
        specFingerprint: "fp",
        state: "ready",
      },
    );
    await registry.claimExecution(
      key,
      { generation: 1, stableDeviceId: sessionUuid },
      {
        daemonId: "old",
        pid: 100,
        sessionUuid,
      },
    );
  }
  const behavior = {
    failures: 0,
    until: 0,
    blocked: 0,
    successBlocked: 0,
    retry: false,
    hangClaim: false,
  };
  const calls: Array<{ id: string; at: number; end: number }> = [];
  const claim =
    Promise.withResolvers<Awaited<ReturnType<ManagedExecutionReownRegistry["claimExecution"]>>>();
  const faulty: ManagedExecutionReownRegistry = {
    findExecutionAssignments: (id) => registry.findExecutionAssignments(id),
    claimExecution: async (key, binding, owner, options) => {
      const call = { id: owner.sessionUuid, at: timer.now(), end: timer.now() };
      calls.push(call);
      if (behavior.failures-- > 0 || timer.now() < behavior.until) {
        timer.setCurrentTime(timer.now() + behavior.blocked);
        call.end = timer.now();
        throw new Error("SQLITE_BUSY: last error");
      }
      if (behavior.retry) {
        return { kind: "binding_changed" };
      }
      if (behavior.hangClaim) {
        return claim.promise;
      }
      timer.setCurrentTime(timer.now() + behavior.successBlocked);
      call.end = timer.now();
      return registry.claimExecution(key, binding, owner, options);
    },
  };
  let opens = 0;
  const open = Promise.withResolvers<ManagedExecutionReownRegistry>();
  const opening = { hang: false };
  const present = new Set(["a", "b"]);
  const confirmed: number[] = [];
  const reowner = new ManagedExecutionReowner({
    registry: () => {
      opens++;
      return opening.hang ? open.promise : Promise.resolve(faulty);
    },
    owner: () => OWNER,
    timer,
    retryBackoff: policy,
    isSessionHeld: (id) => present.has(id),
    onOwnershipConfirmed: () => {
      confirmed.push(timer.now());
    },
  });
  const warnedAt: number[] = [];
  const warn = spyOn(logger, "warn").mockImplementation(() => {
    warnedAt.push(timer.now());
  });
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  cleanups.push(async () => {
    reowner.close();
    await reowner.whenIdle();
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
    reowner,
    behavior,
    calls,
    confirmed,
    warn,
    info,
    debug,
    warnedAt,
    opening,
    open,
    faulty,
    opens: () => opens,
    present,
    claim,
    step,
  };
}

test("one transient failure retries at 25 ms and opens admission with elapsed info", async () => {
  const h = await harness();
  h.behavior.failures = 1;
  await h.reowner.reown(["a"], { rehydrated: true });
  expect(h.reowner.automationRefusal("a")).toBeInstanceOf(ManagedSlotOwnershipUnconfirmedError);
  await h.step(24);
  expect(h.calls).toHaveLength(1);
  await h.step(1);
  expect(h.confirmed).toEqual([25]);
  expect(h.reowner.automationRefusal("a")).toBeUndefined();
  expect(h.warn).not.toHaveBeenCalled();
  expect(h.info).toHaveBeenCalledTimes(1);
  expect(h.info.mock.calls[0]?.[0]).toContain("25 ms");
  expect(h.info.mock.calls[0]?.[0]).toContain("2 attempts");
  expect(h.info.mock.calls[0]?.[0]).toContain(OWNER.daemonId);
});

test("three seconds of contention confirms within one second of clearing", async () => {
  const h = await harness();
  h.behavior.until = 3_000;
  await h.reowner.reown(["a"], { rehydrated: true });
  await h.step(4_000);
  expect(h.confirmed).toEqual([3_575]);
});

test("persistent failures continue at one second and warn only once after five seconds", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  await h.reowner.reown(["a"], { rehydrated: true });
  await h.step(12_000);
  expect(h.calls.map((call) => call.at)).toEqual([
    0, 25, 75, 175, 375, 775, 1_575, 2_575, 3_575, 4_575, 5_575, 6_575, 7_575, 8_575, 9_575, 10_575,
    11_575,
  ]);
  expect(h.debug).toHaveBeenCalledTimes(h.calls.length);
  expect(h.warnedAt).toEqual([5_575]);
  expect(h.warn.mock.calls[0]?.[0]).toContain("a");
  expect(h.warn.mock.calls[0]?.[0]).toContain("5575 ms");
  expect(h.warn.mock.calls[0]?.[0]).toContain("11 attempts");
  expect(h.warn.mock.calls[0]?.[0]).toContain("SQLITE_BUSY: last error");
});

test("retry results are logged and paced like failures", async () => {
  const h = await harness();
  h.behavior.retry = true;
  await h.reowner.reown(["a"], { rehydrated: true });
  await h.step(75);
  expect(h.calls.map((call) => call.at)).toEqual([0, 25, 75]);
  expect(h.debug).toHaveBeenCalledTimes(3);
  expect(h.warn).not.toHaveBeenCalled();
  expect(h.debug.mock.calls[0]?.[1]).toBeInstanceOf(Error);
});

test("close wakes a retry wait and suppresses all later logs and calls", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  await h.reowner.reown(["a"], { rehydrated: true });
  h.reowner.close();
  await h.reowner.whenIdle();
  const logs = h.debug.mock.calls.length;
  await h.step(10_000);
  expect(h.calls).toHaveLength(1);
  expect(h.debug).toHaveBeenCalledTimes(logs);
  expect(h.warn).not.toHaveBeenCalled();
  expect(h.info).not.toHaveBeenCalled();
});

test("close wakes hung and queued attempts without starting another registry call", async () => {
  const h = await harness();
  h.opening.hang = true;
  const a = h.reowner.reown(["a"], { rehydrated: true });
  const b = h.reowner.reown(["b"], { rehydrated: true });
  await h.step(0);
  expect(h.opens()).toBe(1);
  h.reowner.close();
  await Promise.all([a, b, h.reowner.whenIdle()]);
  h.open.resolve(h.faulty);
  await h.step(10_000);
  expect(h.calls).toHaveLength(0);
  expect(h.debug).not.toHaveBeenCalled();
  expect(h.warn).not.toHaveBeenCalled();
  expect(h.info).not.toHaveBeenCalled();
});

for (const blocked of [3_300, 300, 6_000]) {
  test(`blocked ${blocked} ms attempts create shared quiet time capped at five seconds`, async () => {
    const h = await harness();
    h.behavior.failures = 1;
    h.behavior.blocked = blocked;
    await h.reowner.reown(["a"], { rehydrated: true });
    const quiet = Math.min(blocked, 5_000);
    await h.step(quiet - 1);
    expect(h.calls).toHaveLength(1);
    await h.step(1);
    expect(h.calls[1]?.at).toBe(blocked + quiet);
    expect(h.confirmed).toEqual([blocked + quiet]);
  });
}

test("two sessions take turns and cannot fill each other's blocked quiet period", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  h.behavior.blocked = 3_300;
  const batch = h.reowner.reown(["a", "b"], { rehydrated: true });
  await h.step(0);
  expect(h.calls).toHaveLength(1);
  await h.step(3_299);
  expect(h.calls).toHaveLength(1);
  await h.step(1);
  expect(h.calls[1]?.at).toBe(6_600);
  expect(h.calls[1]?.id).toBe("b");
  h.reowner.close();
  await batch;
  await h.reowner.whenIdle();
});

test("a hung registry open times out at 700 ms, is retained and later confirms", async () => {
  const h = await harness();
  h.opening.hang = true;
  let ended = false;
  const inline = h.reowner.reown(["a"], { rehydrated: true }).then(() => {
    ended = true;
  });
  await h.step(699);
  expect(ended).toBe(false);
  await h.step(1);
  expect(ended).toBe(true);
  expect(h.reowner.ownershipState("a")).toBe("unconfirmed");
  await inline;
  await h.step(700);
  expect(h.opens()).toBe(1);
  h.open.resolve(h.faulty);
  await h.step(0);
  expect(h.reowner.ownershipState("a")).toBeUndefined();
  expect(h.confirmed).toEqual([1_400]);
  expect(h.opens()).toBe(1);
});

test("a timed-out claim's late rejection is observed on a later attempt", async () => {
  const h = await harness();
  h.behavior.hangClaim = true;
  let ended = false;
  const inline = h.reowner.reown(["a"], { rehydrated: true }).then(() => {
    ended = true;
  });
  await h.step(700);
  expect(ended).toBe(true);
  await inline;
  h.claim.reject(new Error("late claim failure"));
  await h.step(700);
  expect(h.calls).toHaveLength(1);
  expect(h.reowner.ownershipState("a")).toBe("unconfirmed");
  expect(h.debug.mock.calls.some((call) => String(call[0]).includes("late claim failure"))).toBe(
    true,
  );
  h.behavior.hangClaim = false;
  await h.step(50);
  expect(h.confirmed).toEqual([1_450]);
});

test("a late open cannot start a blocking write inside another waiter's quiet period", async () => {
  const h = await harness();
  h.opening.hang = true;
  const inline = h.reowner.reown(["a"], { rehydrated: true });
  await h.step(700);
  await inline;
  await h.step(300);
  h.open.resolve(h.faulty);
  await h.step(0);
  expect(h.calls).toHaveLength(0);
  expect(h.reowner.ownershipState("a")).toBe("unconfirmed");
  await h.step(400);
  expect(h.confirmed).toEqual([1_400]);
  expect(h.opens()).toBe(1);
});

test("a timed-out foreign-owner claim gates an unmarked session until a later current read", async () => {
  const h = await harness();
  h.behavior.hangClaim = true;
  const inline = h.reowner.reown(["a"]);
  await h.step(700);
  await inline;
  expect(h.reowner.automationRefusal("a")).toBeInstanceOf(ManagedSlotOwnershipUnconfirmedError);
  expect(h.calls).toHaveLength(1);
  expect(h.info).not.toHaveBeenCalled();
  h.claim.resolve({ kind: "slot_in_use" });
  h.behavior.hangClaim = false;
  await h.step(700);
  expect(h.calls).toHaveLength(2);
  expect(h.confirmed).toEqual([1_400]);
  expect(h.warn).not.toHaveBeenCalled();
  expect(
    h.debug.mock.calls.some((call) =>
      String(call[0]).includes("retained claim completed (slot_in_use)"),
    ),
  ).toBe(true);
});

test("external confirmation during a pending claim cannot be undone by its cancellation", async () => {
  const h = await harness();
  h.behavior.hangClaim = true;
  const inline = h.reowner.reown(["a"], { rehydrated: true });
  await h.step(0);
  expect(h.calls).toHaveLength(1);
  h.reowner.confirmOwnership("a");
  await inline;
  await h.reowner.whenIdle();
  h.claim.reject(new Error("late cancelled claim"));
  await h.step(1_000);
  expect(h.reowner.ownershipState("a")).toBeUndefined();
  expect(h.calls).toHaveLength(1);
  expect(h.info).toHaveBeenCalledTimes(1);
  expect(h.warn).not.toHaveBeenCalled();
});

for (const [name, delay, expected] of [
  ["zero", 0, 25],
  ["large", 60_000, 1_000],
  ["NaN", NaN, 1_000],
] as const) {
  test(`injected ${name} policy is clamped`, async () => {
    const h = await harness({ delayForAttempt: () => delay });
    h.behavior.failures = 1;
    await h.reowner.reown(["a"], { rehydrated: true });
    await h.step(expected);
    expect(h.confirmed).toEqual([expected]);
    expect(h.warn).not.toHaveBeenCalled();
  });
}

test("throwing injected policy falls back to one second with debug", async () => {
  const h = await harness({
    delayForAttempt: () => {
      throw new Error("broken policy");
    },
  });
  h.behavior.failures = 1;
  await h.reowner.reown(["a"], { rehydrated: true });
  await h.step(1_000);
  expect(h.confirmed).toEqual([1_000]);
  expect(h.debug.mock.calls.some((call) => String(call[0]).includes("broken policy"))).toBe(true);
});

test("release schedule stays unchanged while ownership and discovery hints are independent", () => {
  expect(
    [1, 2, 3, 4, 5, 6].map((n) => MANAGED_EXECUTION_REGISTRY_RETRY_BACKOFF.delayForAttempt(n)),
  ).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000]);
  expect(new ManagedSlotOwnershipUnconfirmedError("a").toPayload().retryAfterMs).toBe(1_000);
  expect(new ManagedSlotDiscoveryIncompleteError("a").toPayload().retryAfterMs).toBe(2_000);
});

test("busy ownership hold drops state exactly at the four second cap", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  await h.reowner.reown(["a"], { rehydrated: true });
  const hold = h.reowner.releaseDeviceHold("a");
  expect(hold?.capMs).toBe(4_000);
  expect(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS).toBe(4_000);
  let outcome: string | undefined;
  void hold?.settled?.then((result) => {
    outcome = result;
  });
  await h.step(3_999);
  expect(outcome).toBeUndefined();
  expect(h.warn).not.toHaveBeenCalled();
  await h.step(1);
  expect(outcome).toBe("skip-device-writes");
  expect(h.warn).toHaveBeenCalledTimes(1);
  expect(h.warn.mock.calls[0]?.[0]).toContain("saved device state was dropped");
  expect(h.reowner.isReleaseHeld("a")).toBe(false);
});

for (const successBlocked of [0, 3_300]) {
  test(`release bypasses OLD quiet time and a ${successBlocked} ms successful write fits the cap`, async () => {
    const h = await harness();
    h.behavior.failures = 1;
    h.behavior.blocked = 3_300;
    await h.reowner.reown(["a"], { rehydrated: true });
    await h.step(25); // The retry is now inside the shared quiet period.
    h.behavior.successBlocked = successBlocked;
    const start = h.timer.now();
    const hold = h.reowner.releaseDeviceHold("a");
    await h.step(0);
    expect(h.calls.map((call) => call.at)).toEqual([0, start]);
    expect(await hold?.settled).toBe("teardown");
    expect(h.confirmed).toEqual([start + successBlocked]);
    expect(h.timer.now() - start).toBeLessThan(4_000);
    expect(h.warn).not.toHaveBeenCalled();
  });
}

for (const successAttempt of [1, 2, 3]) {
  test(`NEW timing confirms on release attempt ${successAttempt} inside four seconds`, async () => {
    const h = await harness();
    h.behavior.blocked = 300;
    h.behavior.failures = 1;
    await h.reowner.reown(["a"], { rehydrated: true });
    h.behavior.failures = successAttempt - 1;
    const start = h.timer.now();
    const hold = h.reowner.releaseDeviceHold("a");
    await h.step(3_999);
    expect(h.calls.slice(1).map((call) => call.at - start)).toEqual(
      [0, 600, 1_200].slice(0, successAttempt),
    );
    expect(await hold?.settled).toBe("teardown");
    expect(h.confirmed[0] - start).toBeLessThan(4_000);
    expect(h.warn).not.toHaveBeenCalled();
  });
}

test("one expedite per hold then a failed OLD attempt restores shared quiet time", async () => {
  const h = await harness();
  h.behavior.blocked = 3_300;
  h.behavior.failures = 2;
  await h.reowner.reown(["a"], { rehydrated: true });
  const hold = h.reowner.releaseDeviceHold("a");
  expect(h.reowner.releaseDeviceHold("a")?.settled).toBe(hold?.settled);
  await h.step(0);
  expect(h.calls.map((call) => call.at)).toEqual([0, 3_300]);
  expect(h.reowner.releaseDeviceHold("a")?.settled).toBe(hold?.settled);
  await h.step(3_299);
  expect(h.calls).toHaveLength(2);
  expect(await hold?.settled).toBe("skip-device-writes");
  await h.step(1);
  expect(h.calls.map((call) => call.at)).toEqual([0, 3_300, 9_900]);
});

test("a hold during an in-flight retry starts no concurrent session attempt", async () => {
  const h = await harness();
  h.behavior.failures = 1;
  await h.reowner.reown(["a"], { rehydrated: true });
  h.behavior.hangClaim = true;
  await h.step(25);
  const hold = h.reowner.releaseDeviceHold("a");
  const peer = h.reowner.reown(["b"], { rehydrated: true });
  await h.step(0);
  expect(h.calls.map((call) => call.id)).toEqual(["a", "a"]);
  h.behavior.hangClaim = false;
  h.claim.resolve({ kind: "binding_changed" });
  await h.step(0);
  await peer;
  expect(h.calls.map((call) => call.id)).toEqual(["a", "a", "b"]);
  await h.step(50);
  expect(await hold?.settled).toBe("teardown");
  expect(h.calls.map((call) => call.id)).toEqual(["a", "a", "b", "a"]);
});

test("a recovering session's release never forces registry admission", async () => {
  const h = await harness();
  const recovery = Promise.withResolvers<void>();
  h.reowner.noteRecovering("a", recovery.promise);
  const hold = h.reowner.releaseDeviceHold("a");
  expect(hold?.capMs).toBe(4_000);
  await h.step(3_999);
  expect(h.calls).toHaveLength(0);
  expect(h.opens()).toBe(0);
  await h.step(1);
  expect(await hold?.settled).toBe("skip-device-writes");
  h.reowner.close();
  recovery.resolve();
  await h.step(0);
  expect(h.calls).toHaveLength(0);
});

test("A's release expedites its attempt behind B's blocking in-flight attempt", async () => {
  const h = await harness();
  h.behavior.failures = 1;
  await h.reowner.reown(["a"], { rehydrated: true });
  h.behavior.hangClaim = true;
  const peer = h.reowner.reown(["b"], { rehydrated: true });
  await h.step(0);
  expect(h.calls.map((c) => c.id)).toEqual(["a", "b"]);
  const hold = h.reowner.releaseDeviceHold("a");
  await h.step(0);
  expect(h.calls.map((c) => c.id)).toEqual(["a", "b"]);
  // Hold A was created while B owned the turn; model B blocking before its failure completes.
  h.timer.setCurrentTime(3_300);
  h.behavior.hangClaim = false;
  h.claim.resolve({ kind: "binding_changed" });
  await h.step(0);
  await peer;
  expect(h.calls.map((c) => [c.id, c.at])).toEqual([
    ["a", 0],
    ["b", 0],
    ["a", 3_300],
  ]);
  expect(await hold?.settled).toBe("teardown");
  expect(h.confirmed).toEqual([3_300]);
});
