import { bindDevice } from "../../src/daemon/deviceBinding";
import { readFileSync } from "node:fs";
import { QueuedDeviceStateRestore } from "../../src/daemon/queuedDeviceStateRestore";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { forceStuckSessionRelease } from "../../src/daemon/releaseSessionAndDevice";
import { DevicePool } from "../../src/daemon/devicePool";
import { SESSION_RELEASE_TEARDOWN_CAP_MS, SessionManager } from "../../src/daemon/sessionManager";
import {
  COMPLETED_CLEANUP_RECEIPT_LIMIT,
  UNCOMPLETED_CLEANUP_RECEIPT_LIMIT,
  CLEANUP_RECEIPT_TOMBSTONE_LIMIT,
  SESSION_CLEANUP_RECEIPT_METHOD,
  SessionCleanupReceipts,
} from "../../src/daemon/sessionCleanupReceipts";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntil, settleByFakeEvents } from "../helpers/fakeTimerStepping";

const sessionUuid = "00000000-0000-4000-8000-000000000001";
const device = {
  deviceId: "00000000-0000-4000-8000-000000000002",
  name: "Synthetic simulator",
  platform: "ios" as const,
};
const daemonGeneration = "synthetic-daemon-generation";
const identity = { sessionUuid, deviceId: device.deviceId, daemonGeneration };
const managers: SessionManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
});

async function harness(restore: () => Promise<void> = async () => {}) {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
    biometricEnrollmentRestorer: () => ({ restore }),
    restorers: {
      networkCondition: () => ({ restore }),
      clock: () => ({ restore }),
      iosAppNetworkRule: { reset: async () => {}, renew: async () => "renewed" },
    },
  });
  managers.push(manager);
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("ios", [device]);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, daemonGeneration, {
      timer,
      deviceManager: utils,
      deviceHealthMarkers: new FakeDeviceHealthMarkers(timer),
    }),
  );
  await pool.initializeWithDevices([device]);
  await pool.bindOrReuseDeviceSession({
    sessionId: sessionUuid,
    deviceId: device.deviceId,
    platform: "ios",
  });
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => pool,
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
  const request = (method: string, params: Record<string, unknown>) =>
    handleDaemonRequest({ id: "synthetic-request", type: "daemon_request", method, params }, state);
  return {
    manager,
    pool,
    timer,
    request,
    state,
    query: (params = identity) => request(SESSION_CLEANUP_RECEIPT_METHOD, params),
    receipt: () => manager.cleanupReceipts.query(identity),
    release: () => request("daemon/releaseSession", { sessionId: sessionUuid }),
  };
}

describe("same-daemon cleanup receipts", () => {
  test("advertises the generation; reading an active or expired session never releases it", async () => {
    const h = await harness();
    const capabilities = await h.request("daemon/capabilities", {});
    expect(capabilities.result?.daemonGeneration).toBe(daemonGeneration);
    expect(capabilities.result?.capabilities).toContain(SESSION_CLEANUP_RECEIPT_METHOD);
    h.timer.setCurrentTime(24 * 60 * 60 * 1000);
    expect((await h.query()).result).toEqual({
      ...identity,
      state: "pending",
      reason: "session_active",
    });
    expect(h.pool.getDevice(device.deviceId)?.sessionId).toBe(sessionUuid);
    expect(h.manager.hasSession(sessionUuid)).toBe(true);
  });

  test("deferred restoration stays pending and unavailable until restoration and pool release finish", async () => {
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const h = await harness(async () => {
      started.resolve();
      await finished.promise;
    });
    h.manager.setBiometricEnrollment(sessionUuid, { initialEnrollment: "not_enrolled" });
    const release = h.release();
    await started.promise;
    expect(h.receipt().state).toBe("pending");
    await drainUntil(() => h.timer.getPendingTimeouts().includes(1000), {
      description: "restore deadline registered",
    });
    h.timer.advanceTime(1000);
    expect((await release).success).toBe(true);
    expect((await h.query()).result?.state).toBe("pending");
    expect(h.pool.getStats().idle).toBe(0);
    await expect(
      h.pool.bindOrReuseDeviceSession({
        sessionId: "next",
        deviceId: device.deviceId,
        platform: "ios",
      }),
    ).rejects.toThrow("cleanup");
    finished.resolve();
    await drainUntil(() => h.receipt().state === "succeeded", {
      description: "cleanup and deferred pool release completed",
    });
    expect(h.pool.getDevice(device.deviceId)?.status).toBe("idle");
    expect((await h.query()).result).toEqual(h.receipt());
  });

  test("successful teardown alone is pending until the pool acknowledges the captured release", async () => {
    const h = await harness();
    await h.manager.releaseSession(sessionUuid);
    expect(h.receipt()).toMatchObject({ state: "pending", reason: "pool_release_incomplete" });
    expect(h.pool.getStats().idle).toBe(0);
    await h.pool.releaseDevice(device.deviceId, sessionUuid);
    expect(h.receipt().state).toBe("succeeded");
  });

  test("a teardown deadline cannot turn unfinished restoration into successful completion", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const h = await harness(async () => {
      started.resolve();
      await gate.promise; // Deliberately ignore abort to model an uncancellable device command.
    });
    h.manager.setBiometricEnrollment(sessionUuid, { initialEnrollment: "not_enrolled" });
    const release = h.release();
    await started.promise;
    await drainUntil(() => h.timer.getPendingTimeouts().includes(1000), {
      description: "restore deadline registered",
    });
    await h.timer.advanceTimeAsync(1000);
    await release;
    await h.timer.advanceTimeAsync(SESSION_RELEASE_TEARDOWN_CAP_MS - 1000);
    await drainUntil(() => h.receipt().state === "failed", {
      description: "teardown cap recorded as failure",
    });
    gate.resolve();
    await gate.promise;
    expect((await h.query()).result?.state).toBe("failed");
  });

  test("a lost release reply is recovered by exact read-only query; legacy release remains idempotent", async () => {
    const h = await harness();
    await h.release(); // The caller loses this reply.
    const committed = (await h.query()).result;
    expect(committed?.state).toBe("succeeded");
    expect((await h.release()).result?.alreadyReleased).toBe(true);
    expect((await h.query()).result).toEqual(committed);
    await h.pool.bindOrReuseDeviceSession({
      sessionId: "new-owner",
      deviceId: device.deviceId,
      platform: "ios",
    });
    expect((await h.query()).result).toEqual(committed);
    expect(h.pool.getDevice(device.deviceId)?.sessionId).toBe("new-owner");
  });

  test.each(["app-cleanup", "recording-teardown"] as const)(
    "an ownerless %s mark during an active session cannot produce a succeeded receipt",
    async (reason) => {
      const h = await harness();
      let attempts = 0;
      const retry = async () => {
        attempts++;
        throw new Error("synthetic cleanup failure");
      };
      if (reason === "app-cleanup") {
        h.manager.markDeviceNeedsAppCleanup(device.deviceId, retry, 1000);
      } else {
        h.manager.markDeviceNeedsRecorderTeardown(device.deviceId, retry, 1000);
      }
      await h.manager.releaseSession(sessionUuid);
      await h.pool.releaseDevice(device.deviceId, sessionUuid);
      expect(h.receipt()).toMatchObject({
        state: "failed",
        reason: `restoration_abandoned:${reason}`,
      });
      await h.timer.advanceTimeAsync(1000);
      await drainUntil(() => attempts > 0, { description: "failed health retry dispatched" });
      expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe(reason);
      expect(h.receipt().state).toBe("failed");
    },
  );

  test("restoration rejection remains failed after allSettled and leaves health markers intact", async () => {
    const h = await harness(async () => {
      throw new Error("synthetic restoration failure");
    });
    h.manager.setBiometricEnrollment(sessionUuid, { initialEnrollment: "not_enrolled" });
    await h.release();
    await settleByFakeEvents(h.timer, h.manager.getPendingDeviceCleanup(device.deviceId)!, {
      description: "bounded restoration retries",
    });
    const marker = h.pool.getDeviceHealthMarker(device.deviceId);
    expect(marker?.reason).toBe("biometric-enrollment");
    expect((await h.query()).result?.state).toBe("failed");
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toEqual(marker);
    await expect(
      h.pool.bindOrReuseDeviceSession({
        sessionId: "next",
        deviceId: device.deviceId,
        platform: "ios",
      }),
    ).rejects.toThrow();
  });

  test("concurrent releases share restoration ownership while queries remain read-only", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const h = await harness(async () => {
      calls++;
      started.resolve();
      await gate.promise;
    });
    h.manager.setBiometricEnrollment(sessionUuid, { initialEnrollment: "not_enrolled" });
    const first = h.release();
    await started.promise;
    const second = h.release();
    expect((await h.query()).result?.state).toBe("pending");
    expect(calls).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(h.receipt().state).toBe("succeeded");
  });

  test("caller cancellation does not cancel teardown; the same generation can query it later", async () => {
    const h = await harness();
    h.manager.setBiometricEnrollment(sessionUuid, { initialEnrollment: "not_enrolled" });
    const controller = new AbortController();
    controller.abort();
    await runWithAbortSignal(controller.signal, h.release);
    expect((await h.query()).result?.state).toBe("succeeded");
  });

  test("missing UUID, wrong device, wrong generation, and restarted history are unknown", async () => {
    const h = await harness();
    await h.release();
    for (const params of [
      { ...identity, sessionUuid: device.deviceId },
      { ...identity, deviceId: "different-device" },
      { ...identity, daemonGeneration: "different-generation" },
    ]) {
      expect((await h.query(params)).result?.state).toBe("unknown");
    }
    const missingRelease = await h.request("daemon/releaseSession", { sessionId: device.deviceId });
    expect(missingRelease.result?.alreadyReleased).toBe(true);
    expect((await h.query({ ...identity, sessionUuid: device.deviceId })).result?.state).toBe(
      "unknown",
    );
    h.manager.cleanupReceipts.setGeneration("new-daemon-generation");
    expect(h.receipt().state).toBe("unknown");
    expect(
      (await h.query({ ...identity, daemonGeneration: "new-daemon-generation" })).result?.state,
    ).toBe("unknown");
  });

  test("invalid wire identities fail validation without releasing anything", async () => {
    const h = await harness();
    for (const params of [
      {},
      { ...identity, sessionUuid: "not-a-uuid" },
      { ...identity, deviceId: 2 },
    ]) {
      expect((await h.request(SESSION_CLEANUP_RECEIPT_METHOD, params)).success).toBe(false);
    }
    expect(h.pool.getDevice(device.deviceId)?.sessionId).toBe(sessionUuid);
  });

  test("unverified external cleanup cannot become success merely by fulfilling", async () => {
    const h = await harness();
    h.manager.onSessionRelease((_sessionId, deviceId) => {
      h.manager.registerPendingDeviceCleanup(deviceId, Promise.resolve());
    });
    await h.release();
    expect(h.receipt()).toMatchObject({ state: "unknown", reason: "unverified_external_cleanup" });
  });

  test("external cleanup rejection is failed even though the legacy allSettled join fulfills", async () => {
    const h = await harness();
    h.manager.onSessionRelease((_sessionId, deviceId) => {
      h.manager.registerPendingDeviceCleanup(
        deviceId,
        Promise.reject(new Error("synthetic external cleanup failure")),
      );
    });
    await h.release();
    expect(h.receipt().state).toBe("failed");
  });

  test("a rebind invalidates completion evidence for the original session identity", async () => {
    const h = await harness();
    await h.manager.rebindSession(sessionUuid, device.deviceId, "ios", { force: true });
    await h.release();
    expect(h.receipt()).toMatchObject({ state: "unknown", reason: "session_rebound" });
  });

  test("a nonterminal release cannot attest to a UUID that can be reused", async () => {
    const h = await harness();
    await h.manager.releaseSession(sessionUuid, "plan-auto-release");
    await h.pool.releaseDevice(device.deviceId, sessionUuid);
    expect(h.receipt()).toMatchObject({ state: "unknown", reason: "nonterminal_release" });
  });

  test("an iOS network rule cannot attest to an unjoined renewal", async () => {
    const h = await harness();
    const session = h.manager.getSession(sessionUuid)!;
    const { rule } = h.manager.beginIosAppNetworkRule(session, {
      udid: device.deviceId,
      bundleId: "org.example.synthetic",
    });
    h.manager.confirmIosAppNetworkRule(session, rule);
    await h.release();
    expect(h.receipt()).toMatchObject({ state: "unknown", reason: "network_lease_not_joined" });
  });

  test("an execution still running at release cannot supply a completion receipt", async () => {
    const h = await harness();
    h.manager.setActiveSessionExecutionChecker(() => true);
    await h.release();
    h.manager.setActiveSessionExecutionChecker(() => false);
    expect(h.receipt()).toMatchObject({
      state: "unknown",
      reason: "executions_not_joined_before_release",
    });
  });
});

test.each([
  ["removal", "device_removed"],
  ["incarnation-bump", "device_incarnation_changed"],
] as const)(
  "retiring restorations for %s invalidates the device's receipt",
  async (cause, reason) => {
    const h = await harness();
    h.manager.retireRestorations(device.deviceId, cause);
    await h.release();
    expect(h.receipt()).toMatchObject({ state: "unknown", reason });
    expect(h.pool.getDevice(device.deviceId)?.status).toBe("idle");
  },
);

test("a committed device identity replacement invalidates completion evidence", async () => {
  const h = await harness();
  await h.manager.releaseSession(sessionUuid, "explicit-release", { deviceIdentityReplaced: true });
  await h.pool.releaseDevice(device.deviceId, sessionUuid);
  expect(h.receipt()).toMatchObject({ state: "unknown", reason: "device_identity_replaced" });
});

test("forcing before teardown starts fails immediately and skips restores after the hold ends", async () => {
  let restores = 0;
  const h = await harness(async () => {
    restores++;
  });
  const hold = Promise.withResolvers<"teardown" | "skip-device-writes">();
  h.manager.setBiometricEnrollment(sessionUuid, { initialEnrollment: "not_enrolled" });
  h.manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: 10_000 }));
  const invalidations = spyOn(h.manager.cleanupReceipts, "invalidate");
  try {
    const release = h.manager.releaseSession(sessionUuid);
    expect(h.manager.forceStuckRelease(sessionUuid)?.stage).toBe("awaiting-ownership");
    expect(h.receipt()).toMatchObject({ state: "failed", reason: "release_forced" });
    hold.resolve("teardown");
    await release;
    await h.pool.releaseDevice(device.deviceId, sessionUuid);
    expect(restores).toBe(0);
    expect(invalidations).toHaveBeenCalledWith(sessionUuid, "release_forced");
    expect(h.receipt()).toMatchObject({ state: "failed", reason: "release_forced" });
  } finally {
    invalidations.mockRestore();
  }
});

test("receipt capability is initialized-only and preserves broker capabilities", async () => {
  const h = await harness();
  const request = {
    id: "capabilities",
    type: "daemon_request" as const,
    method: "daemon/capabilities",
    params: {},
  };
  const cold = await handleDaemonRequest(request, { ...h.state, isInitialized: () => false });
  expect(cold.result?.daemonGeneration).toBeUndefined();
  expect(cold.result?.capabilities).not.toContain(SESSION_CLEANUP_RECEIPT_METHOD);
  const broker = await handleDaemonRequest(request, {
    ...h.state,
    isSessionBrokerMode: () => true,
  });
  expect(broker.result?.daemonGeneration).toBe(daemonGeneration);
  expect(broker.result?.capabilities).toContain(SESSION_CLEANUP_RECEIPT_METHOD);
  expect(broker.result?.capabilities).toEqual(
    expect.arrayContaining(cold.result?.capabilities as string[]),
  );
  expect((broker.result?.capabilities as string[]).length).toBe(
    (cold.result?.capabilities as string[]).length + 3,
  );
});

test("a failed keep-awake outcome stays failed after a successful retry without changing release success", async () => {
  const timer = new FakeTimer();
  let attempts = 0;
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
    keepScreenAwakeRestorer: () => ({
      restore: async () =>
        ++attempts === 1
          ? {
              status: "failed",
              failures: [{ setting: "screen_off_timeout", error: "synthetic failure" }],
            }
          : { status: "restored" },
    }),
  });
  managers.push(manager);
  manager.cleanupReceipts.setGeneration(daemonGeneration);
  await manager.createSession(sessionUuid, device.deviceId, "android");
  manager.setKeepScreenAwake(sessionUuid, { applied: true });
  expect(await manager.releaseSession(sessionUuid)).toBe(device.deviceId);
  const pending = manager.getPendingDeviceCleanup(device.deviceId);
  expect(pending).not.toBeNull();
  await settleByFakeEvents(timer, pending!, { description: "successful keep-awake retry" });
  expect(attempts).toBe(2);
  expect(manager.cleanupReceipts.query(identity)).toMatchObject({
    state: "failed",
    reason: "restoration_failed:keep_awake",
  });
});

test("completed history is bounded without evicting pending work, including failed work", async () => {
  const receipts = new SessionCleanupReceipts(1);
  receipts.setGeneration(daemonGeneration);
  const bind = (sessionId: string) => {
    const binding = { sessionId, assignedDevice: device.deviceId, platform: "ios" as const };
    receipts.bind(binding);
    receipts.begin(binding);
    receipts.poolReleased(sessionId, device.deviceId);
    return binding;
  };
  const pending = bind(sessionUuid);
  const gate = Promise.withResolvers<void>();
  receipts.track(sessionUuid, gate.promise);
  receipts.fail(sessionUuid, "synthetic_failure");
  receipts.finish(pending, device.deviceId);
  for (const sessionId of ["completed-a", "completed-b"]) {
    const binding = bind(sessionId);
    receipts.finish(binding, device.deviceId);
  }
  expect(receipts.query(identity).state).toBe("failed");
  expect(receipts.query({ ...identity, sessionUuid: "completed-a" }).state).toBe("unknown");
  gate.resolve();
  await gate.promise;
  const last = bind("completed-c");
  receipts.finish(last, device.deviceId);
  expect(receipts.query(identity).state).toBe("unknown");
});

test.each(["failed", "unknown"] as const)(
  "settled %s pool releases also have bounded history",
  (outcome) => {
    const receipts = new SessionCleanupReceipts(1);
    receipts.setGeneration(daemonGeneration);
    for (const sessionId of [sessionUuid, "another-session"]) {
      const binding = { sessionId, assignedDevice: device.deviceId, platform: "ios" as const };
      receipts.bind(binding);
      receipts.begin(binding);
      receipts.finish(binding, device.deviceId);
      if (outcome === "failed") {
        receipts.poolReleaseFailed(sessionId);
      } else {
        receipts.poolReleaseUnconfirmed(sessionId);
      }
      expect(receipts.query({ ...identity, sessionUuid: sessionId }).state).toBe(outcome);
    }
    expect(receipts.query(identity)).toMatchObject({
      state: "unknown",
      reason: "no_matching_history",
    });
  },
);

function receiptStore(completed = 256, uncompleted = 1024, tombstones = 4096) {
  const receipts = new SessionCleanupReceipts(completed, uncompleted, tombstones);
  receipts.setGeneration(daemonGeneration);
  const bind = (sessionId = sessionUuid, platform: "ios" | "android" = "ios") => {
    const binding = { sessionId, assignedDevice: device.deviceId, platform };
    receipts.bind(binding);
    return binding;
  };
  const query = (sessionId = sessionUuid) =>
    receipts.query({ ...identity, sessionUuid: sessionId });
  const complete = (binding: ReturnType<typeof bind>) => {
    receipts.begin(binding);
    receipts.poolReleased(binding.sessionId, device.deviceId);
    receipts.finish(binding, device.deviceId);
  };
  return { receipts, bind, query, complete };
}

test("F1: a forced biometric cap and health recovery cannot contaminate the next owner", async () => {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const h = await harness(async () => {
    started.resolve();
    await gate.promise;
  });
  h.manager.setBiometricEnrollment(sessionUuid, { initialEnrollment: "not_enrolled" });
  const release = h.release();
  await started.promise;
  await forceStuckSessionRelease(h.manager, h.pool, sessionUuid);
  await h.timer.advanceTimeAsync(1000);
  await release;
  await h.pool.bindOrReuseDeviceSession({
    sessionId: "next-owner",
    deviceId: device.deviceId,
    platform: "ios",
  });
  await h.timer.advanceTimeAsync(SESSION_RELEASE_TEARDOWN_CAP_MS - 1000);
  const nextIdentity = { ...identity, sessionUuid: "next-owner" };
  expect(h.manager.cleanupReceipts.query(nextIdentity)).toMatchObject({
    state: "pending",
    reason: "session_active",
  });
  await h.manager.releaseSession("next-owner");
  await h.pool.releaseDevice(device.deviceId, "next-owner");
  expect(h.manager.cleanupReceipts.query(nextIdentity).state).toBe("succeeded");
  expect(h.receipt()).toMatchObject({ state: "failed", reason: "release_forced" });
  gate.resolve();
});

test("F1: device hooks ignore active owners and session hooks never target a releasing successor", async () => {
  const h = receiptStore();
  const old = h.bind();
  h.receipts.begin(old);
  const next = h.bind("next");
  const gate = Promise.withResolvers<void>();
  h.receipts.trackDevice(device.deviceId, gate.promise);
  h.receipts.failDevice(device.deviceId, "old_failure");
  h.receipts.invalidateDevice(device.deviceId, "old_identity");
  expect(h.query("next")).toMatchObject({ state: "pending", reason: "session_active" });
  h.receipts.begin(next);
  h.receipts.track(sessionUuid, gate.promise);
  h.receipts.fail(sessionUuid, "restoration_abandoned:biometric-enrollment");
  h.receipts.poolReleased("next", device.deviceId);
  h.receipts.finish(next, device.deviceId);
  expect(h.query("next").state).toBe("succeeded");
  gate.resolve();
  await gate.promise;
});

test.each(["device-killed", "finish-null", "failed-no-pool"] as const)(
  "F2: %s without a pool leg enters bounded completed history",
  (path) => {
    const h = receiptStore(1);
    const binding = h.bind();
    h.receipts.begin(binding);
    if (path === "device-killed") {
      h.receipts.invalidate(sessionUuid, "device_removed");
    }
    if (path === "failed-no-pool") {
      h.receipts.fail(sessionUuid, "release_failed");
    }
    h.receipts.finish(binding, path === "device-killed" ? device.deviceId : null);
    h.complete(h.bind("new"));
    expect(h.query()).toMatchObject({ state: "unknown", reason: "no_matching_history" });
  },
);

test("F2: unknown with wedged work completes, while the hard cap evicts only settled non-active releases", async () => {
  const h = receiptStore(1, 2);
  h.bind("active");
  const gate = Promise.withResolvers<void>();
  for (const sessionId of ["unknown", "wedged-a", "wedged-b", "wedged-c"]) {
    const binding = h.bind(sessionId);
    h.receipts.begin(binding);
    h.receipts.track(sessionId, gate.promise);
    if (sessionId === "unknown") {
      h.receipts.invalidate(sessionId, "unverified_external_cleanup");
    } else {
      h.receipts.fail(sessionId, "cleanup_rejected");
    }
    h.receipts.finish(binding, device.deviceId);
  }
  expect(h.query("wedged-a").reason).toBe("no_matching_history");
  expect(h.query("wedged-b").state).toBe("failed");
  expect(h.query("active").reason).toBe("session_active");
  h.complete(h.bind("completed"));
  expect(h.query("unknown").reason).toBe("no_matching_history");
  gate.resolve();
  await gate.promise;
  expect(h.query("wedged-a").reason).toBe("no_matching_history");
});

test.each(["succeeded", "failed", "unknown"] as const)(
  "F3: completed %s receipts are immutable under every late hook",
  async (state) => {
    const h = receiptStore();
    const binding = h.bind();
    h.receipts.begin(binding);
    if (state === "failed") {
      h.receipts.fail(sessionUuid, "cleanup_rejected");
    }
    if (state === "unknown") {
      h.receipts.invalidate(sessionUuid, "nonterminal_release");
    }
    h.receipts.poolReleased(sessionUuid, device.deviceId);
    h.receipts.finish(binding, device.deviceId);
    const completed = h.query();
    const work = Promise.reject(new Error("late work"));
    void work.catch(() => {}); // The late caller owns this rejected work; the receipt is frozen.
    h.receipts.fail(sessionUuid, "late_failure");
    h.receipts.invalidate(sessionUuid, "late_identity");
    h.receipts.poolReleaseFailed(sessionUuid);
    h.receipts.poolReleaseUnconfirmed(sessionUuid);
    h.receipts.track(sessionUuid, work);
    h.receipts.trackDevice(device.deviceId, work, true);
    h.receipts.failDevice(device.deviceId, "late_failure");
    h.receipts.invalidateDevice(device.deviceId, "late_identity");
    h.receipts.begin(binding, { terminal: false });
    h.receipts.finish(binding, null);
    h.receipts.poolReleased(sessionUuid, device.deviceId);
    await work.catch(() => {});
    expect(h.query()).toEqual(completed);
  },
);

test("F4: evicted UUIDs remain unqualified within FIFO tombstones, reset only by generation", () => {
  const h = receiptStore(1, 2, 3);
  h.complete(h.bind());
  h.complete(h.bind("second"));
  expect(h.query().reason).toBe("no_matching_history");
  const reused = h.bind();
  h.complete(reused);
  expect(h.query()).toMatchObject({ state: "unknown", reason: "recovered_or_reused_session" });
  h.complete(h.bind("third"));
  h.complete(h.bind("fourth"));
  h.complete(h.bind());
  expect(h.query().state).toBe("succeeded");
  h.receipts.setGeneration("new-generation");
  h.complete(h.bind("fourth"));
  expect(
    h.receipts.query({ ...identity, sessionUuid: "fourth", daemonGeneration: "new-generation" })
      .state,
  ).toBe("succeeded");
});

test.each(["app", "recorder"] as const)(
  "F5: %s health failure stays sticky after recovery",
  async (kind) => {
    const h = await harness();
    let retries = 0;
    const retry = async () => {
      retries++;
    };
    h.manager.onSessionRelease(() => {
      if (kind === "app") {
        h.manager.markDeviceNeedsAppCleanup(device.deviceId, retry, 1000);
      } else {
        h.manager.markDeviceNeedsRecorderTeardown(
          device.deviceId,
          retry,
          1000,
          "synthetic",
          sessionUuid,
        );
      }
    });
    await h.release();
    await h.timer.advanceTimeAsync(1000);
    await drainUntil(() => retries > 0, { description: "health recovery attempted" });
    expect(h.receipt()).toMatchObject({
      state: "failed",
      reason: `restoration_abandoned:${kind === "app" ? "app-cleanup" : "recording-teardown"}`,
    });
  },
);

test("F5: registering external cleanup mid-session is unqualified and tracked once", async () => {
  const h = await harness();
  const track = spyOn(h.manager.cleanupReceipts, "track");
  const work = Promise.resolve();
  try {
    h.manager.registerPendingDeviceCleanup(device.deviceId, work);
    expect(track.mock.calls.filter(([, promise]) => promise === work)).toHaveLength(1);
    expect(h.receipt()).toMatchObject({ state: "unknown", reason: "unverified_external_cleanup" });
    await h.release();
    expect(h.receipt().state).toBe("unknown");
  } finally {
    track.mockRestore();
  }
});

test("F1: abandoned-baseline retries do not attach work to a later releasing session", async () => {
  const h = receiptStore();
  const binding = h.bind("later");
  h.receipts.begin(binding);
  const timer = new FakeTimer();
  const gate = Promise.withResolvers<void>();
  const trackDevice = spyOn(h.receipts, "trackDevice");
  const queued = new QueuedDeviceStateRestore(
    {
      cleanupReceipts: h.receipts,
      timer,
      healthIncarnation: () => 1,
      clearHealthMarker: () => {},
      restoreGeneration: () => 0,
      dispatchDeviceRestore: (_deviceId, restore, _generation, _step, owner) => {
        const signal = new AbortController().signal;
        const work = restore(signal, signal, () => {});
        if (owner) {
          h.receipts.trackOwner(owner, work);
        }
        return work;
      },
      restoreIncarnationIsCurrent: () => true,
      clearRestoreHealth: () => {},
      markHealth: () => {},
      hasIdentityReplacementFence: () => false,
      trackSessionSetup: (_session, setup) => setup(),
      isPublished: () => true,
      trackPendingDeviceCleanup: () => {},
    },
    {
      screenReader: () => ({ restore: async () => {} }),
      screenReaderBackoff: { delayForAttempt: () => 1 },
      rotation: () => ({ restore: async () => {} }),
      rotationBackoff: { delayForAttempt: () => 1 },
      clock: () => ({ restore: async () => {} }),
    },
  );
  try {
    const retry = queued.retryAbandonedRestore(
      {
        memory: new Map([[device.deviceId, {}]]),
        inFlight: new Map(),
        timeoutMs: 1000,
        label: "old baseline",
        restore: () => gate.promise,
        restored: () => {},
        failed: () => {},
      },
      device.deviceId,
    );
    h.receipts.poolReleased("later", device.deviceId);
    h.receipts.finish(binding, device.deviceId);
    expect(h.query("later").state).toBe("succeeded");
    expect(trackDevice).not.toHaveBeenCalled();
    gate.resolve();
    await retry;
  } finally {
    trackDevice.mockRestore();
  }
});

test("F6: documented retention bounds and immutable completion match the receipt contract", () => {
  const doc = readFileSync(
    new URL("../../docs/using/session-cleanup-receipts.md", import.meta.url),
    "utf8",
  );
  for (const limit of [
    COMPLETED_CLEANUP_RECEIPT_LIMIT,
    UNCOMPLETED_CLEANUP_RECEIPT_LIMIT,
    CLEANUP_RECEIPT_TOMBSTONE_LIMIT,
  ]) {
    expect(doc).toContain(String(limit));
  }
  expect(doc).toContain("Completed receipts are immutable");
  expect(doc).toContain("Neither reports restoration failure");
  expect(doc).toContain("releaseSessionAndDevice");
});

test("F2: a replaced deferred pool release settles its original receipt as unconfirmed", async () => {
  const h = await harness();
  await h.manager.releaseSession(sessionUuid);
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const pending = spyOn(h.manager, "getPendingDeviceCleanup");
  try {
    pending.mockReturnValue(first.promise);
    await h.pool.releaseDevice(device.deviceId, sessionUuid);
    const pooled = h.pool.getDevice(device.deviceId)!;
    bindDevice(pooled, "replacement");
    pooled.assignmentCount++;
    const replacement = {
      sessionId: "replacement",
      assignedDevice: device.deviceId,
      platform: "ios" as const,
    };
    h.manager.cleanupReceipts.bind(replacement);
    h.manager.cleanupReceipts.begin(replacement);
    h.manager.cleanupReceipts.finish(replacement, device.deviceId);
    pending.mockReturnValue(second.promise);
    await h.pool.releaseDevice(device.deviceId, "replacement");
    first.resolve();
    await drainUntil(() => h.receipt().state === "unknown", {
      description: "replaced deferred release acknowledged",
    });
    expect(h.receipt().reason).toBe("pool_ownership_changed");
    pending.mockReturnValue(null);
    second.resolve();
    await drainUntil(
      () =>
        h.manager.cleanupReceipts.query({ ...identity, sessionUuid: "replacement" }).state ===
        "succeeded",
      { description: "replacement pool release acknowledged" },
    );
  } finally {
    pending.mockRestore();
  }
});
