import { describe, it, expect, beforeEach } from "bun:test";
import {
  TelemetryPushSocketServer,
  boundBackfillEventText,
  type TelemetryFilter,
} from "../../src/daemon/telemetryPushSocketServer";
import { boundStructuredField } from "../../src/utils/truncateBodyText";
import type { TelemetryEvent } from "../../src/features/telemetry/TelemetryRecorder";
import type { Subscriber } from "../../src/daemon/socketServer/SocketServerTypes";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeDeviceSessionResolver } from "../fakes/FakeDeviceSessionResolver";
import { withInMemorySingletonDatabase } from "../db/inMemorySingletonDatabase";
import { getDatabase } from "../../src/db/database";
import { runMigrations } from "../../src/db/migrator";
import {
  navigationScreenshotFrameSchema,
  telemetryEventPushFrameSchema,
  telemetryPushFrameSchema,
} from "../helpers/wireMessageSchemas";

/**
 * Test helper that wraps TelemetryPushSocketServer to allow injecting fake sockets
 * without requiring real network connections.
 */
class TestableTelemetryPushSocketServer extends TelemetryPushSocketServer {
  constructor(timer: FakeTimer) {
    super("/fake/path/telemetry-push.sock", timer);
  }

  async startFake(): Promise<void> {
    this.onServerStarted();
  }

  async closeFake(): Promise<void> {
    this.onServerClosing();
  }

  simulateSubscription(options: {
    category?: string | null;
    deviceSessionUuid?: string | null;
    deviceId?: string | null;
    sessionId?: string | null;
  }): {
    socket: FakeSocket;
    subscriptionId: string;
  } {
    const socket = new FakeSocket();
    const subscriptionId = `telemetrypush-${++this.subscriptionCounter}`;
    this.subscribers.set(subscriptionId, {
      socket: socket,
      subscriptionId,
      lastActivity: this.timer.now(),
      filter: {
        category: options.category ?? null,
        deviceSessionUuid: options.deviceSessionUuid ?? null,
        // The server resolves this from deviceSessionUuid at real subscribe time; a
        // test may seed it directly for backfill-query coverage.
        deviceId: options.deviceId ?? null,
        sessionId: options.sessionId ?? null,
      },
      backfilling: false,
      drainPending: false,
    });
    return { socket, subscriptionId };
  }

  simulatePong(subscriptionId: string): void {
    const subscriber = this.subscribers.get(subscriptionId);
    if (subscriber) {
      subscriber.lastActivity = this.timer.now();
    }
  }

  triggerKeepalive(): void {
    this.checkKeepalive();
  }

  /** Register a subscriber directly, as `subscribe` would after authorizing it. */
  seedSubscriber(subscriptionId: string, subscriber: Subscriber<TelemetryFilter>): void {
    this.subscribers.set(subscriptionId, subscriber);
  }

  getSubscriber(subscriptionId: string): Subscriber<TelemetryFilter> | undefined {
    return this.subscribers.get(subscriptionId);
  }

  removeSubscriber(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId);
  }

  runBackfill(subscriptionId: string, filter: TelemetryFilter, socket: FakeSocket): Promise<void> {
    return this.backfillRecentEvents(subscriptionId, filter, socket);
  }
}

/** The own enumerable fields of a bounded telemetry payload; fails the test for a non-object. */
function fieldsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected an object payload, got ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: unknown, key: string): string {
  const field = fieldsOf(value)[key];
  if (typeof field !== "string") {
    throw new Error(`expected "${key}" to be a string, got ${typeof field}`);
  }
  return field;
}

describe("boundBackfillEventText", () => {
  it("caps a large log message at 10KB", () => {
    const event: TelemetryEvent = {
      category: "log",
      timestamp: 1,
      deviceId: null,
      sessionId: null,
      data: { level: 4, tag: "t", message: "m".repeat(50_000) },
    };
    const bounded = boundBackfillEventText(event);
    expect(stringField(bounded.data, "message").length).toBe(10_240);
  });

  it("caps large storage value and previousValue at 10KB", () => {
    const event: TelemetryEvent = {
      category: "storage",
      timestamp: 1,
      deviceId: null,
      sessionId: null,
      data: {
        key: "k",
        value: "v".repeat(30_000),
        previousValue: "p".repeat(30_000),
        valueType: "string",
      },
    };
    const bounded = boundBackfillEventText(event);
    expect(stringField(bounded.data, "value").length).toBe(10_240);
    expect(stringField(bounded.data, "previousValue").length).toBe(10_240);
  });

  it("leaves small fields and unrelated categories untouched", () => {
    const event: TelemetryEvent = {
      category: "log",
      timestamp: 1,
      deviceId: null,
      sessionId: null,
      data: { level: 4, tag: "t", message: "small" },
    };
    const bounded = boundBackfillEventText(event);
    expect(stringField(bounded.data, "message")).toBe("small");

    const os: TelemetryEvent = {
      category: "os",
      timestamp: 1,
      deviceId: null,
      sessionId: null,
      data: { category: "lifecycle", kind: "foreground", details: null },
    };
    expect(boundBackfillEventText(os)).toEqual(os);
  });

  it("does not split a surrogate pair in a bounded field", () => {
    const event: TelemetryEvent = {
      category: "log",
      timestamp: 1,
      deviceId: null,
      sessionId: null,
      data: { level: 4, tag: "t", message: "m".repeat(10_239) + "😀" + "n".repeat(50) },
    };
    const bounded = boundBackfillEventText(event);
    const msg = stringField(bounded.data, "message");
    expect(msg.length).toBe(10_239);
    expect(msg.isWellFormed()).toBe(true);
  });

  it("replaces an oversized os details object with a valid-JSON marker", () => {
    const bigDetails = { blob: "x".repeat(50_000) };
    const event: TelemetryEvent = {
      category: "os",
      timestamp: 1,
      deviceId: null,
      sessionId: null,
      data: { category: "lifecycle", kind: "foreground", details: bigDetails },
    };
    const bounded = boundBackfillEventText(event);
    expect(fieldsOf(bounded.data).details).toMatchObject({
      _truncated: true,
      bytes: JSON.stringify(bigDetails).length,
    });
    // Result must round-trip through JSON.parse (dashboard contract).
    expect(() => JSON.parse(JSON.stringify(bounded.data))).not.toThrow();
  });

  it("leaves a small os details object untouched", () => {
    const details = { screen: "Home", extra: 1 };
    const event: TelemetryEvent = {
      category: "os",
      timestamp: 1,
      deviceId: null,
      sessionId: null,
      data: { category: "lifecycle", kind: "foreground", details },
    };
    const bounded = boundBackfillEventText(event);
    expect(fieldsOf(bounded.data).details).toBe(details);
  });

  it("replaces an oversized layout detailsJson raw string with a marker", () => {
    const raw = JSON.stringify({ frames: "y".repeat(50_000) });
    const event: TelemetryEvent = {
      category: "layout",
      timestamp: 1,
      deviceId: null,
      sessionId: null,
      data: { composableId: "c", detailsJson: raw },
    };
    const bounded = boundBackfillEventText(event);
    expect(fieldsOf(bounded.data).detailsJson).toMatchObject({
      _truncated: true,
      bytes: raw.length,
    });
  });

  it("leaves a small layout detailsJson string untouched", () => {
    const raw = JSON.stringify({ ok: true });
    const event: TelemetryEvent = {
      category: "layout",
      timestamp: 1,
      deviceId: null,
      sessionId: null,
      data: { composableId: "c", detailsJson: raw },
    };
    const bounded = boundBackfillEventText(event);
    expect(fieldsOf(bounded.data).detailsJson).toBe(raw);
  });
});

describe("boundStructuredField", () => {
  it("passes null/undefined through unchanged", () => {
    expect(boundStructuredField(null, false)).toBe(null);
    expect(boundStructuredField(undefined, false)).toBe(undefined);
  });

  it("keeps a within-budget stack trace array unchanged", () => {
    const frames = [
      { className: "A", line: 1 },
      { className: "B", line: 2 },
    ];
    expect(boundStructuredField(frames, false)).toBe(frames);
  });

  it("replaces an oversized stack trace array with a valid marker", () => {
    const frames = Array.from({ length: 5_000 }, (_, i) => ({
      className: `com.example.Very.Long.Class.Name.${i}`,
      method: "doSomethingExpensive",
      line: i,
    }));
    const bounded = boundStructuredField(frames, false);
    expect(bounded).toMatchObject({ _truncated: true, bytes: JSON.stringify(frames).length });
    expect(() => JSON.parse(JSON.stringify(bounded))).not.toThrow();
  });

  it("measures raw JSON strings by their own length when isJsonString", () => {
    const raw = "z".repeat(20_000);
    expect(boundStructuredField(raw, true)).toMatchObject({ bytes: 20_000 });
  });
});

describe("TelemetryPushSocketServer", () => {
  let server: TestableTelemetryPushSocketServer;
  let timer: FakeTimer;
  let resolver: FakeDeviceSessionResolver;

  beforeEach(async () => {
    timer = new FakeTimer();
    server = new TestableTelemetryPushSocketServer(timer);
    resolver = new FakeDeviceSessionResolver()
      .bind("device-1", "uuid-1")
      .bind("device-2", "uuid-2");
    server.setDeviceSessionResolver(resolver);
    await server.startFake();
  });

  const telemetryEvent = (deviceId: string): TelemetryEvent => ({
    category: "network",
    timestamp: 1000,
    deviceId,
    sessionId: null,
    data: { method: "GET", url: "/users", statusCode: 200, durationMs: 42 },
  });

  // The epoch survives the quarantine but is withheld, and the event is dropped
  // rather than broadcast under a serial the pool can no longer tie to a runtime
  // (#6863 review).
  it("drops telemetry while the device's pooled identity is quarantined", () => {
    const scoped = server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    const all = server.simulateSubscription({});
    resolver.quarantine("device-1");

    server.pushTelemetryEvent(telemetryEvent("device-1"));

    expect(scoped.socket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(0);
    expect(all.socket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(0);
  });

  it("resumes telemetry delivery under the same uuid once the quarantine lifts", () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    resolver.quarantine("device-1");
    server.pushTelemetryEvent(telemetryEvent("device-1"));

    resolver.resolveIdentity("device-1");
    server.pushTelemetryEvent(telemetryEvent("device-1"));

    const msgs = socket.getWrittenMessages(telemetryPushFrameSchema);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data?.deviceSessionUuid).toBe("uuid-1");
  });

  it("tracks subscriber count correctly", () => {
    expect(server.getSubscriberCount()).toBe(0);

    server.simulateSubscription({});
    expect(server.getSubscriberCount()).toBe(1);

    server.simulateSubscription({ category: "network" });
    expect(server.getSubscriberCount()).toBe(2);
  });

  it("pushes data to all subscribers when no category filter", () => {
    const { socket: socket1 } = server.simulateSubscription({});
    const { socket: socket2 } = server.simulateSubscription({});

    const event: TelemetryEvent = {
      category: "network",
      timestamp: 1000,
      deviceId: null,
      sessionId: null,
      data: { method: "GET", url: "/users", statusCode: 200, durationMs: 42 },
    };

    server.pushTelemetryEvent(event);

    const msgs1 = socket1.getWrittenMessages(telemetryPushFrameSchema);
    const msgs2 = socket2.getWrittenMessages(telemetryPushFrameSchema);

    expect(msgs1).toHaveLength(1);
    expect(msgs1[0].type).toBe("telemetry_push");
    expect(msgs1[0].data?.category).toBe("network");

    expect(msgs2).toHaveLength(1);
    expect(msgs2[0].type).toBe("telemetry_push");
  });

  it("filters pushes by category", () => {
    const { socket: networkSocket } = server.simulateSubscription({ category: "network" });
    const { socket: logSocket } = server.simulateSubscription({ category: "log" });
    const { socket: allSocket } = server.simulateSubscription({});

    const networkEvent: TelemetryEvent = {
      category: "network",
      timestamp: 1000,
      deviceId: null,
      sessionId: null,
      data: { method: "GET", url: "/users", statusCode: 200, durationMs: 42 },
    };

    server.pushTelemetryEvent(networkEvent);

    expect(networkSocket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(1);
    expect(logSocket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(0);
    expect(allSocket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(1);
  });

  it("pushes different event categories to matching subscribers", () => {
    const { socket: logSocket } = server.simulateSubscription({ category: "log" });

    const logEvent: TelemetryEvent = {
      category: "log",
      timestamp: 2000,
      deviceId: null,
      sessionId: null,
      data: { level: 4, tag: "TestTag", message: "hello" },
    };

    const networkEvent: TelemetryEvent = {
      category: "network",
      timestamp: 3000,
      deviceId: null,
      sessionId: null,
      data: { method: "POST", url: "/submit", statusCode: 201, durationMs: 100 },
    };

    server.pushTelemetryEvent(logEvent);
    server.pushTelemetryEvent(networkEvent);

    const msgs = logSocket.getWrittenMessages(telemetryPushFrameSchema);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data?.category).toBe("log");
  });

  it("pushes performance events correctly", () => {
    const { socket } = server.simulateSubscription({ category: "performance" });

    const event: TelemetryEvent = {
      category: "performance",
      timestamp: 4000,
      deviceId: null,
      sessionId: null,
      data: { metric: "frame_time", value: 16 },
    };

    server.pushTelemetryEvent(event);

    const msgs = socket.getWrittenMessages(telemetryPushFrameSchema);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data?.category).toBe("performance");
  });

  it("pushes os events correctly", () => {
    const { socket } = server.simulateSubscription({ category: "os" });

    const event: TelemetryEvent = {
      category: "os",
      timestamp: 5000,
      deviceId: null,
      sessionId: null,
      data: { category: "lifecycle", kind: "foreground", details: null },
    };

    server.pushTelemetryEvent(event);

    const msgs = socket.getWrittenMessages(telemetryPushFrameSchema);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data?.category).toBe("os");
  });

  it("removes destroyed sockets on push", () => {
    const { socket: socket1 } = server.simulateSubscription({});
    server.simulateSubscription({});

    expect(server.getSubscriberCount()).toBe(2);
    socket1.destroy();

    const event: TelemetryEvent = {
      category: "log",
      timestamp: 6000,
      deviceId: null,
      sessionId: null,
      data: { level: 4, tag: "Test", message: "msg" },
    };

    server.pushTelemetryEvent(event);
    expect(server.getSubscriberCount()).toBe(1);
  });

  it("removes timed out subscribers on keepalive check", () => {
    server.simulateSubscription({});
    expect(server.getSubscriberCount()).toBe(1);

    timer.advanceTimersByTime(31_000);
    server.triggerKeepalive();

    expect(server.getSubscriberCount()).toBe(0);
  });

  it("keeps subscribers alive when they respond to pongs", () => {
    const { subscriptionId } = server.simulateSubscription({});
    expect(server.getSubscriberCount()).toBe(1);

    timer.advanceTimersByTime(15_000);
    server.simulatePong(subscriptionId);

    timer.advanceTimersByTime(20_000);
    server.triggerKeepalive();

    expect(server.getSubscriberCount()).toBe(1);
  });

  it("includes server timestamp in push message", () => {
    timer.setCurrentTime(99999);
    const { socket } = server.simulateSubscription({});

    const event: TelemetryEvent = {
      category: "network",
      timestamp: 50000,
      deviceId: null,
      sessionId: null,
      data: { method: "GET", url: "/test", statusCode: 200, durationMs: 10 },
    };

    server.pushTelemetryEvent(event);

    const msgs = socket.getWrittenMessages(telemetryPushFrameSchema);
    expect(msgs[0].timestamp).toBe(99999);
    expect(msgs[0].data?.timestamp).toBe(50000);
  });

  it("filters pushes by deviceSessionUuid (AC2)", () => {
    const { socket: d1Socket } = server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    const { socket: d2Socket } = server.simulateSubscription({ deviceSessionUuid: "uuid-2" });
    const { socket: allSocket } = server.simulateSubscription({});

    const event: TelemetryEvent = {
      category: "network",
      timestamp: 1000,
      deviceId: "device-1",
      sessionId: null,
      data: { method: "GET", url: "/test", statusCode: 200, durationMs: 10 },
    };

    server.pushTelemetryEvent(event);

    const d1 = d1Socket.getWrittenMessages(telemetryPushFrameSchema);
    expect(d1).toHaveLength(1);
    // Live events carry the resolved epoch key (AC1).
    expect(d1[0].data?.deviceSessionUuid).toBe("uuid-1");
    expect(d2Socket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(0);
    expect(allSocket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(1);
  });

  it("yields zero events to a stale/retired deviceSessionUuid filter (AC4)", () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    resolver.retire("device-1").bind("device-1", "uuid-1b");

    server.pushTelemetryEvent({
      category: "network",
      timestamp: 1000,
      deviceId: "device-1",
      sessionId: null,
      data: { method: "GET", url: "/test", statusCode: 200, durationMs: 10 },
    });

    expect(socket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(0);
  });

  it("filters by both category and deviceSessionUuid", () => {
    const { socket } = server.simulateSubscription({
      category: "log",
      deviceSessionUuid: "uuid-1",
    });

    const matchEvent: TelemetryEvent = {
      category: "log",
      timestamp: 1000,
      deviceId: "device-1",
      sessionId: null,
      data: { level: 4, tag: "t", message: "m" },
    };
    const wrongCategory: TelemetryEvent = {
      category: "network",
      timestamp: 2000,
      deviceId: "device-1",
      sessionId: null,
      data: { method: "GET", url: "/x", statusCode: 200, durationMs: 0 },
    };
    const wrongDevice: TelemetryEvent = {
      category: "log",
      timestamp: 3000,
      deviceId: "device-2",
      sessionId: null,
      data: { level: 4, tag: "t", message: "m" },
    };

    server.pushTelemetryEvent(matchEvent);
    server.pushTelemetryEvent(wrongCategory);
    server.pushTelemetryEvent(wrongDevice);

    expect(socket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(1);
  });

  it("skips subscribers that are backfilling", () => {
    const { socket, subscriptionId } = server.simulateSubscription({});

    // Simulate backfill in progress
    const subscriber = server.getSubscriber(subscriptionId)!;
    subscriber.backfilling = true;

    const event: TelemetryEvent = {
      category: "log",
      timestamp: 1000,
      deviceId: null,
      sessionId: null,
      data: { level: 4, tag: "Test", message: "during backfill" },
    };

    server.pushTelemetryEvent(event);

    // Should not receive the event while backfilling
    expect(socket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(0);

    // After backfill completes, events should flow again
    subscriber.backfilling = false;

    server.pushTelemetryEvent(event);
    expect(socket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(1);
  });
});

/**
 * Regression test for issue #4209.
 *
 * The crash/ANR/tool-failure branch of `backfillRecentEvents` reads
 * `r.sessionId`, but its `failure_occurrences` projection did not SELECT
 * `session_id`. That was simultaneously a `tsc` error (TS2339, which had been
 * absorbed into the typecheck baseline) and a live runtime bug: the read was
 * always `undefined`, so every backfilled failure event shipped
 * `sessionId: null` and was invisible to session-filtered subscribers.
 *
 * This pins the projection so the column cannot be dropped from the SELECT
 * again without a red test.
 */
describe("TelemetryPushSocketServer failure backfill (#4209)", () => {
  it("applies the session filter before limiting backfilled crash events", async () => {
    await withInMemorySingletonDatabase(async () => {
      const db = getDatabase();
      await runMigrations(db);

      await db
        .insertInto("failure_groups")
        .values({
          id: "group-1",
          type: "crash",
          signature: "sig-1",
          title: "NullPointerException",
          message: "boom",
          severity: "critical",
          first_occurrence: 1000,
          last_occurrence: 1000,
          total_count: 1,
          unique_sessions: 1,
          stack_trace_json: null,
          tool_call_info_json: null,
        })
        .execute();

      await db
        .insertInto("failure_occurrences")
        .values({
          id: "occ-1",
          group_id: "group-1",
          timestamp: 1000,
          device_id: "emulator-5554",
          device_model: "Pixel",
          os: "34",
          app_version: "1.0.0",
          session_id: "session-abc",
          screen_at_failure: "MainActivity",
          test_name: null,
          test_execution_id: null,
          error_code: null,
          duration_ms: null,
          tool_args_json: null,
        })
        .execute();
      await db
        .insertInto("failure_occurrences")
        .values(
          Array.from({ length: 100 }, (_, index) => ({
            id: `occ-other-${index}`,
            group_id: "group-1",
            timestamp: 2000 + index,
            device_id: "emulator-5554",
            device_model: "Pixel",
            os: "34",
            app_version: "1.0.0",
            session_id: "session-other",
            screen_at_failure: "MainActivity",
            test_name: null,
            test_execution_id: null,
            error_code: null,
            duration_ms: null,
            tool_args_json: null,
          })),
        )
        .execute();

      const server = new TestableTelemetryPushSocketServer(new FakeTimer());
      const socket = new FakeSocket();
      server.seedSubscriber("backfill-test", {
        socket: socket,
        subscriptionId: "backfill-test",
        lastActivity: 0,
        filter: {
          category: "crash",
          deviceSessionUuid: null,
          deviceId: "emulator-5554",
          sessionId: "session-abc",
        },
        backfilling: true,
        drainPending: false,
      });

      const write = socket.write.bind(socket);
      let didWrite: (() => void) | undefined;
      const wrote = new Promise<void>((resolve) => {
        didWrite = resolve;
      });
      socket.write = (data: string | Buffer) => {
        write(data);
        didWrite?.();
        return false;
      };
      const drainingBackfill = server.runBackfill(
        "backfill-test",
        {
          category: "crash",
          deviceSessionUuid: null,
          deviceId: "emulator-5554",
          sessionId: "session-abc",
        },
        socket,
      );
      await wrote;
      // The connection outbox and the backfill waiter each own one drain listener.
      expect(socket.listenerCount("drain")).toBe(2);
      socket.emit("drain");
      await drainingBackfill;
      expect(socket.listenerCount("drain")).toBe(0);

      const messages = socket.getWrittenMessages(telemetryEventPushFrameSchema);
      const crash = messages.find((m) => m.data.category === "crash");
      expect(crash).toBeDefined();
      expect(crash!.data.sessionId).toBe("session-abc");
      expect(crash!.subscriptionId).toBe("backfill-test");

      socket.reset();
      server.seedSubscriber("backfill-test", {
        socket: socket,
        subscriptionId: "backfill-test",
        lastActivity: 0,
        filter: {
          category: "crash",
          deviceSessionUuid: null,
          deviceId: "emulator-5554",
          sessionId: "session-abc",
        },
        backfilling: true,
        drainPending: false,
      });
      const backfill = server.runBackfill(
        "backfill-test",
        {
          category: "crash",
          deviceSessionUuid: null,
          deviceId: "emulator-5554",
          sessionId: "session-abc",
        },
        socket,
      );
      server.removeSubscriber("backfill-test");

      await backfill;

      expect(socket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(0);
    });
  });

  // AC4 for the BACKFILL path (epic #5256): a subscription that named a specific
  // deviceSessionUuid which no longer resolves to a live serial (deviceId === null)
  // must backfill NOTHING — never fall through to an all-devices DB query that would
  // dump every device's history to a stale-uuid subscriber. Discriminating: delete
  // the guard in backfillRecentEvents and the stale case below leaks the crash.
  it("backfills zero events for a specific deviceSessionUuid that no longer resolves (AC4)", async () => {
    await withInMemorySingletonDatabase(async () => {
      const db = getDatabase();
      await runMigrations(db);

      await db
        .insertInto("failure_groups")
        .values({
          id: "group-x",
          type: "crash",
          signature: "sig-x",
          title: "Boom",
          message: "boom",
          severity: "critical",
          first_occurrence: 1000,
          last_occurrence: 1000,
          total_count: 1,
          unique_sessions: 1,
          stack_trace_json: null,
          tool_call_info_json: null,
        })
        .execute();
      await db
        .insertInto("failure_occurrences")
        .values({
          id: "occ-x",
          group_id: "group-x",
          timestamp: 1000,
          device_id: "emulator-5554",
          device_model: "Pixel",
          os: "34",
          app_version: "1.0.0",
          session_id: "session-x",
          screen_at_failure: "MainActivity",
          test_name: null,
          test_execution_id: null,
          error_code: null,
          duration_ms: null,
          tool_args_json: null,
        })
        .execute();

      const server = new TestableTelemetryPushSocketServer(new FakeTimer());

      // Stale/retired uuid: resolves to deviceId === null → the guard suppresses the query.
      const staleSocket = new FakeSocket();
      const staleFilter = {
        category: null,
        deviceSessionUuid: "uuid-retired",
        deviceId: null,
        sessionId: null,
      };
      server.seedSubscriber("stale", {
        socket: staleSocket,
        subscriptionId: "stale",
        lastActivity: 0,
        filter: staleFilter,
        backfilling: true,
        drainPending: false,
      });
      await server.runBackfill("stale", staleFilter, staleSocket);
      expect(staleSocket.getWrittenMessages(telemetryPushFrameSchema)).toHaveLength(0);

      // Contrast: an all-devices subscription (deviceSessionUuid === null) still backfills.
      const allSocket = new FakeSocket();
      const allFilter = {
        category: null,
        deviceSessionUuid: null,
        deviceId: null,
        sessionId: null,
      };
      server.seedSubscriber("all", {
        socket: allSocket,
        subscriptionId: "all",
        lastActivity: 0,
        filter: allFilter,
        backfilling: true,
        drainPending: false,
      });
      await server.runBackfill("all", allFilter, allSocket);
      expect(allSocket.getWrittenMessages(telemetryPushFrameSchema).length).toBeGreaterThan(0);
    });
  });
});

/**
 * Regression (#5851, follow-up to #5600/#5534/#4933): the navigation backfill
 * push must carry the app-SCOPED screenshot URI (`?appId=<app>`), built via
 * `buildNavigationNodeScreenshotUri(node.id, node.app_id)`. An unscoped URI
 * resolves against the daemon's current foreground app — a telemetry-dashboard
 * client following it while a different app is foregrounded gets the wrong
 * app's screenshot or "No current app set". The `app_id` is already SELECTed at
 * the node lookup, so scoping is free.
 */
describe("TelemetryPushSocketServer navigation screenshot URI scoping (#5851)", () => {
  it("backfills a navigation event with an app-scoped screenshot URI", async () => {
    await withInMemorySingletonDatabase(async () => {
      const db = getDatabase();
      await runMigrations(db);

      const APP_B = "com.example.b";
      await db
        .insertInto("navigation_apps")
        .values([{ app_id: "com.example.a" }, { app_id: APP_B }])
        .execute();

      // Colliding "Home" node under app A (a different app) — the same
      // cross-app collision #5534 fixed in the resolver but left in this emitter.
      await db
        .insertInto("navigation_nodes")
        .values({
          app_id: "com.example.a",
          screen_name: "Home",
          first_seen_at: 1000,
          last_seen_at: 1000,
          visit_count: 1,
          back_stack_depth: null,
          task_id: null,
          screenshot_path: "/screens/com.example.a/Home.webp",
        })
        .execute();
      const homeB = await db
        .insertInto("navigation_nodes")
        .values({
          app_id: APP_B,
          screen_name: "Home",
          first_seen_at: 1000,
          last_seen_at: 1000,
          visit_count: 1,
          back_stack_depth: null,
          task_id: null,
          screenshot_path: "/screens/com.example.b/Home.webp",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await db
        .insertInto("navigation_events")
        .values({
          device_id: "emulator-5554",
          timestamp: 2000,
          application_id: APP_B,
          session_id: "session-b",
          destination: "Home",
          source: null,
          arguments_json: null,
          metadata_json: null,
        })
        .execute();

      const server = new TestableTelemetryPushSocketServer(new FakeTimer());
      const socket = new FakeSocket();
      const filter = {
        category: "navigation",
        deviceSessionUuid: null,
        deviceId: "emulator-5554",
        sessionId: null,
      };
      server.seedSubscriber("nav-scope", {
        socket: socket,
        subscriptionId: "nav-scope",
        lastActivity: 0,
        filter,
        backfilling: true,
        drainPending: false,
      });

      await server.runBackfill("nav-scope", filter, socket);

      const messages = socket.getWrittenMessages(navigationScreenshotFrameSchema);
      const nav = messages.find((m) => m.data.category === "navigation");
      expect(nav).toBeDefined();
      expect(nav!.data.data.screenshotUri).toBe(
        `automobile:navigation/nodes/${homeB.id}/screenshot?appId=com.example.b`,
      );
    });
  });
});
