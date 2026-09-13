import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  runCliCommand,
  setDaemonProxyFactoryForTesting,
  resetDaemonProxyFactoryForTesting,
} from "../../src/cli";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  CLI_SESSION_LIVENESS_POLICY,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_VERSION,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
} from "../../src/daemon/constants";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

const ENV_KEYS = [
  "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
  "AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
  "AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

/** Minimal daemon state so a fake client can answer through the real handler. */
function daemonStateFor(manager: SessionManager): any {
  return {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
}

function deviceStartResult(sessionUuid: string): {
  content: Array<{ type: string; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify({ sessionUuid }) }] };
}

/**
 * Issue #6870: a `--cli` invocation is a one-shot process. It cannot hold the
 * 10 s heartbeat contract across an agent's think-time, so it declares its
 * session CLI-owned before exiting and the daemon switches that session to a
 * wall-clock idle timeout.
 */
describe("--cli declares its session CLI-owned (#6870)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let isAvailableSpy: ReturnType<typeof spyOn> | null;

  beforeEach(() => {
    clearEnv();
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
    isAvailableSpy?.mockRestore();
    isAvailableSpy = null;
    resetDaemonProxyFactoryForTesting();
    clearEnv();
  });

  const proxyOver = (client: FakeDaemonClient): DaemonMcpProxy =>
    new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

  test("adoptCliSessionLiveness declares the policy for a result-minted session", async () => {
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult("minted") : undefined),
      onCallDaemonMethod: async (method, params) => {
        if (method === DAEMON_HEARTBEAT_METHOD && typeof params.sessionId === "string") {
          if (params.livenessPolicy === CLI_SESSION_LIVENESS_POLICY) {
            sessionManager.adoptCliLivenessPolicy(params.sessionId);
          } else {
            sessionManager.recordHeartbeat(params.sessionId);
          }
        }
      },
    });
    await sessionManager.createSession("minted", "emulator-5554", "android", 30 * 60_000);
    const proxy = proxyOver(client);

    try {
      await proxy.callTool("getAndroid", {});
      expect(await proxy.adoptCliSessionLiveness()).toBe("minted");
    } finally {
      await proxy.close();
    }

    expect(
      client.callDaemonMethodCalls.filter(
        (call) =>
          call.method === DAEMON_HEARTBEAT_METHOD &&
          call.params.livenessPolicy === CLI_SESSION_LIVENESS_POLICY,
      ),
    ).toHaveLength(1);
    expect(sessionManager.getSession("minted")?.livenessPolicy).toBe("cli-idle");
  });

  test("the declared session outlives the think-time that reaps a heartbeat session", async () => {
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult("minted") : undefined),
      onCallDaemonMethod: async (method, params) => {
        if (method === DAEMON_HEARTBEAT_METHOD && typeof params.sessionId === "string") {
          if (params.livenessPolicy === CLI_SESSION_LIVENESS_POLICY) {
            sessionManager.adoptCliLivenessPolicy(params.sessionId);
          } else {
            sessionManager.recordHeartbeat(params.sessionId);
          }
        }
      },
    });
    await sessionManager.createSession("minted", "emulator-5554", "android", 30 * 60_000);
    const reaped: Array<{ sessionId: string; reason: string }> = [];
    const monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
      },
      timer,
    );
    const proxy = proxyOver(client);
    try {
      await proxy.callTool("getAndroid", {});
      await proxy.adoptCliSessionLiveness();
    } finally {
      // The `--cli` process exits: no client is left to heartbeat.
      await proxy.close();
    }

    timer.advanceTime(12_367);
    await monitor.tick();

    expect(reaped).toEqual([]);
    expect(sessionManager.getSession("minted")).not.toBeNull();
  });

  test("ordinary bound-session heartbeats declare the strict policy", async () => {
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult("minted") : undefined),
    });
    const proxy = proxyOver(client);
    try {
      await proxy.callTool("getAndroid", {});
    } finally {
      await proxy.close();
    }

    const heartbeats = client.callDaemonMethodCalls.filter(
      (call) => call.method === DAEMON_HEARTBEAT_METHOD,
    );
    expect(heartbeats.length).toBeGreaterThan(0);
    for (const heartbeat of heartbeats) {
      expect(heartbeat.params.livenessPolicy).toBe(HEARTBEAT_SESSION_LIVENESS_POLICY);
    }
  });

  test("a long-lived client takes a CLI-adopted session back to the strict contract", async () => {
    // CLI → proxy takeover (#6870 review): a previous one-shot invocation left
    // this session on the minutes-long idle window. A long-lived stdio/HTTP
    // client now owns the UUID and CAN keep the 10 s contract, so its ordinary
    // heartbeats must restore it — otherwise the session holds its device for
    // the whole idle window after that client disconnects.
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult("shared") : undefined),
      onCallDaemonMethod: async (method, params) => {
        await handleDaemonRequest(
          { id: "1", type: "daemon_request", method, params },
          daemonStateFor(sessionManager),
        );
      },
    });
    await sessionManager.createSession("shared", "emulator-5554", "android", 30 * 60_000);
    sessionManager.adoptCliLivenessPolicy("shared");
    expect(sessionManager.getSession("shared")!.livenessPolicy).toBe("cli-idle");

    const proxy = proxyOver(client);
    try {
      await proxy.callTool("getAndroid", {});
    } finally {
      await proxy.close();
    }

    const session = sessionManager.getSession("shared")!;
    expect(session.livenessPolicy).toBe("heartbeat");
    expect(session.heartbeatTimeoutMs).toBe(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS);

    // ... and the restored session is reaped on the strict timeout once that
    // long-lived client is gone, instead of squatting the device for minutes.
    const reaped: Array<{ sessionId: string; reason: string }> = [];
    const monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
      },
      timer,
    );
    timer.advanceTime(12_367);
    await monitor.tick();
    expect(reaped).toEqual([{ sessionId: "shared", reason: "heartbeat-timeout" }]);
  });

  test("a CLI touch of a proxy-owned session re-adopts the CLI policy", async () => {
    // proxy → CLI touch, the other direction: the restore above must not make
    // the CLI declaration unable to win back the session it is about to own.
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult("shared") : undefined),
      onCallDaemonMethod: async (method, params) => {
        await handleDaemonRequest(
          { id: "1", type: "daemon_request", method, params },
          daemonStateFor(sessionManager),
        );
      },
    });
    await sessionManager.createSession("shared", "emulator-5554", "android", 30 * 60_000);
    const proxy = proxyOver(client);

    try {
      await proxy.callTool("getAndroid", {});
      expect(sessionManager.getSession("shared")!.livenessPolicy).toBe("heartbeat");
      expect(await proxy.adoptCliSessionLiveness()).toBe("shared");
    } finally {
      await proxy.close();
    }

    expect(sessionManager.getSession("shared")!.livenessPolicy).toBe("cli-idle");
  });

  test("heartbeats after the declaration keep the CLI marker", async () => {
    // The keeper is still running when the declaration lands; a tick racing
    // process exit must not restore the strict contract the invocation just
    // opted out of (#6870 review).
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult("shared") : undefined),
      onCallDaemonMethod: async (method, params) => {
        await handleDaemonRequest(
          { id: "1", type: "daemon_request", method, params },
          daemonStateFor(sessionManager),
        );
      },
    });
    await sessionManager.createSession("shared", "emulator-5554", "android", 30 * 60_000);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
      heartbeatIntervalMs: 1_000,
    });

    try {
      await proxy.callTool("getAndroid", {});
      await proxy.adoptCliSessionLiveness();
      await timer.advanceTimeAsync(1_000);
    } finally {
      await proxy.close();
    }

    const lastHeartbeat = client.callDaemonMethodCalls
      .filter((call) => call.method === DAEMON_HEARTBEAT_METHOD)
      .at(-1);
    expect(lastHeartbeat?.params.livenessPolicy).toBe(CLI_SESSION_LIVENESS_POLICY);
    expect(sessionManager.getSession("shared")!.livenessPolicy).toBe("cli-idle");
  });

  test("the declaration carries this invocation's idle-timeout override", async () => {
    // The daemon resolved its own env at startup and this invocation reuses it,
    // so the override only takes effect if it travels on the wire (#6870 review).
    process.env.AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS = "120000";
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult("shared") : undefined),
      onCallDaemonMethod: async (method, params) => {
        await handleDaemonRequest(
          { id: "1", type: "daemon_request", method, params },
          daemonStateFor(sessionManager),
        );
      },
    });
    await sessionManager.createSession("shared", "emulator-5554", "android", 30 * 60_000);
    const proxy = proxyOver(client);

    try {
      await proxy.callTool("getAndroid", {});
      await proxy.adoptCliSessionLiveness();
    } finally {
      await proxy.close();
    }

    const declaration = client.callDaemonMethodCalls.find(
      (call) => call.params.livenessPolicy === CLI_SESSION_LIVENESS_POLICY,
    );
    expect(declaration?.params.idleTimeoutMs).toBe(120_000);
    expect(sessionManager.getSession("shared")!.heartbeatTimeoutMs).toBe(120_000);
  });

  test("adoptCliSessionLiveness is a no-op with no bound session", async () => {
    const client = new FakeDaemonClient();
    const proxy = proxyOver(client);
    try {
      await proxy.callTool("listDevices", {});
      expect(await proxy.adoptCliSessionLiveness()).toBeUndefined();
    } finally {
      await proxy.close();
    }
    expect(client.callDaemonMethodCalls.map((call) => call.method)).not.toContain(
      DAEMON_HEARTBEAT_METHOD,
    );
  });

  test("a failed declaration never fails the CLI invocation", async () => {
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult("minted") : undefined),
      onCallDaemonMethod: (method, params) => {
        if (method === DAEMON_HEARTBEAT_METHOD && params.livenessPolicy) {
          throw new Error("daemon went away");
        }
      },
    });
    const proxy = proxyOver(client);
    try {
      await proxy.callTool("getAndroid", {});
      expect(await proxy.adoptCliSessionLiveness()).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });

  test("declares the policy for a joined session whose tool returned an error envelope", async () => {
    // A failed interaction tool answers with a NORMAL MCP error envelope
    // (isError: true), not a rejection. The handler still ran against the
    // forwarded session, so that session is live and this one-shot process owns
    // it — without binding it, the adoption below is a no-op and the next
    // invocation loses the session to the 10 s heartbeat policy (#6870).
    const client = new FakeDaemonClient({
      toolResultFor: (name) =>
        name === "tapOn"
          ? { content: [{ type: "text", text: "No element matched the selector" }], isError: true }
          : undefined,
      onCallDaemonMethod: async (method, params) => {
        if (method === DAEMON_HEARTBEAT_METHOD && typeof params.sessionId === "string") {
          if (params.livenessPolicy === CLI_SESSION_LIVENESS_POLICY) {
            sessionManager.adoptCliLivenessPolicy(params.sessionId);
          } else {
            sessionManager.recordHeartbeat(params.sessionId);
          }
        }
      },
    });
    await sessionManager.createSession("joined", "emulator-5554", "android", 30 * 60_000);
    const proxy = proxyOver(client);

    try {
      const result = await proxy.callTool("tapOn", { sessionUuid: "joined" });
      expect(result.isError).toBe(true);
      expect(await proxy.adoptCliSessionLiveness()).toBe("joined");
    } finally {
      await proxy.close();
    }

    expect(sessionManager.getSession("joined")?.livenessPolicy).toBe("cli-idle");
  });

  test("does not adopt a session the error envelope declares lost", async () => {
    // `session_ownership_lost` rides the SAME isError envelope shape. The named
    // session is gone, so binding it would resurrect a dead session and
    // heartbeat it; leave the connection unbound instead.
    const client = new FakeDaemonClient({
      toolResultFor: (name) =>
        name === "tapOn"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: {
                      code: "session_ownership_lost",
                      message: "Session ownership lost for joined: reaped.",
                      sessionUuid: "joined",
                      retryable: true,
                    },
                  }),
                },
              ],
              isError: true,
            }
          : undefined,
    });
    const proxy = proxyOver(client);

    try {
      await proxy.callTool("tapOn", { sessionUuid: "joined" });
      expect(await proxy.adoptCliSessionLiveness()).toBeUndefined();
    } finally {
      await proxy.close();
    }

    expect(
      client.callDaemonMethodCalls.filter((call) => call.method === DAEMON_HEARTBEAT_METHOD),
    ).toHaveLength(0);
  });

  test("runCliCommand declares the policy once per invocation", async () => {
    const declarations: number[] = [];
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (): Promise<any> => ({ success: true }),
      adoptCliSessionLiveness: async (): Promise<string | undefined> => {
        declarations.push(1);
        return "session-abc";
      },
      close: async (): Promise<void> => {},
    }));

    await runCliCommand(["--session-uuid", "session-abc", "observe"]);

    expect(declarations).toHaveLength(1);
  });

  test("runCliCommand still declares the policy when the tool call throws", async () => {
    const declarations: number[] = [];
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (): Promise<any> => {
        throw new Error("tool blew up");
      },
      adoptCliSessionLiveness: async (): Promise<string | undefined> => {
        declarations.push(1);
        return undefined;
      },
      close: async (): Promise<void> => {},
    }));

    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runCliCommand(["--session-uuid", "session-abc", "observe"]);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(declarations).toHaveLength(1);
  });
});
