import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
  SessionManager,
  getCliSessionIdleTimeoutMs,
} from "../../src/daemon/sessionManager";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DAEMON_HEARTBEAT_METHOD, CLI_SESSION_LIVENESS_POLICY } from "../../src/daemon/constants";
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

/**
 * Issue #6870: every `--cli` invocation is its own process, so it cannot hold
 * the 10 s heartbeat liveness contract between calls — an agent that spends
 * 12 s reading the previous result loses its session to `heartbeat-timeout`.
 * A CLI-owned session opts into a wall-clock idle timeout measured in minutes
 * instead. Non-CLI (stdio/HTTP MCP) sessions keep the 10 s contract.
 */
describe("CLI-owned session liveness (#6870)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;

  beforeEach(() => {
    clearEnv();
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
    clearEnv();
  });

  const monitorWith = (
    reaped: Array<{ sessionId: string; reason: string }>,
  ): SessionHeartbeatMonitor =>
    new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
      },
      timer,
    );

  it("defaults a freshly created session to the heartbeat liveness policy", async () => {
    const session = await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
    expect(session.livenessPolicy).toBe("heartbeat");
  });

  it("adoptCliLivenessPolicy switches a session to the minutes-long idle timeout", async () => {
    await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);

    expect(sessionManager.adoptCliLivenessPolicy("s1")).toBe(true);

    const session = sessionManager.getSession("s1")!;
    expect(session.livenessPolicy).toBe("cli-idle");
    expect(session.heartbeatTimeoutMs).toBe(DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS);
    expect(session.hasReceivedHeartbeat).toBe(true);
  });

  it("adoptCliLivenessPolicy reports an unknown session instead of throwing", () => {
    expect(sessionManager.adoptCliLivenessPolicy("nope")).toBe(false);
  });

  it("survives the agent think-time that kills a default-policy session", async () => {
    await sessionManager.createSession("cli", "emulator-5554", "android", 30 * 60_000);
    await sessionManager.createSession("mcp", "emulator-5556", "android", 30 * 60_000);
    sessionManager.adoptCliLivenessPolicy("cli");
    sessionManager.recordHeartbeat("mcp");

    const reaped: Array<{ sessionId: string; reason: string }> = [];
    const monitor = monitorWith(reaped);

    // The 12.4 s gap from the issue report.
    timer.advanceTime(12_367);
    await monitor.tick();

    expect(reaped).toEqual([{ sessionId: "mcp", reason: "heartbeat-timeout" }]);
  });

  it("never reaps a CLI session for a missing first heartbeat", async () => {
    await sessionManager.createSession("cli", "emulator-5554", "android", 30 * 60_000);
    sessionManager.adoptCliLivenessPolicy("cli");

    const reaped: Array<{ sessionId: string; reason: string }> = [];
    const monitor = monitorWith(reaped);

    timer.advanceTime(60_000);
    await monitor.tick();

    expect(reaped).toEqual([]);
  });

  it("reaps a CLI session once it is idle past the CLI idle timeout", async () => {
    await sessionManager.createSession("cli", "emulator-5554", "android", 30 * 60_000);
    sessionManager.adoptCliLivenessPolicy("cli");

    const reaped: Array<{ sessionId: string; reason: string }> = [];
    const monitor = monitorWith(reaped);

    timer.advanceTime(DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS - 1);
    await monitor.tick();
    expect(reaped).toEqual([]);

    timer.advanceTime(2);
    await monitor.tick();
    expect(reaped).toEqual([{ sessionId: "cli", reason: "cli-idle-timeout" }]);
  });

  it("honours an explicit CLI idle timeout override", () => {
    process.env.AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS = "120000";
    expect(getCliSessionIdleTimeoutMs()).toBe(120_000);
  });

  it("falls back to the default when the override is not a positive integer", () => {
    process.env.AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS = "not-a-number";
    expect(getCliSessionIdleTimeoutMs()).toBe(DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS);
  });

  describe("daemon/heartbeat livenessPolicy parameter", () => {
    const stateFor = (manager: SessionManager): any => ({
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
        releaseDevice: async () => {},
      }),
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    });

    it("adopts the CLI policy when the client declares it", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);

      const response = await handleDaemonRequest(
        {
          id: "1",
          type: "daemon_request",
          method: DAEMON_HEARTBEAT_METHOD,
          params: { sessionId: "s1", livenessPolicy: CLI_SESSION_LIVENESS_POLICY },
        },
        stateFor(sessionManager),
      );

      expect(response.success).toBe(true);
      expect(response.result?.livenessPolicy).toBe("cli-idle");
      expect(sessionManager.getSession("s1")!.livenessPolicy).toBe("cli-idle");
    });

    it("leaves the heartbeat policy alone for a plain heartbeat", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);

      const response = await handleDaemonRequest(
        {
          id: "1",
          type: "daemon_request",
          method: DAEMON_HEARTBEAT_METHOD,
          params: { sessionId: "s1" },
        },
        stateFor(sessionManager),
      );

      expect(response.success).toBe(true);
      expect(sessionManager.getSession("s1")!.livenessPolicy).toBe("heartbeat");
      expect(sessionManager.getSession("s1")!.hasReceivedHeartbeat).toBe(true);
    });
  });
});
