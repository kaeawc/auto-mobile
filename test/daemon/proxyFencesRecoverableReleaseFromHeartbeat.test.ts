import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { isRecoverableDaemonReleaseReason } from "../../src/daemon/releaseReasons";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// Hunt 2026-10-10. A session released for a daemon-side handoff (`device-restart:<id>`,
// `daemon-shutdown`, `daemon-restart`) is recoverable: the UUID is not fenced and the owner's next
// tool call restores it. The proxy's release-notification path knows this ("a recoverable daemon
// release needs a replacement transport, not a UUID fence"). Its heartbeat path does not: the
// daemon answers the keeper's heartbeat with not-found plus the recorded `releaseReason`
// (#10730), and since #10972 the proxy fences the binding on ANY reason, on the assumption that a
// daemon that recorded a reason "is not a replacement daemon that may still restore it". A keeper
// tick that lands while the device is restarting therefore ends a session the daemon would have
// handed back, and the agent's next call is refused without ever reaching the daemon.

const SESSION = "hunt-recoverable-session";
const DEVICE = "emulator-5554";
const RECOVERABLE_REASON = `device-restart:${DEVICE}`;
const OWNER_TOKEN = "hunt-recoverable-owner";
const INTERVAL_MS = 2_000;

describe("a keeper heartbeat answered not-found for a recoverable release", () => {
  describe("daemon: what the heartbeat is answered", () => {
    let timer: FakeTimer;
    let sessionManager: SessionManager;

    beforeEach(() => {
      timer = new FakeTimer();
      sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    });

    afterEach(() => {
      sessionManager.stopCleanupTimer();
    });

    function state(): DaemonStateAccess {
      return {
        isInitialized: () => true,
        getSessionManager: () => sessionManager,
        getDevicePool: () => ({
          refreshDevices: async () => 0,
          getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
        }),
        getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
      };
    }

    function heartbeat(claim = false) {
      return handleDaemonRequest(
        {
          id: "heartbeat",
          type: "daemon_request",
          method: "daemon/heartbeat",
          params: {
            sessionId: SESSION,
            livenessOwnerToken: OWNER_TOKEN,
            ...(claim ? { claimLivenessOwnership: true } : {}),
          },
        },
        state(),
      );
    }

    // Not a failing assertion: it pins the premise the proxy test below builds on.
    test("premise: the answer names the recoverable reason, and the next call restores the session", async () => {
      await sessionManager.createSession(SESSION, DEVICE, "android");
      expect((await heartbeat(true)).success).toBe(true);

      await sessionManager.releaseSession(SESSION, RECOVERABLE_REASON);

      expect(isRecoverableDaemonReleaseReason(RECOVERABLE_REASON)).toBe(true);
      expect(await heartbeat()).toMatchObject({
        success: false,
        code: DAEMON_SESSION_NOT_FOUND_CODE,
        releaseReason: RECOVERABLE_REASON,
      });
      // The UUID is not terminal: a call naming it is admitted to restart recovery (a terminal
      // UUID is refused here), and the session comes back under the same UUID.
      expect(sessionManager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
      await sessionManager.admitIssuedSessionForAutomation(SESSION);
      await expect(sessionManager.createSession(SESSION, DEVICE, "android")).resolves.toMatchObject(
        { sessionId: SESSION, assignedDevice: DEVICE },
      );
      expect((await heartbeat()).success).toBe(true);
    });
  });

  describe("proxy: what it does with that answer", () => {
    let timer: FakeTimer;
    let client: FakeDaemonClient;
    let proxy: DaemonMcpProxy;
    let restarting: boolean;
    let isAvailableSpy: ReturnType<typeof spyOn>;
    let warnSpy: ReturnType<typeof spyOn>;
    let infoSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      timer = new FakeTimer();
      restarting = false;
      client = new FakeDaemonClient({
        toolResultFor: (name) =>
          name === "getAndroid"
            ? {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ runtime: { session: { sessionUuid: SESSION } } }),
                  },
                ],
              }
            : undefined,
        onCallDaemonMethod: (method, params) => {
          if (method === "daemon/heartbeat" && restarting && params.sessionId === SESSION) {
            // Exactly the daemon's answer pinned by the premise test above.
            throw Object.assign(new Error(`Session not found: ${SESSION}`), {
              code: DAEMON_SESSION_NOT_FOUND_CODE,
              releaseReason: RECOVERABLE_REASON,
            });
          }
        },
      });
      isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      infoSpy = spyOn(logger, "info").mockImplementation(() => {});
      const daemonManager = new FakeDaemonManager();
      daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
      proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager,
        autoStartDaemon: false,
        timer,
        idGenerator: new FakeIdGenerator(),
        heartbeatTimeoutMs: 4_000,
        heartbeatIntervalMs: INTERVAL_MS,
      });
    });

    afterEach(async () => {
      await proxy.close();
      isAvailableSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    test("a first heartbeat answered with the recoverable reason leaves the new session usable", async () => {
      // The device restarts between the acquisition's answer and the session's first heartbeat.
      restarting = true;
      await proxy.callTool("getAndroid", {});
      restarting = false;

      await expect(proxy.callTool("observe", { sessionUuid: SESSION })).resolves.toBeDefined();

      // The call reached the restored session, so the keeper heartbeats it again.
      const heartbeats = (): number =>
        client.callDaemonMethodCalls.filter((call) => call.method === "daemon/heartbeat").length;
      const before = heartbeats();
      await timer.advanceTimeAsync(INTERVAL_MS * 2);
      expect(heartbeats()).toBeGreaterThan(before);
    });

    // Whether or not the release notification arrived first: when it did, the proxy preserved
    // the binding "so the next call/heartbeat can reclaim it", and the heartbeat then fences it.
    for (const notification of ["delivered", "missed"] as const) {
      test(`the next tool call still reaches the daemon, which restores the session (release notification ${notification})`, async () => {
        await proxy.callTool("getAndroid", {});
        await timer.advanceTimeAsync(INTERVAL_MS * 2);

        // The device restarts: the daemon releases the session as a recoverable handoff and the
        // keeper's next heartbeats are answered not-found with that reason.
        restarting = true;
        if (notification === "delivered") {
          client.emitNotification(
            SESSION_RELEASED_NOTIFICATION_METHOD,
            SESSION,
            RECOVERABLE_REASON,
          );
        }
        await timer.advanceTimeAsync(INTERVAL_MS * 2);
        // The device is back; the daemon restores the session on the owner's next call.
        restarting = false;

        const outcome = await proxy.callTool("observe", { sessionUuid: SESSION }).then(
          () => "forwarded",
          (error: unknown) => `refused by the proxy: ${(error as Error).message}`,
        );

        expect(outcome).toBe("forwarded");
        expect(client.callToolCalls.map((call) => call.toolName)).toEqual([
          "getAndroid",
          "observe",
        ]);
      });
    }
  });
});
