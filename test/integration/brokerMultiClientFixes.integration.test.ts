/** Multi-client regressions over real broker/handler/session code; native I/O is entirely fake. */
import { afterEach, beforeAll, expect, test } from "bun:test";
import { renderClientRequest } from "../../scripts/manual-test/brokerBatch";
import {
  handlePrepareBrokerSession,
  handleReleaseBrokerSession,
} from "../../src/daemon/sessionBroker/handlers";
import { BrokerSessions, type BrokerSessionsPort } from "../../src/daemon/proxy/BrokerSessions";
import { BROKER_EXECUTION_RELEASE_TIMEOUT_MS } from "../../src/daemon/sessionBroker/provisioning/executionLiveness";
import type { SessionReleaseOptions } from "../../src/daemon/sessionManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { createFakeBrokerDaemon } from "../helpers/fakeBrokerDaemon";
import { acquire, connect, deviceOf, type Host } from "../helpers/brokerMultiClient";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const A = { name: "client-a", token: "token-a" };
const B = { name: "client-b", token: "token-b" };
const C = { name: "client-c", token: "token-c" };
const hosts: Host[] = [];
beforeAll(async () => {
  // Keep first-open SQLite/schema initialization outside each scenario's 100 ms budget.
  const warm = await createFakeBrokerDaemon();
  try {
    await acquire(warm, A, 0);
  } finally {
    await warm.close();
  }
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});
async function open(capacity = 2) {
  const host = await createFakeBrokerDaemon({
    capacity,
    liveDisposition: true,
    brokerOnFakeTimer: true,
  });
  hosts.push(host);
  return host;
}
function releaseRequest(sessionId: string, replyBudgetMs: number) {
  return {
    id: `release-${sessionId}`,
    type: "daemon_request" as const,
    method: "daemon/releaseBrokerSession",
    params: { sessionId, livenessOwnerToken: A.token, replyBudgetMs },
  };
}

test("cancelled RPC receipts require a new request id while other clients retain their grants", async () => {
  const host = await open(3);
  const b = await acquire(host, B, 1);
  const c = await acquire(host, C, 1);
  for (const [client, grant] of [
    [B, b],
    [C, c],
  ] as const) {
    expect((await connect(host, client, grant))?.success).toBe(true);
  }
  const beforeB = await host.client.status(b.config.requestId, B.token);
  const beforeC = await host.client.status(c.config.requestId, C.token);
  const paused = await host.controls.pausePreparation();
  const config = renderClientRequest({ name: A.name, platform: "ios" }, "a-cancelled");
  const abort = new AbortController();
  const pending = handlePrepareBrokerSession(
    {
      id: "prepare-a",
      type: "daemon_request",
      method: "daemon/prepareBrokerSession",
      params: { config, livenessOwnerToken: A.token },
    },
    host.state,
    abort.signal,
    "a-cancelled-socket",
  );
  await paused.entered;
  abort.abort(new Error("Client RPC cancelled"));
  const first = await pending;
  expect(paused.joined()).toBe(true);
  expect(first).toMatchObject({
    success: true,
    result: {
      outcome: "failed",
      cleanupPending: false,
      failure: { code: "cancelled", retryable: true, retryRequires: "new_request_id" },
    },
  });
  const replay = await host.prepare(config, A.token);
  expect(first).toEqual({ success: true, result: { ...replay } });
  expect(await host.client.status(config.requestId, A.token)).toEqual(replay);
  const a = await acquire(host, A, 2);
  expect((await connect(host, A, a))?.success).toBe(true);
  expect(new Set([a, b, c].map((grant) => deviceOf(host, grant.sessionUuid))).size).toBe(3);
  expect(await host.client.status(b.config.requestId, B.token)).toEqual(beforeB);
  expect(await host.client.status(c.config.requestId, C.token)).toEqual(beforeC);
});

test("bounded release keeps capacity occupied until cleanup joins, then replays a terminal receipt", async () => {
  const host = await open();
  const a = await acquire(host, A, 1);
  const b = await acquire(host, B, 1);
  expect((await connect(host, A, a))?.success).toBe(true);
  expect((await connect(host, B, b))?.success).toBe(true);
  const beforeB = await host.client.status(b.config.requestId, B.token);
  const drain = Promise.withResolvers<void>();
  host.devices.releaseHook = () => drain.promise;
  try {
    const request = releaseRequest(a.sessionUuid, 10);
    const releasing = handleReleaseBrokerSession(request, host.state);
    await drainUntilQuiescent(host.timer);
    host.timer.advanceTime(9);
    let answered = false;
    void releasing.then(() => {
      answered = true;
    });
    await drainUntilQuiescent(host.timer);
    expect(answered).toBe(false);
    host.timer.advanceTime(1);
    await drainUntilQuiescent(host.timer);
    expect(answered).toBe(true);
    expect(await releasing).toEqual({
      success: true,
      result: { sessionUuid: a.sessionUuid, outcome: "cleanup_pending" },
    });
    expect(await host.client.status(a.config.requestId, A.token)).toMatchObject({
      outcome: "pending",
      cleanupPending: true,
    });
    const blocked = await host.prepare(
      renderClientRequest({ name: C.name, platform: "ios" }, "c-blocked"),
      C.token,
    );
    expect(blocked).toMatchObject({ outcome: "failed", failure: { code: "capacity_exhausted" } });
    expect(await host.client.status(b.config.requestId, B.token)).toEqual(beforeB);
    host.devices.releaseHook = undefined;
    drain.resolve();
    await host.broker.joinReleases();
    const terminal = await host.client.status(a.config.requestId, A.token);
    expect(terminal).toMatchObject({ outcome: "released", cleanupPending: false });
    expect(await handleReleaseBrokerSession(request, host.state)).toMatchObject({
      success: true,
      result: { sessionUuid: a.sessionUuid, outcome: "released" },
    });
    // Both reads use the broker's persisted receipt, so replay must preserve timing exactly too.
    expect(await host.prepare(a.config, A.token)).toEqual(terminal!);
    const c = await acquire(host, C, 2);
    expect((await connect(host, C, c))?.success).toBe(true);
    expect(deviceOf(host, c.sessionUuid)).not.toBe(deviceOf(host, b.sessionUuid));
    expect(await host.client.status(b.config.requestId, B.token)).toEqual(beforeB);
  } finally {
    host.devices.releaseHook = undefined;
    drain.resolve();
    await host.broker.joinReleases();
  }
});

test("proxy final retry with 50ms left gets the real daemon reply before its transport deadline", async () => {
  const host = await open(3);
  const a = await acquire(host, A, 1);
  const b = await acquire(host, B, 1);
  const c = await acquire(host, C, 1);
  for (const [client, grant] of [
    [A, a],
    [B, b],
    [C, c],
  ] as const) {
    expect((await connect(host, client, grant))?.success).toBe(true);
  }
  const drain = Promise.withResolvers<void>();
  const calls: Array<{ replyBudgetMs: number; timeoutMs: number }> = [];
  const responses: unknown[] = [];
  class ReleaseClient extends FakeDaemonClient {
    override async callDaemonMethod(
      ...[method, params, options]: Parameters<FakeDaemonClient["callDaemonMethod"]>
    ): Promise<unknown> {
      expect(method).toBe("daemon/releaseBrokerSession");
      calls.push({
        replyBudgetMs: Number(params.replyBudgetMs),
        timeoutMs: options?.timeoutMs ?? 0,
      });
      if (calls.length === 1) {
        return {
          code: "session_restart_handoff_pending",
          retryable: true,
          retryAfterMs: BROKER_EXECUTION_RELEASE_TIMEOUT_MS - 50,
        };
      }
      const reply = await handleReleaseBrokerSession(
        { id: "proxy-release", type: "daemon_request", method, params },
        host.state,
      );
      expect(reply.success).toBe(true);
      responses.push(reply.result);
      return reply.result;
    }
  }
  const client = new ReleaseClient();
  let bound: string | undefined;
  const port: BrokerSessionsPort = {
    ensureConnected: async () => {},
    requireClient: () => client,
    client: () => client,
    isClosing: () => false,
    boundSessionUuid: () => bound,
    terminalBoundSessionUuid: () => undefined,
    bindStartupSession: (uuid) => {
      bound = uuid;
    },
    establishBoundSessionHeartbeat: async () => {},
    fenceBoundSession: () => {},
    forgetBoundSession: () => {
      bound = undefined;
    },
  };
  const proxy = new BrokerSessions({ port, timer: host.timer, livenessOwnerToken: A.token });
  await proxy.hold(a.config.requestId, a.sessionUuid);
  host.devices.releaseHook = () => drain.promise;
  try {
    const pending = proxy.releaseAll();
    await drainUntilQuiescent(host.timer);
    host.timer.advanceTime(BROKER_EXECUTION_RELEASE_TIMEOUT_MS - 50);
    await drainUntilQuiescent(host.timer);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ replyBudgetMs: 25, timeoutMs: 50 });
    expect(calls[1]!.replyBudgetMs).toBeLessThan(calls[1]!.timeoutMs);
    host.timer.advanceTime(25);
    await pending;
    expect(responses).toEqual([{ sessionUuid: a.sessionUuid, outcome: "cleanup_pending" }]);
    expect(proxy.heldBinding()).toBeUndefined();
    expect(await host.broker.hasActiveSession(b.sessionUuid)).toBe(true);
    expect(await host.broker.hasActiveSession(c.sessionUuid)).toBe(true);
    expect(host.timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    host.devices.releaseHook = undefined;
    drain.resolve();
    await host.broker.joinReleases();
  }
});

test("stale expectedOwner cannot release a successor incarnation or leak controls to listeners", async () => {
  const host = await open(3);
  const a = await acquire(host, A, 1);
  const b = await acquire(host, B, 1);
  const c = await acquire(host, C, 1);
  for (const [client, grant] of [
    [A, a],
    [B, b],
    [C, c],
  ] as const) {
    expect((await connect(host, client, grant))?.success).toBe(true);
  }
  const manager = host.sessions;
  const old = manager.getSession(a.sessionUuid)!;
  const deviceId = deviceOf(host, a.sessionUuid);
  await manager.releaseSession(a.sessionUuid, "allocation-rollback");
  // Same UUID and device, new object: the strongest incarnation fence, used by resumed clients.
  const successor = await manager.createSession(a.sessionUuid, deviceId, "ios");
  manager.bindAcquiredLivenessOwnerToken(a.sessionUuid, A.token);
  const seen: Array<{ uuid: string; options: SessionReleaseOptions }> = [];
  manager.onSessionRelease((uuid, _device, _reason, { snapshot: _snapshot, ...options }) => {
    seen.push({ uuid, options });
  });
  expect(
    await manager.releaseSession(a.sessionUuid, "allocation-rollback", {
      expectedOwner: { session: old, deviceId },
      allowExpired: true,
      commitFence: () => true,
    }),
  ).toBeNull();
  expect(manager.getSession(a.sessionUuid)).toBe(successor);
  expect(manager.getSessionForDevice(deviceId)).toBe(a.sessionUuid);
  expect(seen).toEqual([]);
  expect(
    await manager.releaseSession(a.sessionUuid, "explicit-release", {
      expectedOwner: { session: successor, deviceId },
      allowExpired: true,
      commitFence: () => true,
      deviceIdentityReplaced: true,
    }),
  ).toBe(deviceId);
  expect(seen).toEqual([{ uuid: a.sessionUuid, options: { deviceIdentityReplaced: true } }]);
  expect(manager.getSession(a.sessionUuid)).toBeNull();
  expect(manager.getSession(b.sessionUuid)).not.toBeNull();
  expect(manager.getSession(c.sessionUuid)).not.toBeNull();
});
