import { mock, beforeEach, afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS,
  MANAGED_EXECUTION_REOWN_RETRY_INITIAL_DELAY_MS,
  MANAGED_EXECUTION_REOWN_RETRY_MAX_DELAY_MS,
  MANAGED_EXECUTION_REOWN_RETRY_MAX_BLOCKED_WAIT_MS,
  MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS,
  MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS,
  ManagedExecutionReowner,
  type ManagedExecutionReownerDependencies,
  type ManagedExecutionReownRegistry,
} from "../../../../src/daemon/sessionBroker/provisioning/executionReowner";
import { BINDING_REGISTRY_BUSY_TIMEOUT_MS } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import {
  MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS,
  MANAGED_EXECUTION_REGISTRY_RETRY_BACKOFF,
  MANAGED_SETTLED_BINDING_RECOVERY_RETRY_INITIAL_DELAY_MS,
  MANAGED_SETTLED_BINDING_RECOVERY_RETRY_MAX_DELAY_MS,
  MANAGED_SETTLED_BINDING_RECOVERY_RETRY_MAX_BLOCKED_WAIT_MS,
} from "../../../../src/daemon/sessionBroker/provisioning/executionRelease";
import {
  BindingOwnershipLostError,
  BindingDiscoveryIncompleteError,
  BindingOwnershipUnconfirmedError,
} from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import {
  BINDING_BACK_OUT_RETRY_INITIAL_DELAY_MS,
  BINDING_BACK_OUT_RETRY_MAX_DELAY_MS,
  BINDING_BACK_OUT_RETRY_MAX_BLOCKED_WAIT_MS,
} from "../../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import {
  RegistryRetryPacing,
  REGISTRY_BUSY_WRITE_MS,
  REGISTRY_RETRY_INITIAL_DELAY_MS,
  REGISTRY_RETRY_MAX_DELAY_MS,
  REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS,
} from "../../../../src/daemon/sessionBroker/registry/registryRetryPacing";
import type {
  ClaimExecutionResult,
  BindingAssignmentRecord,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { logger } from "../../../../src/utils/logger";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { timedHold } from "../../../helpers/timedReleaseHold";
import { drainMicrotasks } from "../../../helpers/fakeTimerStepping";

let warnSpy: ReturnType<typeof spyOn<typeof logger, "warn">>;
let infoSpy: ReturnType<typeof spyOn<typeof logger, "info">>;
let debugSpy: ReturnType<typeof spyOn<typeof logger, "debug">>;
beforeEach(() => {
  warnSpy = spyOn(logger, "warn");
  infoSpy = spyOn(logger, "info");
  debugSpy = spyOn(logger, "debug");
});
afterEach(() => {
  mock.restore();
});

const OWNER = { daemonId: "new-daemon", pid: 200 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function harness(
  policy?: ManagedExecutionReownerDependencies["retryBackoff"],
  ids: readonly string[] = ["a", "b"],
) {
  const timer = new FakeTimer();
  const registry = new FakeBindingRegistry(timer, () => false);
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace: "runner",
    runnerIncarnation: "boot",
  });
  if (scope.kind !== "ready") {
    throw new Error(scope.kind);
  }
  let assignmentA: BindingAssignmentRecord | undefined;
  for (const [bindingIndex, sessionUuid] of ids.entries()) {
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex };
    await registry.initBinding(key, { role: "app", platform: "android", requestedSpec: {} });
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
    const held = await registry.claimExecution(
      key,
      { generation: 1, stableDeviceId: sessionUuid },
      {
        daemonId: "old",
        pid: 100,
        sessionUuid,
      },
    );
    if (held.kind === "claimed" && sessionUuid === "a") {
      assignmentA = held.assignment;
    }
  }
  const behavior = {
    failures: 0,
    until: 0,
    blocked: 0,
    successBlocked: 0,
    refusalBlocked: 0,
    retry: false,
    refusal: undefined as ClaimExecutionResult | undefined,
    hangClaim: false,
  };
  const calls: Array<{ id: string; at: number; end: number }> = [];
  const claim =
    Promise.withResolvers<Awaited<ReturnType<ManagedExecutionReownRegistry["claimExecution"]>>>();
  const faulty: ManagedExecutionReownRegistry = {
    findExecutionAssignments: (id) => registry.findExecutionAssignments(id),
    claimExecution: async (key, binding, owner, options?) => {
      const call = { id: owner.sessionUuid, at: timer.now(), end: timer.now() };
      calls.push(call);
      if (behavior.failures-- > 0 || timer.now() < behavior.until) {
        timer.setCurrentTime(timer.now() + behavior.blocked);
        call.end = timer.now();
        throw new Error("SQLITE_BUSY: last error");
      }
      if (behavior.refusal) {
        timer.setCurrentTime(timer.now() + behavior.refusalBlocked);
        return behavior.refusal;
      }
      if (behavior.retry) {
        return { kind: "binding_not_ready", assignment: assignmentA! };
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
  const present = new Set(ids);
  const confirmed: number[] = [];
  const held = new Set(present);
  const lost: number[] = [];
  const reowner = new ManagedExecutionReowner({
    registry: () => {
      opens++;
      return opening.hang ? open.promise : Promise.resolve(faulty);
    },
    owner: () => OWNER,
    timer,
    retryBackoff: policy,
    isSessionHeld: (id) => held.has(id),
    isSessionPresent: (id) => present.has(id),
    onOwnershipLost: (id) => {
      lost.push(timer.now());
      held.delete(id);
    },
    onOwnershipConfirmed: () => {
      confirmed.push(timer.now());
    },
  });
  const warnedAt: number[] = [];
  const warn = warnSpy.mockImplementation(() => {
    warnedAt.push(timer.now());
  });
  const info = infoSpy.mockImplementation(() => {});
  const debug = debugSpy.mockImplementation(() => {});
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
    lost,
    held,
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
    get assignmentA() {
      if (!assignmentA) {
        throw new Error("binding a was not claimed");
      }
      return assignmentA;
    },
  };
}

test("one transient failure retries at 25 ms and opens admission with elapsed info", async () => {
  const h = await harness();
  h.behavior.failures = 1;
  await h.reowner.reown(["a"], { rehydrated: true });
  expect(h.reowner.automationRefusal("a")).toBeInstanceOf(BindingOwnershipUnconfirmedError);
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

// The 6 s case guards a longer per-daemon DB write inside an attempt and the 5 s quiet cap.
for (const blocked of [REGISTRY_BUSY_WRITE_MS, 300, 6_000]) {
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
  h.behavior.blocked = REGISTRY_BUSY_WRITE_MS;
  const batch = h.reowner.reown(["a", "b"], { rehydrated: true });
  await h.step(0);
  expect(h.calls).toHaveLength(1);
  await h.step(REGISTRY_BUSY_WRITE_MS - 1);
  expect(h.calls).toHaveLength(1);
  await h.step(1);
  expect(h.calls[1]?.at).toBe(2 * REGISTRY_BUSY_WRITE_MS);
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
  expect(h.reowner.automationRefusal("a")).toBeInstanceOf(BindingOwnershipUnconfirmedError);
  expect(h.calls).toHaveLength(1);
  expect(h.info).not.toHaveBeenCalled();
  h.claim.resolve({
    kind: "binding_in_use",
    owner: { ...OWNER, sessionUuid: "a" },
    assignment: h.assignmentA,
  });
  h.behavior.hangClaim = false;
  await h.step(700);
  expect(h.calls).toHaveLength(2);
  expect(h.confirmed).toEqual([1_400]);
  expect(h.warn).not.toHaveBeenCalled();
  expect(
    h.debug.mock.calls.some((call) =>
      String(call[0]).includes("retained claim completed (binding_in_use)"),
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
  expect(new BindingOwnershipUnconfirmedError("a").toPayload().retryAfterMs).toBe(1_000);
  expect(new BindingDiscoveryIncompleteError("a").toPayload().retryAfterMs).toBe(2_000);
});

test("busy ownership hold drops state exactly at the derived cap", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  await h.reowner.reown(["a"], { rehydrated: true });
  const hold = timedHold(h.reowner.releaseDeviceHold("a"));
  expect(hold.capMs).toBe(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS);
  expect(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS).toBe(
    2 * (MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS + BINDING_REGISTRY_BUSY_TIMEOUT_MS),
  );
  expect(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS).toBe(1_900);
  let outcome: string | undefined;
  void hold.settled.then((result) => {
    outcome = result;
  });
  await h.step(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS - 1);
  expect(outcome).toBeUndefined();
  expect(h.warn).not.toHaveBeenCalled();
  await h.step(1);
  expect(outcome).toBe("skip-device-writes");
  expect(h.warn).toHaveBeenCalledTimes(1);
  expect(h.warn.mock.calls[0]?.[0]).toContain("saved device state was dropped");
  expect(h.reowner.isReleaseHeld("a")).toBe(false);
});

// The older 3.3 s crossing-cap case remains reachable through a per-daemon DB write.
for (const successBlocked of [0, REGISTRY_BUSY_WRITE_MS, 3_300]) {
  test(`release bypasses old quiet time for a ${successBlocked} ms synchronous successful write`, async () => {
    const h = await harness();
    h.behavior.failures = 1;
    h.behavior.blocked = REGISTRY_BUSY_WRITE_MS;
    await h.reowner.reown(["a"], { rehydrated: true });
    await h.step(25); // The retry is now inside the shared quiet period.
    h.behavior.successBlocked = successBlocked;
    const start = h.timer.now();
    const hold = timedHold(h.reowner.releaseDeviceHold("a"));
    await h.step(0);
    expect(h.calls.map((call) => call.at)).toEqual([0, start]);
    expect(await hold.settled).toBe("teardown");
    expect(h.confirmed).toEqual([start + successBlocked]);
    expect(h.timer.now() - start).toBe(successBlocked);
    expect(h.warn).not.toHaveBeenCalled();
  });
}

for (const successAttempt of [1, 2, 3, 4, 5]) {
  test(`release attempt ${successAttempt} confirms before the cap or continues after it`, async () => {
    const h = await harness();
    h.behavior.blocked = 300;
    h.behavior.failures = 1;
    await h.reowner.reown(["a"], { rehydrated: true });
    h.behavior.failures = successAttempt - 1;
    const start = h.timer.now();
    const hold = timedHold(h.reowner.releaseDeviceHold("a"));
    await h.step(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS - 1);
    // Attempt 5 waits 400 ms after its 300 ms write: backoff now exceeds quiet time.
    const attemptStarts = [0, 600, 1_200, 1_800, 2_500];
    expect(h.calls.slice(1).map((call) => call.at - start)).toEqual(
      attemptStarts
        .slice(0, successAttempt)
        .filter((at) => at < MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS),
    );
    const confirmationDelay = attemptStarts[successAttempt - 1]!;
    expect(await hold.settled).toBe(
      confirmationDelay < MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS ? "teardown" : "skip-device-writes",
    );
    if (confirmationDelay >= MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS) {
      await h.step(confirmationDelay - (h.timer.now() - start));
    }
    expect(h.confirmed[0] - start).toBe(confirmationDelay);
    expect(h.warn.mock.calls).toHaveLength(
      confirmationDelay < MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS ? 0 : 1,
    );
  });
}

test("one expedite per hold then a failed OLD attempt restores shared quiet time", async () => {
  const h = await harness();
  // Guard the older 3.3 s cap overrun: a per-daemon DB write can still block this long.
  h.behavior.blocked = 3_300;
  h.behavior.failures = 2;
  await h.reowner.reown(["a"], { rehydrated: true });
  const hold = timedHold(h.reowner.releaseDeviceHold("a"));
  expect(timedHold(h.reowner.releaseDeviceHold("a")).settled).toBe(hold.settled);
  await h.step(0);
  expect(h.calls.map((call) => call.at)).toEqual([0, 3_300]);
  expect(h.reowner.isReleaseHeld("a")).toBe(false);
  await h.step(3_299);
  expect(h.calls).toHaveLength(2);
  expect(await hold.settled).toBe("skip-device-writes");
  await h.step(1);
  expect(h.calls.map((call) => call.at)).toEqual([0, 3_300, 9_900]);
});

test("a hold during an in-flight retry starts no concurrent session attempt", async () => {
  const h = await harness();
  h.behavior.failures = 1;
  await h.reowner.reown(["a"], { rehydrated: true });
  h.behavior.hangClaim = true;
  await h.step(25);
  const hold = timedHold(h.reowner.releaseDeviceHold("a"));
  const peer = h.reowner.reown(["b"], { rehydrated: true });
  await h.step(0);
  expect(h.calls.map((call) => call.id)).toEqual(["a", "a"]);
  h.behavior.hangClaim = false;
  h.claim.resolve({ kind: "binding_not_ready", assignment: h.assignmentA });
  await h.step(0);
  await peer;
  expect(h.calls.map((call) => call.id)).toEqual(["a", "a", "b"]);
  await h.step(50);
  expect(await hold.settled).toBe("teardown");
  expect(h.calls.map((call) => call.id)).toEqual(["a", "a", "b", "a"]);
});

test("a recovering session's release never forces registry admission", async () => {
  const h = await harness();
  const recovery = Promise.withResolvers<void>();
  h.reowner.noteRecovering("a", recovery.promise);
  const hold = timedHold(h.reowner.releaseDeviceHold("a"));
  expect(hold.capMs).toBe(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS);
  await h.step(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS - 1);
  expect(h.calls).toHaveLength(0);
  expect(h.opens()).toBe(0);
  await h.step(1);
  expect(await hold.settled).toBe("skip-device-writes");
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
  const hold = timedHold(h.reowner.releaseDeviceHold("a"));
  await h.step(0);
  expect(h.calls.map((c) => c.id)).toEqual(["a", "b"]);
  // Hold A was created while B owned the turn; model B blocking before its failure completes.
  h.timer.setCurrentTime(REGISTRY_BUSY_WRITE_MS);
  h.behavior.hangClaim = false;
  h.claim.resolve({ kind: "binding_not_ready", assignment: h.assignmentA });
  await h.step(0);
  await peer;
  expect(h.calls.map((c) => [c.id, c.at])).toEqual([
    ["a", 0],
    ["b", 0],
    ["a", REGISTRY_BUSY_WRITE_MS],
  ]);
  expect(await hold.settled).toBe("teardown");
  expect(h.confirmed).toEqual([REGISTRY_BUSY_WRITE_MS]);
});

test("back-out, re-own and settled-binding recovery export the shared retry schedule", () => {
  const schedule = [
    REGISTRY_RETRY_INITIAL_DELAY_MS,
    REGISTRY_RETRY_MAX_DELAY_MS,
    REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS,
  ];
  expect([
    BINDING_BACK_OUT_RETRY_INITIAL_DELAY_MS,
    BINDING_BACK_OUT_RETRY_MAX_DELAY_MS,
    BINDING_BACK_OUT_RETRY_MAX_BLOCKED_WAIT_MS,
  ]).toEqual(schedule);
  expect([
    MANAGED_EXECUTION_REOWN_RETRY_INITIAL_DELAY_MS,
    MANAGED_EXECUTION_REOWN_RETRY_MAX_DELAY_MS,
    MANAGED_EXECUTION_REOWN_RETRY_MAX_BLOCKED_WAIT_MS,
  ]).toEqual(schedule);
  expect([
    MANAGED_SETTLED_BINDING_RECOVERY_RETRY_INITIAL_DELAY_MS,
    MANAGED_SETTLED_BINDING_RECOVERY_RETRY_MAX_DELAY_MS,
    MANAGED_SETTLED_BINDING_RECOVERY_RETRY_MAX_BLOCKED_WAIT_MS,
  ]).toEqual(schedule);
});

test("the hold covers an in-flight shared turn and its own asynchronous claim", async () => {
  const h = await harness();
  h.behavior.failures = 1;
  await h.reowner.reown(["a"], { rehydrated: true });
  const pacing = new RegistryRetryPacing({ timer: h.timer });
  const gate = Promise.withResolvers<boolean>();
  const turn = pacing.run(
    () => gate.promise,
    (r) => r,
  );
  const claimExecution = h.faulty.claimExecution.bind(h.faulty);
  const claim = spyOn(h.faulty, "claimExecution").mockImplementation(async (...args) => {
    await new Promise<void>((resolve) => h.timer.setTimeout(resolve, 300));
    return claimExecution(...args);
  });
  let outcome: string | undefined;
  try {
    await h.step(0);
    const hold = timedHold(h.reowner.releaseDeviceHold("a"));
    void hold.settled.then((result) => {
      outcome = result;
    });
    await h.step(MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS);
    expect(outcome).toBeUndefined();
    gate.resolve(true);
    await turn;
    await h.step(299);
    expect(outcome).toBeUndefined();
    await h.step(1);
    expect(await hold.settled).toBe("teardown");
    expect(h.confirmed).toEqual([1_000]);
    expect(h.timer.now()).toBeLessThan(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS);
    expect(h.warn).not.toHaveBeenCalled();
  } finally {
    pacing.close();
    gate.resolve(true);
    await turn;
    claim.mockRestore();
  }
});

test("a rejected quiet waiter is a failed re-own attempt and later retries normally", async () => {
  const h = await harness();
  const pacing = new RegistryRetryPacing({ timer: h.timer });
  h.behavior.failures = 1;
  h.behavior.blocked = REGISTRY_BUSY_WRITE_MS;
  await h.reowner.reown(["a"], { rehydrated: true });
  await h.step(25);
  const error = new Error("re-own quiet timer failed");
  const schedule = spyOn(h.timer, "setTimeout").mockImplementation(() => {
    throw error;
  });
  try {
    expect(() => pacing.noteBlocked(0)).not.toThrow();
    schedule.mockRestore();
    await h.step(0);
    expect(h.calls).toHaveLength(1);
    expect(h.reowner.ownershipState("a")).toBe("unconfirmed");
    expect(h.debug.mock.calls.some(([message]) => String(message).includes(error.message))).toBe(
      true,
    );
    expect(h.warn.mock.calls).toEqual([
      [expect.stringContaining("Registry retry quiet timer failed"), error],
    ]);
    await h.step(REGISTRY_BUSY_WRITE_MS + 25);
    expect(h.confirmed).toEqual([2 * (REGISTRY_BUSY_WRITE_MS + 25)]);
    expect(h.reowner.ownershipState("a")).toBeUndefined();
  } finally {
    schedule.mockRestore();
    pacing.close();
  }
});

test("published hold timing matches the derived cap in the ownership guide", () => {
  for (const name of ["session-broker-device-reuse"]) {
    const guide = readFileSync(
      new URL(`../../../../docs/design-docs/${name}.md`, import.meta.url),
      "utf8",
    );
    expect(guide).toContain(`up to ${MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS / 1_000} s`);
    expect(guide).toContain("two shared turns at their worst case");
    expect(guide).toContain(`${MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS} ms attempt bound`);
    expect(guide).toContain(`${REGISTRY_BUSY_WRITE_MS} ms busy timeout each`);
    expect(guide).not.toContain("950 ms");
    expect(guide).not.toContain("about 300 ms");
    expect(guide).not.toContain("the previous worst-case 3.3 s is retained as headroom");
  }
});

const MAX_UNCONFIRMED_MS = MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS;

for (const kind of [
  "scope_not_valid",
  "binding_missing",
  "device_assigned_elsewhere", // Defensive shared-result case; emitted only by commitBinding.
  "binding_in_use",
] as const) {
  test(`${kind} loses ownership on the first claim and releases through the hook`, async () => {
    const h = await harness();
    const refusals: Record<typeof kind, ClaimExecutionResult> = {
      binding_in_use: {
        kind: "binding_in_use",
        assignment: h.assignmentA,
        owner: { ...OWNER, sessionUuid: "peer" },
      },
      scope_not_valid: { kind: "scope_not_valid", scope: null },
      binding_missing: { kind: "binding_missing" },
      device_assigned_elsewhere: { kind: "device_assigned_elsewhere", holder: h.assignmentA },
    };
    h.behavior.refusal = refusals[kind];
    await h.reowner.reown(["a"], { rehydrated: true });
    expect(h.lost).toEqual([0]);
    expect(h.held.has("a")).toBe(false);
    expect(h.reowner.automationRefusal("a")).toBeInstanceOf(BindingOwnershipLostError);
    await h.step(MAX_UNCONFIRMED_MS);
    expect(h.calls).toHaveLength(1);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });
}

for (const kind of ["binding_not_ready", "stale_binding"] as const) {
  test(`${kind} retries and can confirm later`, async () => {
    const h = await harness();
    const assignment = h.assignmentA;
    const refusals: Record<typeof kind, ClaimExecutionResult> = {
      binding_not_ready: { kind: "binding_not_ready", assignment },
      stale_binding: { kind: "stale_binding", current: assignment },
    };
    h.behavior.refusal = refusals[kind];
    await h.reowner.reown(["a"], { rehydrated: true });
    expect(h.reowner.ownershipState("a")).toBe("unconfirmed");
    h.behavior.refusal = undefined;
    await h.step(25);
    expect(h.confirmed).toEqual([25]);
    expect(h.lost).toEqual([]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    await h.step(MAX_UNCONFIRMED_MS);
    expect(h.calls).toHaveLength(2);
  });
}

test("busy ownership becomes a typed terminal refusal exactly at the episode bound", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  await h.reowner.reown(["a"], { rehydrated: true });
  await h.step(MAX_UNCONFIRMED_MS - 1);
  expect(h.reowner.ownershipState("a")).toBe("unconfirmed");
  expect(h.lost).toEqual([]);
  await h.step(1);
  expect(h.lost).toEqual([MAX_UNCONFIRMED_MS]);
  await h.reowner.whenIdle();
  expect(h.held.has("a")).toBe(false);
  expect(h.reowner.automationRefusal("a")).toMatchObject({
    code: "session_ownership_lost",
    retryable: false,
    nextAction: "acquire_new_session",
  });
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("client retry hints grow by episode age and cap at five seconds", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  await h.reowner.reown(["a"], { rehydrated: true });
  for (const [age, hint] of [
    [0, 1_000],
    [999, 1_000],
    [1_000, 2_000],
    [2_000, 3_000],
    [4_000, 5_000],
    [12_000, 5_000],
  ]) {
    await h.step(age - h.timer.now());
    expect(h.reowner.automationRefusal("a")).toMatchObject({ retryAfterMs: hint });
  }
});

test("a retained non-live session stops retrying without discarding its admission fence", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  await h.reowner.reown(["a"], { rehydrated: true });
  h.held.delete("a");
  await h.step(25);
  expect(h.calls).toHaveLength(1);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
  await h.reowner.whenIdle();
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
  await h.step(MAX_UNCONFIRMED_MS);
  expect(h.lost).toEqual([]);
  expect(h.reowner.automationRefusal("a")).toBeInstanceOf(BindingOwnershipUnconfirmedError);
});

test("an in-flight attempt times out after the episode bound and ignores its abandoned success", async () => {
  const h = await harness();
  h.behavior.hangClaim = true;
  const inline = h.reowner.reown(["a"], { rehydrated: true });
  await h.step(MAX_UNCONFIRMED_MS - 1);
  await inline;
  expect(h.lost).toEqual([]);
  await h.step(1);
  expect(h.lost).toEqual([]);
  await h.step(MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS);
  await h.reowner.whenIdle();
  expect(h.lost).toEqual([60_200]);
  h.claim.resolve({ kind: "claimed", assignment: h.assignmentA });
  await h.step(0);
  expect(h.confirmed).toEqual([]);
  expect(h.reowner.automationRefusal("a")).toBeInstanceOf(BindingOwnershipLostError);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

for (const elapsed of [
  14_999,
  15_000,
  MAX_UNCONFIRMED_MS - 1,
  MAX_UNCONFIRMED_MS,
  MAX_UNCONFIRMED_MS + 1,
]) {
  for (const priorFailures of [0, MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS - 1]) {
    test(`a claim confirming at ${elapsed} ms after ${priorFailures} failures wins`, async () => {
      const h = await harness();
      h.behavior.failures = priorFailures;
      h.behavior.successBlocked = elapsed - (priorFailures ? 75 : 0);
      await h.reowner.reown(["a"], { rehydrated: true });
      if (priorFailures) {
        await h.step(75);
      }
      await h.reowner.whenIdle();
      expect(h.confirmed).toEqual([elapsed]);
      expect(h.lost).toEqual([]);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      await h.step(MAX_UNCONFIRMED_MS);
      expect(h.calls).toHaveLength(priorFailures + 1);
    });
  }
}

for (const elapsed of [MAX_UNCONFIRMED_MS, MAX_UNCONFIRMED_MS + 1]) {
  test(`a retry refusal at ${elapsed} ms after minimum attempts loses immediately`, async () => {
    const h = await harness();
    h.behavior.failures = MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS - 1;
    h.behavior.refusal = { kind: "binding_not_ready", assignment: h.assignmentA };
    h.behavior.refusalBlocked = elapsed - 75;
    await h.reowner.reown(["a"], { rehydrated: true });
    await h.step(74);
    expect(h.lost).toEqual([]);
    await h.step(1);
    await h.reowner.whenIdle();
    expect(h.calls).toHaveLength(MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS);
    expect(h.lost).toEqual([elapsed]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });
}

test("direct confirmations leave a fresh retry window for later foreign ownership", async () => {
  const h = await harness();
  for (let attempt = 0; attempt < MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS; attempt++) {
    await h.reowner.reown(["a"]);
  }
  await h.step(MAX_UNCONFIRMED_MS);
  const read = spyOn(h.faulty, "findExecutionAssignments").mockResolvedValue([h.assignmentA]);
  try {
    h.behavior.retry = true;
    await h.reowner.reown(["a"]);
    expect(h.reowner.ownershipState("a")).toBe("unconfirmed");
    expect(h.reowner.automationRefusal("a")).toMatchObject({ retryAfterMs: 1_000 });
    await h.step(MAX_UNCONFIRMED_MS - 1);
    expect(h.lost).toEqual([]);
    await h.step(1);
    expect(h.lost).toEqual([2 * MAX_UNCONFIRMED_MS]);
    expect(h.calls.length).toBeGreaterThanOrEqual(1 + MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS);
  } finally {
    read.mockRestore();
  }
});

test("a second recovery resets the active retry episode and its deadline", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  const firstRecovery = Promise.withResolvers<void>();
  h.reowner.noteRecovering("a", firstRecovery.promise);
  firstRecovery.resolve();
  await h.step(75);
  expect(h.calls).toHaveLength(MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS);

  const recovery = Promise.withResolvers<void>();
  h.reowner.noteRecovering("a", recovery.promise);
  await h.step(2 * MAX_UNCONFIRMED_MS);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
  expect(h.calls).toHaveLength(MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS);
  expect(h.lost).toEqual([]);

  const recoveredAt = h.timer.now();
  recovery.resolve();
  await h.step(0);
  expect(h.calls.map((call) => call.at)).toEqual([0, 25, 75, recoveredAt]);
  expect(h.reowner.automationRefusal("a")).toMatchObject({ retryAfterMs: 1_000 });
  await h.step(MAX_UNCONFIRMED_MS - 1);
  expect(h.lost).toEqual([]);
  await h.step(1);
  expect(h.lost).toEqual([recoveredAt + MAX_UNCONFIRMED_MS]);
  expect(h.calls.length).toBeGreaterThanOrEqual(2 * MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS);
});

test("recovery beyond the bound leaves a full attempt budget after recovery", async () => {
  const h = await harness();
  const recovery = Promise.withResolvers<void>();
  h.behavior.failures = Infinity;
  h.reowner.noteRecovering("a", recovery.promise);
  await h.step(2 * MAX_UNCONFIRMED_MS);
  expect(h.calls).toHaveLength(0);
  expect(h.lost).toEqual([]);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
  expect(h.reowner.automationRefusal("a")).toMatchObject({ retryAfterMs: 1_000 });
  recovery.resolve();
  await h.step(0);
  expect(h.calls.map((call) => call.at)).toEqual([2 * MAX_UNCONFIRMED_MS]);
  expect(h.reowner.automationRefusal("a")).toMatchObject({ retryAfterMs: 1_000 });
  await h.step(MAX_UNCONFIRMED_MS - 1);
  expect(h.lost).toEqual([]);
  await h.step(1);
  expect(h.calls.length).toBeGreaterThanOrEqual(MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS);
  expect(h.lost).toEqual([3 * MAX_UNCONFIRMED_MS]);
});

test("twenty sequential contended sessions each get minimum attempts before loss", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `session-${i}`);
  const h = await harness(undefined, ids);
  h.behavior.failures = Infinity;
  h.behavior.blocked = 3_300;
  const batch = h.reowner.reown(ids, { rehydrated: true });
  await h.step(MAX_UNCONFIRMED_MS * ids.length);
  await batch;
  await h.reowner.whenIdle();
  expect(h.lost).toHaveLength(ids.length);
  for (const id of ids) {
    const calls = h.calls.filter((call) => call.id === id);
    expect(calls.length).toBeGreaterThanOrEqual(MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS);
    expect(h.reowner.ownershipState(id)).toBe("lost");
  }
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("deadline delivery during a third claim waits for proof instead of overriding it", async () => {
  const h = await harness();
  h.behavior.failures = MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS - 1;
  await h.reowner.reown(["a"], { rehydrated: true });
  await h.step(25);
  h.behavior.hangClaim = true;
  h.timer.setCurrentTime(MAX_UNCONFIRMED_MS - 100);
  await h.step(0);
  expect(h.calls).toHaveLength(MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS);
  await h.step(101);
  expect(h.lost).toEqual([]);
  h.claim.resolve({ kind: "claimed", assignment: h.assignmentA });
  await h.step(0);
  await h.reowner.whenIdle();
  expect(h.confirmed).toEqual([MAX_UNCONFIRMED_MS + 1]);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("deadline with fewer than minimum attempts leaves queued retries admitted", async () => {
  const h = await harness();
  h.behavior.failures = Infinity;
  await h.reowner.reown(["a"], { rehydrated: true });
  const pacing = new RegistryRetryPacing({ timer: h.timer });
  const gate = Promise.withResolvers<boolean>();
  const turn = pacing.run(
    () => gate.promise,
    (result) => result,
  );
  try {
    await h.step(MAX_UNCONFIRMED_MS);
    expect(h.calls).toHaveLength(1);
    expect(h.lost).toEqual([]);
    gate.resolve(true);
    await turn;
    await h.step(0);
    expect(h.calls).toHaveLength(2);
    expect(h.lost).toEqual([]);
    await h.step(50);
    await h.reowner.whenIdle();
    expect(h.calls).toHaveLength(MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS);
    expect(h.lost).toEqual([MAX_UNCONFIRMED_MS + 50]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    gate.resolve(true);
    pacing.close();
    await turn;
  }
});
