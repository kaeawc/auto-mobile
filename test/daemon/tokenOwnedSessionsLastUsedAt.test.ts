import { describe, expect, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
} from "../../src/daemon/constants";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11117: the token-owned sessions answer crosses to the proxy, which compares lastUsedAt with its
// own wall clock, so it must be wall-clock epoch ms even after a wall step.

const SESSION = "token-owned-session";
const TOKEN = "stable-token";

describe("daemon/tokenOwnedSessions lastUsedAt", () => {
  test("is reported in wall-clock ms after a backward wall step", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SESSION, "emulator-5554", "android", 600_000);
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    const call = (method: string, params: Record<string, unknown>) =>
      handleDaemonRequest({ id: "r", type: "daemon_request", method, params }, state);
    try {
      await call(DAEMON_HEARTBEAT_METHOD, {
        sessionId: SESSION,
        livenessOwnerToken: TOKEN,
        claimLivenessOwnership: true,
      });
      timer.advanceTime(10_000);
      sessionManager.recordToolCallEnded(SESSION);
      timer.stepWallClock(-3_600_000);

      const response = await call(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, {
        livenessOwnerToken: TOKEN,
      });
      const { sessions } = (response as { result: { sessions: Array<{ lastUsedAt: number }> } })
        .result;
      const lastUsedAt = sessions[0].lastUsedAt;

      const stamp = sessionManager.getSession(SESSION)!.lastUsedAt;
      expect(lastUsedAt).toBe(sessionManager.sessionClockToWall(stamp));
      // A wall step back must not leave the reported instant ahead of the proxy's wall clock.
      expect(lastUsedAt).toBeLessThanOrEqual(timer.now());
      expect(lastUsedAt).not.toBe(stamp);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });
});
