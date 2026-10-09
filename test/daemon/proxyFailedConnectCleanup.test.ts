import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../../src/features/toolSelection/toolSelectionControl";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11117: a connect that fails after the client is connected (the presentation profile is
// rejected) must close that client instead of orphaning its daemon socket.

const SESSION = "startup-bound-session";
const PROFILE_RESPONSE = JSON.stringify({ sessionUuid: "profile-1", scope: "connection-profile" });

describe("proxy failed partial connect", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let state: DaemonStateAccess;

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SESSION, "emulator-5554", "android", 60_000);
    state = {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  });

  afterEach(() => {
    isAvailableSpy.mockRestore();
    sessionManager.stopCleanupTimer();
  });

  function proxyWith(clients: FakeDaemonClient[], failProfile: () => boolean): DaemonMcpProxy {
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    return new DaemonMcpProxy({
      initialSessionUuid: SESSION,
      livenessOwnerToken: "startup-token",
      daemonOptions: { enabledTools: ["observe"] },
      clientFactory: () => {
        const client = new FakeDaemonClient({
          toolResultFor: (toolName) =>
            toolName === SET_TOOL_ENABLED_TOOL_NAME && failProfile()
              ? { isError: true, content: [{ type: "text", text: "rejected" }] }
              : toolName === SET_TOOL_ENABLED_TOOL_NAME
                ? { content: [{ type: "text", text: PROFILE_RESPONSE }] }
                : undefined,
          onCallDaemonMethod: async (method, params) => {
            const response = await handleDaemonRequest(
              { id: "r", type: "daemon_request", method, params },
              state,
            );
            if (!response.success) {
              throw Object.assign(new Error(response.error), { code: response.code });
            }
          },
        });
        clients.push(client);
        return client;
      },
      daemonManager: manager,
      autoStartDaemon: false,
      timer,
    });
  }

  test("closes every failed attempt's client and a later connect claims the startup session", async () => {
    const clients: FakeDaemonClient[] = [];
    let failing = true;
    const proxy = proxyWith(clients, () => failing);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await proxy.claimInitialSession().catch(() => undefined);
      }
      expect(clients.length).toBeGreaterThan(0);
      expect(clients.filter((client) => client.isConnected())).toEqual([]);
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBeUndefined();

      failing = false;
      await proxy.claimInitialSession();

      expect(clients.filter((client) => client.isConnected())).toHaveLength(1);
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("startup-token");
    } finally {
      await proxy.close();
    }
  });
});
