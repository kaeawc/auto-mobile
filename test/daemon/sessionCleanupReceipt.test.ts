import { afterEach, describe, expect, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DevicePool } from "../../src/daemon/devicePool";
import { SESSION_RELEASE_TEARDOWN_CAP_MS, SessionManager } from "../../src/daemon/sessionManager";
import {
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
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({ restore }),
    () => ({ restore }),
    {
      networkCondition: () => ({ restore }),
      clock: () => ({ restore }),
      iosAppNetworkRule: { reset: async () => {}, renew: async () => "renewed" },
    },
  );
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
  await pool.bindOrReuseDeviceSession(sessionUuid, device.deviceId, "ios");
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
    await expect(h.pool.bindOrReuseDeviceSession("next", device.deviceId, "ios")).rejects.toThrow(
      "cleanup",
    );
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
    await h.pool.bindOrReuseDeviceSession("new-owner", device.deviceId, "ios");
    expect((await h.query()).result).toEqual(committed);
    expect(h.pool.getDevice(device.deviceId)?.sessionId).toBe("new-owner");
  });

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
    await expect(h.pool.bindOrReuseDeviceSession("next", device.deviceId, "ios")).rejects.toThrow();
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

test("a swallowed keep-awake failure is exposed to the receipt without changing release success", async () => {
  const manager = new SessionManager(
    new FakeTimer(),
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({ restore: async () => false }),
  );
  managers.push(manager);
  manager.cleanupReceipts.setGeneration(daemonGeneration);
  await manager.createSession(sessionUuid, device.deviceId, "android");
  manager.setKeepScreenAwake(sessionUuid, { applied: true });
  expect(await manager.releaseSession(sessionUuid)).toBe(device.deviceId);
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
