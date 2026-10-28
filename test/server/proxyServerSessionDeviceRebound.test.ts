import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { DaemonClient } from "../../src/daemon/client/client";
import {
  SESSION_DEVICE_META_KEY,
  withRoutedSessionMeta,
  withSessionDeviceMeta,
} from "../../src/daemon/routedSessionMeta";
import {
  SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
  type SessionDeviceRebound,
} from "../../src/daemon/sessionDeviceReboundBroadcast";
import type { DaemonNotification } from "../../src/daemon/types";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

const SESSION = "11111111-2222-4333-8444-555555555555";
const binding = {
  sessionUuid: SESSION,
  deviceId: "emulator-5560",
  previousDeviceId: "emulator-5554",
  stableDeviceId: "Pixel",
  generation: 1,
};
const event = {
  sessionId: SESSION,
  deviceId: binding.deviceId,
  previousDeviceId: binding.previousDeviceId,
  stableDeviceId: "Pixel",
  avdName: "Pixel",
  generation: 1,
};

async function harness() {
  const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  const daemon = new FakeDaemonClient({
    toolResult: withSessionDeviceMeta(
      withRoutedSessionMeta(
        { content: [{ type: "text", text: "ok" }], _meta: { unrelated: "kept" } },
        SESSION,
      ),
      binding,
    ),
  });
  const subscribe = spyOn(daemon, "onNotification");
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: {
      timer: new FakeTimer(),
      clientFactory: () => daemon,
      daemonManager: manager,
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
      initialSessionUuid: SESSION,
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rebound-client", version: "1" });
  const messages: unknown[] = [];
  client.setNotificationHandler("notifications/message", (notification) => {
    messages.push(notification.params);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await proxy.ensureConnected();
  return {
    client,
    proxy,
    server,
    messages,
    warning,
    push(frame: DaemonNotification) {
      const listener = subscribe.mock.calls.at(-1)?.[0];
      if (!listener) {
        throw new Error("Missing notification subscription");
      }
      listener(frame);
    },
    async close() {
      await client.close();
      await server.close();
      await proxy.close();
      subscribe.mockRestore();
      available.mockRestore();
      warning.mockRestore();
    },
  };
}

describe("client-visible recovery evidence through the proxy", () => {
  beforeAll(async () => {
    const warm = await harness();
    try {
      await warm.client.callTool({ name: "tapOn", arguments: {} });
    } finally {
      await warm.close();
    }
  });

  test("daemon result metadata reaches the MCP client unchanged", async () => {
    const h = await harness();
    try {
      const result = await h.client.callTool({ name: "tapOn", arguments: {} });
      expect(result._meta).toEqual({
        unrelated: "kept",
        "automobile/routedSessionUuid": SESSION,
        [SESSION_DEVICE_META_KEY]: binding,
      });
    } finally {
      await h.close();
    }
  });

  test("held rebind emits the info logging payload; unrelated and unsubscribed sessions are ignored", async () => {
    const h = await harness();
    const seen: SessionDeviceRebound[] = [];
    const stop = h.proxy.onSessionDeviceRebound((value) => {
      seen.push(value);
    });
    try {
      h.push({
        type: "daemon_notification",
        method: SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
        ...event,
        sessionId: "foreign",
      });
      expect(seen).toHaveLength(0);
      h.push({
        type: "daemon_notification",
        method: SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
        ...event,
        sessionId: `${SESSION}:second`,
      });
      expect(seen).toEqual([{ ...event, sessionId: `${SESSION}:second` }]);
      seen.length = 0;
      await h.client.ping();
      h.messages.length = 0;
      h.push({
        type: "daemon_notification",
        method: SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
        ...event,
      });
      // A request/response drains earlier notifications without sleeping on wall time.
      await h.client.ping();
      expect(seen).toEqual([event]);
      expect(h.messages).toEqual([
        {
          level: "info",
          logger: "auto-mobile.liveness",
          data: {
            code: "session_device_rebound",
            sessionUuid: SESSION,
            previousDeviceId: binding.previousDeviceId,
            deviceId: binding.deviceId,
            avdName: "Pixel",
            stableDeviceId: "Pixel",
            generation: 1,
          },
        },
      ]);
      stop();
      h.push({
        type: "daemon_notification",
        method: SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
        ...event,
      });
      expect(seen).toHaveLength(1);
    } finally {
      stop();
      await h.close();
    }
  });

  test.each(["owned", "other-held", "claimable"] as const)(
    "forwards %s sessions and isolates a throwing listener",
    async (holder) => {
      const h = await harness();
      const internals = h.proxy.getInternalsForTesting();
      if (holder === "owned") {
        internals.ownedDeviceSessions.add("held");
      }
      if (holder === "other-held") {
        internals.otherHeldSessions.set("held", { claimSent: true, lastUsedAt: 0 });
      }
      if (holder === "claimable") {
        internals.sessionState.claimableSessions.add("held");
      }
      const seen: SessionDeviceRebound[] = [];
      const stopBad = h.proxy.onSessionDeviceRebound(() => {
        throw new Error("broken");
      });
      const stop = h.proxy.onSessionDeviceRebound((value) => {
        seen.push(value);
      });
      try {
        h.push({
          type: "daemon_notification",
          method: SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
          ...event,
          sessionId: "held",
        });
        expect(seen).toEqual([{ ...event, sessionId: "held" }]);
        expect(h.warning).toHaveBeenCalled();
      } finally {
        stop();
        stopBad();
        await h.close();
      }
    },
  );

  test("logging failure is best-effort and server close removes its listener", async () => {
    const h = await harness();
    const send = spyOn(h.server.server, "sendLoggingMessage").mockRejectedValue(
      new Error("closed transport"),
    );
    try {
      h.push({
        type: "daemon_notification",
        method: SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
        ...event,
      });
      await h.client.ping();
      expect(h.warning).toHaveBeenCalled();
      await h.server.close();
      h.push({
        type: "daemon_notification",
        method: SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
        ...event,
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
      await h.close();
    }
  });
});
