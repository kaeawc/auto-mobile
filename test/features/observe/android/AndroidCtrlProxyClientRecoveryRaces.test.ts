import { afterEach, expect, test } from "bun:test";
import {
  AndroidCtrlProxyClient,
  type AndroidServiceRecoveryManager,
} from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

const device = { deviceId: "recovery-races", platform: "android" as const, name: "Fake" };
const clients: AndroidCtrlProxyClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

async function flush(): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    await Promise.resolve();
  }
}

function harness(manager: AndroidServiceRecoveryManager, failures = 0) {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
  adb.setDeviceStates([{ deviceId: device.deviceId, state: "device" }]);
  const sockets: FakeWebSocket[] = [];
  const sent: string[][] = [];
  const client = AndroidCtrlProxyClient.createForTesting(
    device,
    adb,
    (url) => {
      const socket = new FakeWebSocket(url, "none", 0, timer, "withhold");
      const messages: string[] = [];
      sent.push(messages);
      socket.send = (data) => {
        messages.push(String(data));
      };
      if (sockets.length < failures) {
        const emit = socket.emit.bind(socket);
        socket.emit = (event, ...args) => {
          if (event === "open") {
            socket.readyState = WebSocketState.CLOSED;
            return emit("error", new Error("dial failure"));
          }
          return emit(event, ...args);
        };
      }
      socket.terminate = () => {
        socket.readyState = WebSocketState.CLOSING;
        timer.setTimeout(() => {
          socket.readyState = WebSocketState.CLOSED;
          socket.emit("close");
        }, 10);
      };
      sockets.push(socket);
      return socket;
    },
    timer,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => manager,
  );
  clients.push(client);
  return { client, timer, adb, sockets, sent };
}

function healthyManager(): AndroidServiceRecoveryManager {
  return {
    isAccessibilityServiceHealthy: async () => true,
    setup: async () => ({ success: true, message: "ok" }),
  };
}

test("healthy recovery queues a reconnect at the remaining foreground cooldown", async () => {
  const { client, timer, sockets } = harness(healthyManager(), 3);
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await client.ensureConnected()).toBe(false);
  }
  await flush();
  const cooldown = client.getReconnectStatus()!;
  expect(cooldown).not.toBeNull();
  expect(sockets).toHaveLength(3);
  timer.advanceTime(cooldown.retryAfterMs - 1);
  await flush();
  expect(sockets).toHaveLength(3);
  timer.advanceTime(1);
  await flush();
  expect(sockets).toHaveLength(4);
  expect(client.isConnected()).toBe(true);
});

test("close cancels the healthy recovery cooldown retry", async () => {
  const { client, timer, sockets } = harness(healthyManager(), 3);
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.ensureConnected();
  }
  await flush();
  const cooldown = client.getReconnectStatus()!;
  await client.close();
  timer.advanceTime(cooldown.retryAfterMs);
  await flush();
  expect(sockets).toHaveLength(3);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test.each(["presence", "health", "rebind", "post-rebind-health", "setup", "post-setup-health"])(
  "closing during %s prevents subsequent recovery mutations",
  async (stage) => {
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let healthCalls = 0;
    let rebindCalls = 0;
    let setupCalls = 0;
    const manager: AndroidServiceRecoveryManager = {
      isAccessibilityServiceHealthy: async () => {
        healthCalls++;
        if (
          stage === "health" ||
          (stage === "post-rebind-health" && healthCalls === 2) ||
          (stage === "post-setup-health" && healthCalls === 3)
        ) {
          return gate;
        }
        return false;
      },
      rebindIfUnhealthy: async () => {
        rebindCalls++;
        return stage === "rebind" ? gate : true;
      },
      setup: async () => {
        setupCalls++;
        if (stage === "setup") {
          await gate;
        }
        return { success: true, message: "ok" };
      },
    };
    const { client, adb, timer, sockets } = harness(manager);
    if (stage === "presence") {
      adb.getDeviceStates = async () => {
        await gate;
        return [{ deviceId: device.deviceId, state: "device" }];
      };
    }
    client.ensureRecoveryStarted();
    await flush();
    expect(client.isRecoveryInFlight()).toBe(true);
    const mutationsBeforeClose = rebindCalls + setupCalls;
    await client.close();
    release(false);
    await flush();
    expect(rebindCalls + setupCalls).toBe(mutationsBeforeClose);
    expect(client.isRecoveryInFlight()).toBe(false);
    expect(sockets).toHaveLength(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  },
);

test("Android replacement before async close clears cached hierarchy and resends tracking", async () => {
  const { client, timer, sent, sockets } = harness(healthyManager());
  expect(await client.ensureConnected()).toBe(true);
  await client.setRecompositionTrackingEnabled(true);
  const oldCache = {
    hierarchy: { updatedAt: 0, packageName: "fake.app", hierarchy: { text: "old" } },
    receivedAt: 0,
    fresh: true,
  };
  // Inspect the existing connection-scoped cache without invoking observation/ADB.
  client["cachedHierarchy"] = oldCache;
  expect(client["cachedHierarchy"]).not.toBeNull();
  client.terminateStaleConnection();
  expect(await client.ensureConnected()).toBe(true);
  expect(client["cachedHierarchy"]).toBeNull();
  // A queued old frame must not repopulate the replacement's cache.
  sockets[0]!.emit(
    "message",
    JSON.stringify({ type: "hierarchy_update", data: oldCache.hierarchy }),
  );
  await flush();
  expect(client["cachedHierarchy"]).toBeNull();
  await client.setRecompositionTrackingEnabled(true);
  expect(sent[1]!.filter((message) => message.includes("set_recomposition_tracking"))).toHaveLength(
    1,
  );
  timer.advanceTime(10);
  expect(client.isConnected()).toBe(true);
  await client.setRecompositionTrackingEnabled(true);
  expect(sent[1]!.filter((message) => message.includes("set_recomposition_tracking"))).toHaveLength(
    1,
  );
});
