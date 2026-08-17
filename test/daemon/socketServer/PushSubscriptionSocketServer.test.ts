import { describe, it, expect, beforeEach } from "bun:test";
import { Socket } from "node:net";
import {
  PushSubscriptionSocketServer,
  SubscriptionResponse,
} from "../../../src/daemon/socketServer/PushSubscriptionSocketServer";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSocket } from "../../fakes/FakeNetServer";

interface TestFilter {
  deviceId: string | null;
  packageName: string | null;
}

interface TestPushData {
  deviceId: string;
  packageName: string;
  value: number;
}

interface TestPushMessage {
  type: "test_push";
  data: TestPushData;
  timestamp: number;
  subscriptionId: string;
}

class TestablePushSubscriptionServer extends PushSubscriptionSocketServer<
  TestFilter,
  TestPushData
> {
  constructor(timer: FakeTimer) {
    super("/fake/path/test.sock", timer, "TestPush");
  }

  /**
   * Start without creating real socket
   */
  async startFake(): Promise<void> {
    (this as any).server = { listening: true };
    this.onServerStarted();
  }

  /**
   * Close without real cleanup
   */
  async closeFake(): Promise<void> {
    this.onServerClosing();
    (this as any).server = null;
  }

  /**
   * Simulate a client connection and subscription
   */
  simulateSubscription(options: { deviceId?: string; packageName?: string }): {
    socket: FakeSocket;
    subscriptionId: string;
  } {
    const socket = new FakeSocket();
    const subscriptionId = `testpush-${++(this as any).subscriptionCounter}`;
    const timer = (this as any).timer as FakeTimer;

    this.subscribers.set(subscriptionId, {
      socket: socket as unknown as Socket,
      subscriptionId,
      lastActivity: timer.now(),
      filter: {
        deviceId: options.deviceId ?? null,
        packageName: options.packageName ?? null,
      },
      backfilling: false,
      drainPending: false,
    });

    return { socket, subscriptionId };
  }

  /**
   * Feed a raw wire line through the real processLine dispatch (the same entry
   * point BaseSocketServer.handleConnection calls for each newline-delimited
   * line), so handleSubscribe / handlePong / the unknown-command branch actually
   * run instead of being bypassed by direct map mutation.
   */
  async simulateLine(socket: FakeSocket, line: string): Promise<void> {
    await (this as any).processLine(socket as unknown as Socket, line);
  }

  closeConnectionForTest(socket: FakeSocket): void {
    (this as any).onConnectionClose(socket as unknown as Socket);
  }

  /**
   * Trigger keepalive check
   */
  triggerKeepalive(): void {
    (this as any).checkKeepalive();
  }

  /**
   * Push data to subscribers (public wrapper)
   */
  pushData(data: TestPushData): number {
    return this.pushToSubscribers(data);
  }

  protected parseSubscriptionFilter(request: Record<string, unknown>): TestFilter {
    return {
      deviceId: (request.deviceId as string) ?? null,
      packageName: (request.packageName as string) ?? null,
    };
  }

  protected matchesFilter(filter: TestFilter, data: TestPushData): boolean {
    const matchesDevice = filter.deviceId === null || filter.deviceId === data.deviceId;
    const matchesPackage = filter.packageName === null || filter.packageName === data.packageName;
    return matchesDevice && matchesPackage;
  }

  protected createPushMessage(data: TestPushData, subscriptionId: string): TestPushMessage {
    return {
      type: "test_push",
      data,
      timestamp: (this as any).timer.now(),
      subscriptionId,
    };
  }
}

describe("PushSubscriptionSocketServer", () => {
  let server: TestablePushSubscriptionServer;
  let timer: FakeTimer;

  beforeEach(async () => {
    timer = new FakeTimer();
    server = new TestablePushSubscriptionServer(timer);
    await server.startFake();
  });

  describe("subscriber management", () => {
    it("tracks subscriber count correctly", () => {
      expect(server.getSubscriberCount()).toBe(0);

      server.simulateSubscription({});
      expect(server.getSubscriberCount()).toBe(1);

      server.simulateSubscription({ deviceId: "device-1" });
      expect(server.getSubscriberCount()).toBe(2);
    });

    it("removes subscribers on close", async () => {
      server.simulateSubscription({});
      server.simulateSubscription({});
      expect(server.getSubscriberCount()).toBe(2);

      await server.closeFake();
      expect(server.getSubscriberCount()).toBe(0);
    });
  });

  describe("push filtering", () => {
    it("pushes data to all subscribers when no filter", () => {
      const { socket: socket1 } = server.simulateSubscription({});
      const { socket: socket2 } = server.simulateSubscription({});

      const data: TestPushData = { deviceId: "device-1", packageName: "com.app", value: 42 };
      const sentCount = server.pushData(data);

      expect(sentCount).toBe(2);
      expect(socket1.getWrittenMessages()).toHaveLength(1);
      expect(socket2.getWrittenMessages()).toHaveLength(1);
    });

    it("filters pushes by deviceId", () => {
      const { socket: socket1 } = server.simulateSubscription({ deviceId: "device-1" });
      const { socket: socket2 } = server.simulateSubscription({ deviceId: "device-2" });

      const data: TestPushData = { deviceId: "device-1", packageName: "com.app", value: 42 };
      const sentCount = server.pushData(data);

      expect(sentCount).toBe(1);
      expect(socket1.getWrittenMessages()).toHaveLength(1);
      expect(socket2.getWrittenMessages()).toHaveLength(0);
    });

    it("filters pushes by packageName", () => {
      const { socket: socket1 } = server.simulateSubscription({ packageName: "com.app.one" });
      const { socket: socket2 } = server.simulateSubscription({ packageName: "com.app.two" });

      const data: TestPushData = { deviceId: "device-1", packageName: "com.app.one", value: 42 };
      const sentCount = server.pushData(data);

      expect(sentCount).toBe(1);
      expect(socket1.getWrittenMessages()).toHaveLength(1);
      expect(socket2.getWrittenMessages()).toHaveLength(0);
    });

    it("filters by both deviceId and packageName", () => {
      const { socket: socket1 } = server.simulateSubscription({
        deviceId: "device-1",
        packageName: "com.app.one",
      });
      const { socket: socket2 } = server.simulateSubscription({
        deviceId: "device-1",
        packageName: "com.app.two",
      });
      const { socket: socket3 } = server.simulateSubscription({
        deviceId: "device-2",
        packageName: "com.app.one",
      });

      const data: TestPushData = { deviceId: "device-1", packageName: "com.app.one", value: 42 };
      const sentCount = server.pushData(data);

      expect(sentCount).toBe(1);
      expect(socket1.getWrittenMessages()).toHaveLength(1);
      expect(socket2.getWrittenMessages()).toHaveLength(0);
      expect(socket3.getWrittenMessages()).toHaveLength(0);
    });
  });

  describe("keepalive", () => {
    it("removes timed out subscribers on keepalive check", () => {
      server.simulateSubscription({});
      expect(server.getSubscriberCount()).toBe(1);

      // Advance time past the timeout (30 seconds)
      timer.advanceTimersByTime(31_000);

      // Trigger keepalive check
      server.triggerKeepalive();

      expect(server.getSubscriberCount()).toBe(0);
    });

    it("sends pings to subscribers on keepalive", () => {
      const { socket } = server.simulateSubscription({});

      // Advance time to trigger keepalive check
      timer.advanceTimersByTime(5_000);
      server.triggerKeepalive();

      const messages = socket.getWrittenMessages<{ type: string }>();
      expect(messages.some((m) => m.type === "ping")).toBe(true);
    });

    it("removes subscribers with destroyed sockets", () => {
      const { socket } = server.simulateSubscription({});
      expect(server.getSubscriberCount()).toBe(1);

      socket.destroy();
      server.triggerKeepalive();

      expect(server.getSubscriberCount()).toBe(0);
    });
  });

  describe("push message format", () => {
    it("includes correct message type and data", () => {
      const { socket } = server.simulateSubscription({});
      timer.setCurrentTime(12345);

      const data: TestPushData = { deviceId: "device-1", packageName: "com.app", value: 99 };
      server.pushData(data);

      const messages = socket.getWrittenMessages<TestPushMessage>();
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("test_push");
      expect(messages[0].data).toEqual(data);
      expect(messages[0].timestamp).toBe(12345);
      expect(messages[0].subscriptionId).toBe("testpush-1");
    });
  });

  describe("error handling", () => {
    it("removes subscribers that fail to receive push", () => {
      const { socket } = server.simulateSubscription({});

      // Override write to throw
      socket.write = () => {
        throw new Error("Connection broken");
      };

      const data: TestPushData = { deviceId: "device-1", packageName: "com.app", value: 42 };
      server.pushData(data);

      expect(server.getSubscriberCount()).toBe(0);
    });

    it("destroys throwing-push subscribers to release the FD", () => {
      const { socket } = server.simulateSubscription({});
      socket.write = () => {
        throw new Error("Connection broken");
      };

      const data: TestPushData = { deviceId: "device-1", packageName: "com.app", value: 42 };
      server.pushData(data);

      expect(socket.destroyed).toBe(true);
    });
  });

  describe("backpressure handling", () => {
    it("does not drop healthy subscribers that return false from write()", () => {
      const { socket } = server.simulateSubscription({});
      // Simulate a large payload crossing the high-water mark — write() returns false
      // but the peer is otherwise healthy and sending pongs.
      socket.write = () => false;

      const data: TestPushData = { deviceId: "device-1", packageName: "com.app", value: 42 };
      server.pushData(data);
      server.pushData(data);
      server.pushData(data);
      server.pushData(data);

      expect(server.getSubscriberCount()).toBe(1);
      expect(socket.destroyed).toBe(false);
    });

    it("bumps lastActivity when a backpressured socket drains", () => {
      const { socket, subscriptionId } = server.simulateSubscription({});
      socket.write = () => false;

      timer.setCurrentTime(1_000);
      const data: TestPushData = { deviceId: "device-1", packageName: "com.app", value: 42 };
      server.pushData(data);

      timer.setCurrentTime(5_000);
      // Peer finally drains — our listener should bump lastActivity.
      socket.emit("drain");

      const subscriber = (server as any).subscribers.get(subscriptionId);
      expect(subscriber.lastActivity).toBe(5_000);
      expect(subscriber.drainPending).toBe(false);
    });

    it("still destroys peers via the keepalive idle timeout when they never drain", () => {
      const { socket } = server.simulateSubscription({});
      socket.write = () => false;

      server.pushData({ deviceId: "device-1", packageName: "com.app", value: 42 });
      expect(server.getSubscriberCount()).toBe(1);

      // No drain ever fires. After 31s with no activity, the timeoutMs path reaps it.
      timer.advanceTimersByTime(31_000);
      server.triggerKeepalive();

      expect(server.getSubscriberCount()).toBe(0);
      expect(socket.destroyed).toBe(true);
    });

    it("does not refresh lastActivity on a successful write", () => {
      const { socket, subscriptionId } = server.simulateSubscription({});

      timer.setCurrentTime(1_000);
      // A successful write proves only that our send buffer accepted the bytes, not that the
      // peer is alive — so it must not bump lastActivity.
      server.pushData({ deviceId: "device-1", packageName: "com.app", value: 42 });

      const subscriber = (server as any).subscribers.get(subscriptionId);
      expect(socket.destroyed).toBe(false);
      expect(subscriber.lastActivity).toBe(0);
    });

    it("times out a non-responsive subscriber despite a steady successful-write stream", () => {
      const { socket } = server.simulateSubscription({});

      // Simulate a self-sustaining keepalive stream: writes keep succeeding every few seconds,
      // but the peer never sends a pong. Liveness must not be masked by the outbound writes.
      for (let elapsed = 3_000; elapsed <= 33_000; elapsed += 3_000) {
        timer.setCurrentTime(elapsed);
        server.pushData({ deviceId: "device-1", packageName: "com.app", value: elapsed });
      }

      server.triggerKeepalive();

      expect(server.getSubscriberCount()).toBe(0);
      expect(socket.destroyed).toBe(true);
    });

    it("does not stack multiple drain listeners on repeated backpressure", () => {
      const { socket, subscriptionId } = server.simulateSubscription({});
      socket.write = () => false;

      const data: TestPushData = { deviceId: "device-1", packageName: "com.app", value: 42 };
      server.pushData(data);
      server.pushData(data);
      server.pushData(data);

      // Should only have one drain listener attached.
      expect(socket.listenerCount("drain")).toBe(1);
      const subscriber = (server as any).subscribers.get(subscriptionId);
      expect(subscriber.drainPending).toBe(true);
    });
  });

  describe("wire dispatch (subscribe / pong / unknown command)", () => {
    it("registers a subscriber and returns subscription_response over the wire", async () => {
      const socket = new FakeSocket();
      expect(server.getSubscriberCount()).toBe(0);

      await server.simulateLine(
        socket,
        JSON.stringify({ command: "subscribe", id: "req-1", deviceId: "device-1" }),
      );

      expect(server.getSubscriberCount()).toBe(1);
      const messages = socket.getWrittenMessages<SubscriptionResponse>();
      expect(messages).toHaveLength(1);
      // Matches src ~:206-210 exactly.
      expect(messages[0]).toEqual({
        id: "req-1",
        type: "subscription_response",
        success: true,
        subscriptionId: "testpush-1",
      });
    });

    it("multiplexes independently filtered subscriptions on one connection", async () => {
      const socket = new FakeSocket();
      await server.simulateLine(
        socket,
        JSON.stringify({
          command: "subscribe",
          id: "device-1",
          deviceId: "device-1",
        }),
      );
      await server.simulateLine(
        socket,
        JSON.stringify({
          command: "subscribe",
          id: "device-2",
          deviceId: "device-2",
        }),
      );

      expect(server.getSubscriberCount()).toBe(2);
      expect(socket.getWrittenMessages<SubscriptionResponse>()).toMatchObject([
        { id: "device-1", type: "subscription_response", subscriptionId: "testpush-1" },
        { id: "device-2", type: "subscription_response", subscriptionId: "testpush-2" },
      ]);

      server.pushData({ deviceId: "device-1", packageName: "com.app", value: 1 });
      server.pushData({ deviceId: "device-2", packageName: "com.app", value: 2 });

      expect(socket.getWrittenMessages<TestPushMessage>().slice(2)).toMatchObject([
        { type: "test_push", subscriptionId: "testpush-1", data: { value: 1 } },
        { type: "test_push", subscriptionId: "testpush-2", data: { value: 2 } },
      ]);
    });

    it("unsubscribes only the addressed subscription on a multiplexed connection", async () => {
      const socket = new FakeSocket();
      await server.simulateLine(
        socket,
        JSON.stringify({
          command: "subscribe",
          id: "device-1",
          deviceId: "device-1",
        }),
      );
      await server.simulateLine(
        socket,
        JSON.stringify({
          command: "subscribe",
          id: "device-2",
          deviceId: "device-2",
        }),
      );

      await server.simulateLine(
        socket,
        JSON.stringify({
          command: "unsubscribe",
          id: "remove-device-1",
          subscriptionId: "testpush-1",
        }),
      );

      expect(server.getSubscriberCount()).toBe(1);
      server.pushData({ deviceId: "device-1", packageName: "com.app", value: 1 });
      server.pushData({ deviceId: "device-2", packageName: "com.app", value: 2 });
      expect(socket.getWrittenMessages<TestPushMessage>().slice(-1)).toMatchObject([
        { type: "test_push", subscriptionId: "testpush-2", data: { value: 2 } },
      ]);
    });

    it("removes every subscription when a multiplexed connection closes", async () => {
      const socket = new FakeSocket();
      await server.simulateLine(socket, JSON.stringify({ command: "subscribe", id: "first" }));
      await server.simulateLine(socket, JSON.stringify({ command: "subscribe", id: "second" }));
      expect(server.getSubscriberCount()).toBe(2);

      server.closeConnectionForTest(socket);

      expect(server.getSubscriberCount()).toBe(0);
    });

    it("sends one keepalive ping per multiplexed connection", async () => {
      const socket = new FakeSocket();
      await server.simulateLine(socket, JSON.stringify({ command: "subscribe", id: "first" }));
      await server.simulateLine(socket, JSON.stringify({ command: "subscribe", id: "second" }));

      server.triggerKeepalive();

      expect(
        socket
          .getWrittenMessages<SubscriptionResponse>()
          .filter((message) => message.type === "ping"),
      ).toHaveLength(1);
    });

    it("reaps every subscription when a multiplexed connection stops responding", async () => {
      const socket = new FakeSocket();
      await server.simulateLine(socket, JSON.stringify({ command: "subscribe", id: "first" }));
      await server.simulateLine(socket, JSON.stringify({ command: "subscribe", id: "second" }));

      timer.advanceTimersByTime(31_000);
      server.triggerKeepalive();

      expect(server.getSubscriberCount()).toBe(0);
      expect(socket.destroyed).toBe(true);
    });

    it("returns a typed error for an unknown command over the wire", async () => {
      const socket = new FakeSocket();

      await server.simulateLine(socket, JSON.stringify({ command: "frobnicate", id: "req-9" }));

      expect(server.getSubscriberCount()).toBe(0);
      const messages = socket.getWrittenMessages<SubscriptionResponse>();
      expect(messages).toHaveLength(1);
      // Matches src ~:176-183 exactly.
      expect(messages[0]).toEqual({
        id: "req-9",
        type: "error",
        success: false,
        error: "Unknown command: frobnicate",
      });
    });

    it("keeps a subscriber alive across a keepalive sweep after a wire pong", async () => {
      const socket = new FakeSocket();
      await server.simulateLine(socket, JSON.stringify({ command: "subscribe", id: "s1" }));
      expect(server.getSubscriberCount()).toBe(1);

      // Subscribed at t=0. Move most of the way to the 30s deadline, then pong.
      timer.advanceTimersByTime(25_000);
      await server.simulateLine(socket, JSON.stringify({ command: "pong" }));

      // Move well past the ORIGINAL deadline. Only the refreshed lastActivity
      // (t=25_000, delta 25_000 < 30_000) keeps this subscriber alive.
      timer.advanceTimersByTime(25_000);
      server.triggerKeepalive();

      expect(server.getSubscriberCount()).toBe(1);
    });

    it("reaps a subscriber that never pongs at the 30s deadline", async () => {
      const socket = new FakeSocket();
      await server.simulateLine(socket, JSON.stringify({ command: "subscribe", id: "s2" }));
      expect(server.getSubscriberCount()).toBe(1);

      // No pong ever arrives; lastActivity stays at t=0. Past 30s it is reaped.
      timer.advanceTimersByTime(31_000);
      server.triggerKeepalive();

      expect(server.getSubscriberCount()).toBe(0);
    });
  });
});
