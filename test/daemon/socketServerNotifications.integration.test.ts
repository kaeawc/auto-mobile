import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { ListChangedBroadcaster } from "../../src/server/listChangedBroadcast";
import {
  SessionReleaseBroadcaster,
  SESSION_RELEASED_NOTIFICATION_METHOD,
} from "../../src/server/sessionReleaseBroadcast";
import { DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD } from "../../src/daemon/constants";
import { FakeTimer } from "../fakes/FakeTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";
import type { DaemonResponse } from "../../src/daemon/types";

// Issue #3223: the daemon's Unix socket server pushes list-changed notification
// frames to clients that opted in via daemon/subscribe-notifications, and only
// to those clients — legacy request/response clients never see pushed frames.

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({ getSession: () => null, releaseSession: async () => null }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

/** Persistent test client that collects every newline-delimited frame it receives. */
class FrameCollectingClient {
  readonly frames: any[] = [];
  private socket = new Socket();
  private buffer = "";
  private frameWaiters: Array<() => void> = [];

  connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.connect(socketPath, resolve);
      this.socket.on("error", reject);
      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) {
            this.frames.push(JSON.parse(line));
          }
        }
        const waiters = this.frameWaiters;
        this.frameWaiters = [];
        waiters.forEach((waiter) => waiter());
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): void {
    this.socket.write(
      JSON.stringify({ id: randomUUID(), type: "daemon_request", method, params }) + "\n",
    );
  }

  /**
   * Resolves once at least `count` frames have arrived, or rejects with a
   * diagnostic after `deadlineMs`. An unbounded wait here would pend until the
   * CI wall-clock watchdog on a dropped broadcast (macos hang class, #5391).
   */
  async waitForFrames(count: number, deadlineMs: number = 10_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (this.frames.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Received ${this.frames.length}/${count} notification frames within ${deadlineMs}ms — bounded socket-test deadline hit`,
        );
      }
      await new Promise<void>((resolve) => {
        this.frameWaiters.push(resolve);
        defaultTimer.setTimeout(resolve, remaining).unref();
      });
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

describe("UnixSocketServer notification broadcast", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  const clients: FrameCollectingClient[] = [];

  beforeEach(async () => {
    socketPath = join(tmpdir(), `test-notify-${randomUUID()}.sock`);
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      new FakeTimer(),
    );
    await server.start();
  });

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.close());
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  async function connectedClient(): Promise<FrameCollectingClient> {
    const client = new FrameCollectingClient();
    clients.push(client);
    await client.connect(socketPath);
    return client;
  }

  test("subscription request is acknowledged", async () => {
    const client = await connectedClient();
    client.send(DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD);
    await client.waitForFrames(1);

    const response = client.frames[0] as DaemonResponse;
    expect(response.success).toBe(true);
    expect(response.result).toEqual({ subscribed: true });
  });

  test("broadcasts list-changed frames to subscribed clients only", async () => {
    const subscriber = await connectedClient();
    const bystander = await connectedClient();

    subscriber.send(DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD);
    await subscriber.waitForFrames(1);

    // Emitted by ToolRegistry.notifyToolListChanged in production; the socket
    // server subscribes to the broadcaster in start().
    ListChangedBroadcaster.emit("tools");
    await subscriber.waitForFrames(2);

    expect(subscriber.frames[1]).toEqual({
      type: "daemon_notification",
      method: "notifications/tools/list_changed",
    });
    // A short settle window: any stray frame for the bystander would have been
    // written in the same synchronous broadcast as the subscriber's frame.
    await new Promise((resolve) => defaultTimer.setTimeout(resolve, 25));
    expect(bystander.frames).toEqual([]);
  });

  test("broadcasts resources list-changed with the resources method", async () => {
    const subscriber = await connectedClient();
    subscriber.send(DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD);
    await subscriber.waitForFrames(1);

    ListChangedBroadcaster.emit("resources");
    await subscriber.waitForFrames(2);

    expect(subscriber.frames[1]).toEqual({
      type: "daemon_notification",
      method: "notifications/resources/list_changed",
    });
  });

  test("pushes a session-released frame carrying the id and diagnostic reason", async () => {
    const subscriber = await connectedClient();
    subscriber.send(DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD);
    await subscriber.waitForFrames(1);

    // Emitted by the daemon's onSessionRelease callback in production; the socket
    // server subscribes to the broadcaster in start().
    SessionReleaseBroadcaster.emit("session-a", "missing-first-heartbeat", {
      sessionId: "session-a",
      deviceId: "emulator-5554",
      releaseReason: "missing-first-heartbeat",
      releasedAtMs: 20_000,
      terminal: true,
      heartbeat: {
        lastHeartbeatMs: 10_000,
        hasReceivedHeartbeat: false,
        timeoutMs: 10_000,
        ageMs: 10_000,
      },
    });
    await subscriber.waitForFrames(2);

    expect(subscriber.frames[1]).toEqual({
      type: "daemon_notification",
      method: SESSION_RELEASED_NOTIFICATION_METHOD,
      sessionId: "session-a",
      reason: "missing-first-heartbeat",
      release: {
        sessionId: "session-a",
        deviceId: "emulator-5554",
        releaseReason: "missing-first-heartbeat",
        releasedAtMs: 20_000,
        terminal: true,
        heartbeat: {
          lastHeartbeatMs: 10_000,
          hasReceivedHeartbeat: false,
          timeoutMs: 10_000,
          ageMs: 10_000,
        },
      },
    });
  });

  test("close() unsubscribes from the session-release broadcaster too (issue #4610)", async () => {
    const subscriber = await connectedClient();
    subscriber.send(DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD);
    await subscriber.waitForFrames(1);

    subscriber.close();
    await server.close();

    expect(
      (server as unknown as { sessionReleaseUnsubscribe: unknown }).sessionReleaseUnsubscribe,
    ).toBeNull();
    expect(() => SessionReleaseBroadcaster.emit("session-a")).not.toThrow();
    expect(subscriber.frames).toHaveLength(1);
  });

  test("close() unsubscribes from the broadcaster (no write to dead sockets)", async () => {
    const subscriber = await connectedClient();
    subscriber.send(DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD);
    await subscriber.waitForFrames(1);

    // net.Server.close waits for live connections, so drop the client first.
    subscriber.close();
    await server.close();

    // The broadcaster subscription is released on close, so emitting after
    // close must not throw and must not attempt any socket writes.
    expect(
      (server as unknown as { listChangedUnsubscribe: unknown }).listChangedUnsubscribe,
    ).toBeNull();
    expect(() => ListChangedBroadcaster.emit("tools")).not.toThrow();
    expect(subscriber.frames).toHaveLength(1);
  });
});
