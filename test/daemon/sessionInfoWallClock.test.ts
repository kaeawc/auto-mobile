import { describe, expect, test } from "bun:test";
import { DAEMON_REGISTER_SESSION_METHOD } from "../../src/daemon/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11243: instants a daemon reports to another process are wall-clock epoch ms, as #11105/#11117
// made the other session reports; the session clock parts from the wall clock after a wall step.

const SESSION = "6f0f4a52-7a1e-4c38-9b1b-3a5a8f7f2a10";
const WALL_STEP_MS = -3_600_000;

async function steppedDaemon() {
  const timer = new FakeTimer();
  timer.setCurrentTime(10_000_000);
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  manager.stopCleanupTimer();
  await manager.createSession(SESSION, "emulator-5554", "android", 600_000);
  timer.advanceTime(5_000);
  timer.stepWallClock(WALL_STEP_MS);
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
    }),
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
  const call = (method: string, params: Record<string, unknown>) =>
    handleDaemonRequest({ id: "r", type: "daemon_request", method, params }, state);
  return { timer, manager, call };
}

describe("session reports in wall-clock ms after a wall step (#11243)", () => {
  test("daemon/sessionInfo createdAt, lastUsedAt and expiresAt", async () => {
    const { manager, call } = await steppedDaemon();
    const session = manager.getSession(SESSION)!;

    const response = await call("daemon/sessionInfo", { sessionId: SESSION });
    const result = response.result as { createdAt: number; lastUsedAt: number; expiresAt: number };

    expect(result.createdAt).toBe(manager.sessionClockToWall(session.createdAt));
    expect(result.lastUsedAt).toBe(manager.sessionClockToWall(session.lastUsedAt));
    expect(result.expiresAt).toBe(manager.sessionClockToWall(session.expiresAt));
    expect(result.createdAt).toBe(session.createdAt + WALL_STEP_MS);
  });

  test("daemon/registerSession expiresAtMs for a session that already holds a device", async () => {
    const { manager, call } = await steppedDaemon();
    const session = manager.getSession(SESSION)!;

    const response = await call(DAEMON_REGISTER_SESSION_METHOD, {
      sessionId: SESSION,
      clientName: "observer",
    });
    const { expiresAtMs } = response.result as { expiresAtMs: number };

    expect(expiresAtMs).toBe(
      manager.sessionClockToWall(session.lastHeartbeat + session.heartbeatTimeoutMs),
    );
    expect(expiresAtMs).toBe(session.lastHeartbeat + session.heartbeatTimeoutMs + WALL_STEP_MS);
  });
});
