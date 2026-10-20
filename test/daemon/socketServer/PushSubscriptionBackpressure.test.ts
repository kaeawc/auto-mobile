import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { logger } from "../../../src/utils/logger";
import type { Socket } from "node:net";
import { PushSubscriptionSocketServer } from "../../../src/daemon/socketServer/PushSubscriptionSocketServer";
import { PUSH_SOCKET_WRITABLE_LIMIT_BYTES } from "../../../src/daemon/socketServer/PushSubscriberOutbox";
import { FakePushSocket } from "../../fakes/FakePushSocket";
import { FakeTimer } from "../../fakes/FakeTimer";

interface Frame {
  type: string;
  id?: string;
  requestId?: string;
  droppedType?: string;
  reason?: string;
  success?: boolean;
  value?: number;
  data?: { value: number };
  screenshotBase64?: string;
  subscriptionId?: string;
  deviceId?: string;
  deviceSessionUuid?: string | null;
}

class Server extends PushSubscriptionSocketServer<null, Frame> {
  constructor(readonly clock = new FakeTimer()) {
    super("/fake/backpressure", clock);
  }
  protected parseSubscriptionFilter(): null {
    return null;
  }
  protected matchesFilter(): boolean {
    return true;
  }
  protected createPushMessage(data: Frame, subscriptionId: string): Frame {
    return { ...data, subscriptionId };
  }
  add(socket: Socket, id = "sub"): void {
    this.subscribers.set(id, {
      socket,
      subscriptionId: id,
      filter: null,
      lastActivity: this.clock.now(),
      backfilling: false,
      drainPending: false,
    });
  }
  push(frame: Frame): void {
    this.pushToSubscribers(frame);
  }
  reply(socket: Socket, frame: Frame): void {
    this.sendJson(socket, frame);
  }
  command(socket: Socket, command: Record<string, unknown>): Promise<void> {
    return this.processLine(socket, JSON.stringify(command));
  }
  beginBackfill(): void {
    this.startBackfill("sub");
  }
  keepalive(): void {
    this.checkKeepalive();
  }
}

function rig() {
  const server = new Server();
  const socket = new FakePushSocket<Frame>();
  server.add(socket);
  socket.writeReturnValue = false;
  return { server, socket };
}

describe("push backpressure", () => {
  let logSpies: ReturnType<typeof spyOn>[];
  beforeEach(() => {
    logSpies = [
      spyOn(logger, "debug").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
  });
  afterEach(() => {
    for (const spy of logSpies) {
      spy.mockRestore();
    }
  });
  it("holds only the latest frame per type and subscription until drain", () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    for (let value = 1; value <= 10; value++) {
      server.push({ type: "screenshot_update", value });
      server.push({ type: "hierarchy_update", value });
    }
    expect(socket.responses).toHaveLength(1);
    socket.drain();
    expect(socket.responses).toEqual([
      { type: "screenshot_update", value: 0, subscriptionId: "sub" },
      { type: "screenshot_update", value: 10, subscriptionId: "sub" },
      { type: "hierarchy_update", value: 10, subscriptionId: "sub" },
    ]);
  });

  it("bounds stalled socket bytes and isolates an immediately delivered byte-identical peer", () => {
    const { server, socket } = rig();
    const healthy = new FakePushSocket<Frame>();
    server.add(healthy, 'healthy-"\\\n💧');
    const expected: string[] = [];
    const screenshotBase64 = "x".repeat(16 * 1024);
    for (let value = 0; value < 8; value++) {
      const frame = { type: "screenshot_update", screenshotBase64, value };
      server.push(frame);
      expected.push(JSON.stringify({ ...frame, subscriptionId: 'healthy-"\\\n💧' }) + "\n");
      expect(healthy.writes.at(-1)).toBe(expected.at(-1));
    }
    expect(healthy.writes).toEqual(expected);
    expect(socket.bufferedBytes).toBeLessThan(18 * 1024);
    expect(socket.writes).toHaveLength(1);
    socket.drain();
    expect(socket.responses.map((frame) => frame.value)).toEqual([0, 7]);
  });

  it("retains each device's latest screenshot and hierarchy on one all-device subscription", () => {
    const { server, socket } = rig();
    server.push({ type: "ping" });
    for (let value = 1; value <= 3; value++) {
      for (const deviceId of ["device-a", "device-b"]) {
        server.push({ type: "screenshot_update", deviceId, value });
        server.push({ type: "hierarchy_update", deviceId, value });
      }
    }
    socket.drain();
    expect(socket.responses.slice(1)).toEqual(
      ["device-a", "device-b"].flatMap((deviceId) => [
        { type: "screenshot_update", deviceId, value: 3, subscriptionId: "sub" },
        { type: "hierarchy_update", deviceId, value: 3, subscriptionId: "sub" },
      ]),
    );
  });

  it("keeps a replaced hierarchy before its queued request_observation acknowledgement", () => {
    const { server, socket } = rig();
    server.push({ type: "ping" });
    server.push({ type: "hierarchy_update", deviceId: "device-a", value: 1 });
    server.reply(socket, {
      type: "subscription_response",
      id: "request_observation",
      success: true,
    });
    server.push({ type: "hierarchy_update", deviceId: "device-a", value: 2 });
    socket.drain();
    expect(socket.responses.slice(1)).toEqual([
      { type: "hierarchy_update", deviceId: "device-a", value: 2, subscriptionId: "sub" },
      { type: "subscription_response", id: "request_observation", success: true },
    ]);
  });

  it("drops screenshots above the cap and queues one small marker for the stall", () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    socket.bufferedBytes = PUSH_SOCKET_WRITABLE_LIMIT_BYTES + 1;
    for (let value = 1; value < 4; value++) {
      server.push({ type: "screenshot_update", value });
    }
    expect(socket.writes).toHaveLength(1);
    socket.drain();
    expect(socket.responses).toEqual([
      { type: "screenshot_update", value: 0, subscriptionId: "sub" },
      {
        type: "frames_dropped",
        subscriptionId: "sub",
        droppedType: "screenshot_update",
        reason: "backpressure",
      },
    ]);
    expect(Buffer.byteLength(socket.writes[1]!)).toBeLessThan(200);
    server.push({ type: "screenshot_update", value: 20 });
    expect(socket.responses.at(-1)?.value).toBe(20);
  });

  it("reports cap overflow immediately when no drain is pending", () => {
    const server = new Server();
    const socket = new FakePushSocket<Frame>();
    server.add(socket);
    socket.bufferedBytes = PUSH_SOCKET_WRITABLE_LIMIT_BYTES + 1;
    server.push({ type: "screenshot_update", screenshotBase64: "omitted" });
    expect(socket.responses).toEqual([
      {
        type: "frames_dropped",
        subscriptionId: "sub",
        droppedType: "screenshot_update",
        reason: "backpressure",
      },
    ]);
  });

  it("attributes drop markers to each device and its session", () => {
    const { server, socket } = rig();
    server.push({ type: "ping" });
    // These retained screenshots must be removed only for their own device.
    for (const deviceId of ["device-a", "device-b"]) {
      server.push({ type: "screenshot_update", deviceId, value: 1 });
    }
    socket.bufferedBytes = PUSH_SOCKET_WRITABLE_LIMIT_BYTES + 1;
    for (let value = 2; value <= 3; value++) {
      for (const deviceId of ["device-a", "device-b"]) {
        server.push({
          type: "screenshot_update",
          deviceId,
          deviceSessionUuid: `${deviceId}-session`,
          value,
        });
      }
    }
    socket.drain();
    expect(socket.responses.slice(1)).toEqual(
      ["device-a", "device-b"].map((deviceId) => ({
        type: "frames_dropped",
        subscriptionId: "sub",
        deviceId,
        deviceSessionUuid: `${deviceId}-session`,
        droppedType: "screenshot_update",
        reason: "backpressure",
      })),
    );
  });

  it("reports a new overflow after buffer recovery without a drain event", () => {
    const server = new Server();
    const socket = new FakePushSocket<Frame>();
    server.add(socket);
    const frame = { type: "screenshot_update", deviceId: "device-a", deviceSessionUuid: null };
    socket.bufferedBytes = PUSH_SOCKET_WRITABLE_LIMIT_BYTES + 1;
    server.push(frame);
    server.push(frame);
    socket.bufferedBytes = 0;
    server.push({ type: "hierarchy_update", deviceId: "device-a" });
    socket.bufferedBytes = PUSH_SOCKET_WRITABLE_LIMIT_BYTES + 1;
    server.push(frame);
    expect(socket.listenerCount("drain")).toBe(0);
    expect(socket.responses.map((response) => response.type)).toEqual([
      "frames_dropped",
      "hierarchy_update",
      "frames_dropped",
    ]);
    expect(socket.responses.at(-1)?.deviceSessionUuid).toBeNull();
  });

  it("preserves every control and event in FIFO order among surviving state frames", async () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    server.push({ type: "hierarchy_update", value: 1 });
    server.keepalive();
    await server.command(socket, { command: "bad", id: "error" });
    await server.command(socket, { command: "subscribe", id: "ack" });
    const types = [
      "pong",
      "navigation_update",
      "storage_update",
      "storage_reconciliation_required",
      "performance_update",
      "device_build_context",
      "device_session_started",
      "device_session_ended",
      "telemetry_push",
      "performance_push",
      "failure_push",
      "future_type",
    ];
    for (const type of types) {
      server.push({ type, value: 2 });
      server.push({ type, value: 3 });
    }
    server.push({ type: "hierarchy_update", value: 4 });
    expect(socket.responses).toHaveLength(1);
    socket.drain();
    // Two subscriptions share this socket; each lossless event goes to both.
    expect(socket.responses.map((frame) => frame.type)).toEqual([
      "screenshot_update",
      "hierarchy_update",
      "ping",
      "error",
      "subscription_response",
      ...types.flatMap((type) => [type, type, type, type]),
      "hierarchy_update",
    ]);
    expect(socket.responses.filter((frame) => types.includes(frame.type))).toEqual(
      types.flatMap((type) => [
        { type, value: 2, subscriptionId: "sub" },
        { type, value: 2, subscriptionId: "push-1" },
        { type, value: 3, subscriptionId: "sub" },
        { type, value: 3, subscriptionId: "push-1" },
      ]),
    );
    expect(
      socket.responses
        .filter((frame) => frame.type === "hierarchy_update")
        .map((frame) => frame.value),
    ).toEqual([4, 4]);
  });

  it("snapshots lossless event data at enqueue time", () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    const event = { type: "telemetry_push", data: { value: 1 } };
    server.push(event);
    event.data.value = 2;
    socket.drain();
    expect(socket.responses.at(-1)?.data?.value).toBe(1);
  });

  it("never coalesces correlated screenshot or hierarchy replies", () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    socket.bufferedBytes = PUSH_SOCKET_WRITABLE_LIMIT_BYTES + 1;
    for (let value = 1; value <= 3; value++) {
      server.push({ type: "screenshot_update", id: `reply-${value}`, value });
      server.push({ type: "hierarchy_update", requestId: `request-${value}`, value });
    }
    expect(socket.responses).toHaveLength(1);
    socket.drain();
    expect(socket.responses.map((frame) => frame.value)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it("stops flushing on repeated backpressure without stacking drain listeners", () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    server.push({ type: "hierarchy_update", value: 1 });
    server.push({ type: "screenshot_update", value: 2 });
    socket.drain(true);
    expect(socket.responses.map((frame) => frame.value)).toEqual([0, 1]);
    expect(socket.listenerCount("drain")).toBe(1);
    server.push({ type: "screenshot_update", value: 3 });
    socket.drain();
    expect(socket.responses.map((frame) => frame.value)).toEqual([0, 1, 3]);
  });

  it("keeps multiplexed subscription state separate", () => {
    const { server, socket } = rig();
    server.add(socket, "other");
    for (let value = 0; value < 4; value++) {
      server.push({ type: "screenshot_update", value });
    }
    expect(socket.responses).toHaveLength(1);
    socket.drain();
    expect(socket.responses.slice(1)).toEqual([
      { type: "screenshot_update", value: 3, subscriptionId: "other" },
      { type: "screenshot_update", value: 3, subscriptionId: "sub" },
    ]);
  });

  it("removes unsubscribed state without bypassing queued controls or its acknowledgement", async () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    server.push({ type: "screenshot_update", value: 1 });
    server.keepalive();
    await server.command(socket, { command: "unsubscribe", subscriptionId: "sub", id: "bye" });
    expect(socket.responses).toHaveLength(1);
    socket.drain();
    expect(socket.responses.map((frame) => frame.type)).toEqual([
      "screenshot_update",
      "ping",
      "subscription_response",
    ]);
  });

  it("flushes the backfill overflow error before ending a stalled connection", () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    server.beginBackfill();
    for (let value = 0; value <= 1000; value++) {
      server.push({ type: "telemetry_push", value });
    }
    expect(server.getSubscriberCount()).toBe(0);
    expect(socket.destroyed).toBe(false);
    expect(socket.responses).toHaveLength(1);
    socket.drain();
    expect(socket.responses.at(-1)?.type).toBe("error");
    expect(socket.destroyed).toBe(true);
  });

  it("reaps a stalled peer even while state and controls continue to arrive", () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    server.clock.advanceTimersByTime(10_000);
    server.keepalive();
    server.push({ type: "hierarchy_update", value: 1 });
    server.clock.advanceTimersByTime(21_000);
    server.keepalive();
    expect(socket.destroyed).toBe(true);
    expect(server.getSubscriberCount()).toBe(0);
    socket.drain();
    expect(socket.responses).toHaveLength(1);
  });

  it("keeps sending keepalive while an unsubscribed socket has a stalled reply", async () => {
    const server = new Server();
    const socket = new FakePushSocket<Frame>();
    socket.writeReturnValue = false;
    await server.command(socket, { command: "bad" });
    expect(server.getSubscriberCount()).toBe(0);
    server.clock.advanceTimersByTime(10_000);
    server.keepalive();
    socket.drain();
    expect(socket.responses.map((frame) => frame.type)).toEqual(["error", "ping"]);
  });

  it("retires a peer if its drain flush throws", () => {
    const { server, socket } = rig();
    server.push({ type: "screenshot_update", value: 0 });
    server.push({ type: "hierarchy_update", value: 1 });
    socket.onWrite = () => {
      throw new Error("write failed");
    };
    socket.drain();
    expect(socket.destroyed).toBe(true);
    expect(server.getSubscriberCount()).toBe(0);
  });
});
