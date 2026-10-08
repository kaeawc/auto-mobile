/**
 * Reproduction for hypothesis H15 ("HTTP POST /heartbeat bypasses the #10050 owner gate").
 *
 * The socket `daemon/heartbeat` handler (src/daemon/daemonRequestHandlers.ts handleHeartbeat)
 * refuses a TOKENLESS heartbeat as a liveness no-op once a token-bearing owner has claimed the
 * session. The HTTP route (src/daemon/daemon.ts handleHeartbeatHttpRequest) checks only that the
 * session exists and is not releasing, then calls `sessionManager.recordHeartbeat(sessionId)`,
 * which advances `lastOwnerHeartbeat` (the owner lease), `lastHeartbeat` and `expiresAt` for any
 * caller (src/daemon/sessionManager.ts recordHeartbeat, "the handler admits one only from the
 * owner"). A leaked tokenless HTTP heartbeater (e.g. the junit-runner DaemonHeartbeat thread)
 * therefore holds a proxy-owned session and its device indefinitely after the proxy is gone, and
 * makes every new owner's claim conflict.
 *
 * Real production code driven: Daemon HTTP request routing + handleHeartbeatHttpRequest (via an
 * injected http server factory), handleDaemonRequest's daemon/heartbeat (claim + tokenless tick),
 * SessionManager (createSession, claimLivenessOwnership, recordHeartbeat, owner lease), the real
 * SessionHeartbeatMonitor reaping decision, and livenessOwnerLease.
 * Faked: the node http server/request/response objects, time (FakeTimer), persistence
 * (FakeDeviceSessionPersistence via releasingSessionHarness), the DB write barrier
 * (FakeDbWriteBarrier), and the device pool (releasingSessionHarness's stub). No real DB.
 */
import { EventEmitter } from "node:events";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import { describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { DAEMON_LIVENESS_OWNER_CONFLICT_CODE } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  releasingSessionHarness,
  releasingSessionId as sessionId,
} from "../helpers/releasingSessionHarness";

const port = 41399;
const PROXY_A = "proxy-a-owner-token";
const PROXY_B = "proxy-b-owner-token";

class FakeRequest extends EventEmitter {
  method = "POST";
  url = "/heartbeat";
  constructor(readonly headers: IncomingHttpHeaders) {
    super();
  }
}

class FakeResponse extends EventEmitter {
  body = "";
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly finished: Promise<void>;
  private finish!: () => void;
  constructor() {
    super();
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  setHeader(): this {
    return this;
  }
  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  end(body?: string): this {
    this.body = body ?? "";
    this.writableEnded = true;
    this.emit("finish");
    this.finish();
    return this;
  }
}

class FakeHttpServer extends EventEmitter {
  requestTimeout = 0;
  headersTimeout = 0;
  timeout = 0;
  listen(_port: number, _host: string, callback: () => void): this {
    queueMicrotask(callback);
    return this;
  }
  /** What the junit-runner DaemonHeartbeat.sendHeartbeat sends: `{ sessionId }`, no token. */
  postHeartbeat(id: string): Promise<FakeResponse> {
    const request = new FakeRequest({ host: `127.0.0.1:${port}` });
    const response = new FakeResponse();
    this.emit(
      "request",
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );
    queueMicrotask(() => {
      request.emit("data", Buffer.from(JSON.stringify({ sessionId: id })));
      request.emit("end");
    });
    return response.finished.then(() => response);
  }
}

async function startHttpDaemon(manager: SessionManager): Promise<FakeHttpServer> {
  const server = new FakeHttpServer();
  const daemon = new Daemon(
    { port, host: "127.0.0.1" },
    undefined,
    new FakeTimer(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => server as unknown as HttpServer,
  );
  const internals = daemon as unknown as {
    sessionManager: SessionManager;
    startHttpServer(): Promise<void>;
  };
  internals.sessionManager = manager;
  await internals.startHttpServer();
  return server;
}

/** The stdio proxy's socket heartbeat, as DaemonMcpProxy sends it (token + optional claim). */
function socketHeartbeat(
  h: ReturnType<typeof releasingSessionHarness>,
  params: Record<string, unknown>,
) {
  return handleDaemonRequest(
    {
      id: "hb",
      type: "daemon_request",
      method: "daemon/heartbeat",
      params: { sessionId, ...params },
    },
    h.state,
  );
}

describe("H15: HTTP /heartbeat bypasses the liveness owner gate", () => {
  test("a tokenless HTTP heartbeat renews a dead proxy's owner lease; a new proxy's claim conflicts", async () => {
    const h = releasingSessionHarness();
    try {
      const session = await h.create();
      const server = await startHttpDaemon(h.manager);

      // Proxy A claims the session over the socket, exactly as DaemonMcpProxy does.
      const claimA = await socketHeartbeat(h, {
        livenessOwnerToken: PROXY_A,
        claimLivenessOwnership: true,
        livenessPolicy: "heartbeat",
      });
      expect(claimA.success).toBe(true);
      expect(session.livenessOwnerToken).toBe(PROXY_A);

      // Proxy A dies. Its lease and the suspect grace both run out.
      h.timer.advanceTime(session.heartbeatTimeoutMs + SUSPECT_GRACE_MS + 1);
      const lapsedOwnerStamp = session.lastOwnerHeartbeat;
      expect(h.manager.getSessionLeaseState(sessionId)?.phase).toBe("lapsed");

      // Control: the SOCKET route already treats a tokenless heartbeat as a liveness no-op here.
      const tokenlessSocket = await socketHeartbeat(h, {});
      expect(tokenlessSocket.success).toBe(true);
      expect(session.lastOwnerHeartbeat).toBe(lapsedOwnerStamp);
      expect(h.manager.getSessionLeaseState(sessionId)?.phase).toBe("lapsed");

      // The HTTP route does not: a leaked tokenless heartbeater renews the owner lease.
      const http = await server.postHeartbeat(sessionId);
      expect(http.statusCode).toBe(200);
      // CURRENT (gap): owner lease, activity clock and idle expiry all advanced to "now".
      expect(session.lastOwnerHeartbeat).toBe(h.timer.now());
      expect(session.lastHeartbeat).toBe(h.timer.now());
      expect(session.expiresAt).toBe(h.timer.now() + session.sessionTimeoutMs);
      expect(h.manager.getSessionLeaseState(sessionId)?.phase).toBe("live");
      expect(session.livenessOwnerToken).toBe(PROXY_A);

      // A fresh proxy B (the user's restarted harness) cannot take the session over.
      const claimB = await socketHeartbeat(h, {
        livenessOwnerToken: PROXY_B,
        claimLivenessOwnership: true,
        livenessPolicy: "heartbeat",
      });
      // CURRENT (gap):
      expect(claimB.success).toBe(false);
      expect((claimB as { code?: string }).code).toBe(DAEMON_LIVENESS_OWNER_CONFLICT_CODE);
      expect(session.livenessOwnerToken).toBe(PROXY_A);
      // AFTER FIX: the HTTP heartbeat is a liveness no-op on a token-owned session (or 409s), so
      //   expect(session.lastOwnerHeartbeat).toBe(lapsedOwnerStamp);
      //   expect(h.manager.getSessionLeaseState(sessionId)?.phase).toBe("lapsed");
      //   expect(claimB.success).toBe(true);
      //   expect(session.livenessOwnerToken).toBe(PROXY_B);
    } finally {
      h.dispose();
    }
  });

  test("a leaked HTTP heartbeater holds a dead proxy's session and device for an hour", async () => {
    const h = releasingSessionHarness();
    try {
      const session = await h.create();
      const server = await startHttpDaemon(h.manager);
      const reaped: Array<[string, string]> = [];
      // The daemon wires the real monitor exactly like this (daemon.ts startHeartbeatMonitor).
      const monitor = new SessionHeartbeatMonitor(
        h.manager,
        () => false,
        async (id, reason) => {
          reaped.push([id, reason]);
        },
        h.timer,
        { checkIntervalMs: 10_000 },
      );

      const claimA = await socketHeartbeat(h, {
        livenessOwnerToken: PROXY_A,
        claimLivenessOwnership: true,
        livenessPolicy: "heartbeat",
      });
      expect(claimA.success).toBe(true);
      // Proxy A sends no more heartbeats from here on (crashed / disconnected).

      // Baseline: with no one else heartbeating, the reaper releases A's session after lease+grace.
      h.timer.advanceTime(session.heartbeatTimeoutMs + SUSPECT_GRACE_MS + 1);
      // (Inspect only; do not let it release, so the same session can show the hold.)
      const probe = new SessionHeartbeatMonitor(
        h.manager,
        () => false,
        async (id, reason) => {
          reaped.push([`probe:${id}`, reason]);
        },
        h.timer,
      );
      await probe.tick();
      expect(reaped).toEqual([[`probe:${sessionId}`, "heartbeat-timeout"]]);
      reaped.length = 0;

      // A leaked tokenless HTTP heartbeater (junit-runner thread / IDE JVM / script) keeps posting.
      // Simulated at a 10 s cadence for one hour, with the real monitor scanning every interval.
      const HOUR_MS = 60 * 60 * 1000;
      const start = h.timer.now();
      while (h.timer.now() - start < HOUR_MS) {
        const response = await server.postHeartbeat(sessionId);
        expect(response.statusCode).toBe(200);
        h.timer.advanceTime(10_000);
        await monitor.tick();
      }

      // CURRENT (gap): an hour later, nothing has been released and proxy A still "owns" it.
      expect(reaped).toEqual([]);
      expect(h.manager.getSession(sessionId)).toBe(session);
      expect(session.livenessOwnerToken).toBe(PROXY_A);
      expect(session.assignedDevice).toBe("emulator-5554");
      expect(h.manager.getSessionLeaseState(sessionId)?.phase).toBe("live");
      // AFTER FIX: the HTTP posts no longer renew lastHeartbeat/expiresAt on a token-owned
      // session, so the first scan releases it (idle expiry via cleanupExpiredSessions, or a
      // "heartbeat-timeout" reap) and later HTTP posts answer 404:
      //   expect(h.manager.getSession(sessionId)).toBeNull();
      // (Verified by temporarily gating recordHeartbeat in handleHeartbeatHttpRequest on
      // `session.livenessOwnerToken === undefined && !session.livenessOwnershipClaims?.size`:
      // this test then fails with a 404 inside the loop, and test 1 fails on lastOwnerHeartbeat.)
    } finally {
      h.dispose();
    }
  });
});
