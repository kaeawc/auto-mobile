import { describe, it, expect, beforeEach } from "bun:test";
import { Socket } from "node:net";
import {
  TelemetryPushSocketServer,
  boundBackfillEventText,
} from "../../src/daemon/telemetryPushSocketServer";
import { boundStructuredField } from "../../src/utils/truncateBodyText";
import type { TelemetryEvent } from "../../src/features/telemetry/TelemetryRecorder";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeDeviceSessionResolver } from "../fakes/FakeDeviceSessionResolver";
import { withInMemorySingletonDatabase } from "../db/inMemorySingletonDatabase";
import { getDatabase } from "../../src/db/database";
import { runMigrations } from "../../src/db/migrator";
import type { Database } from "../../src/db/types";
import type { Kysely } from "kysely";

/**
 * Test helper that wraps TelemetryPushSocketServer to allow injecting fake sockets
 * without requiring real network connections.
 */
class TestableTelemetryPushSocketServer extends TelemetryPushSocketServer {
  constructor(timer: FakeTimer) {
    super("/fake/path/telemetry-push.sock", timer);
  }

  async startFake(): Promise<void> {
    (this as any).server = { listening: true };
    (this as any).onServerStarted();
  }

  async closeFake(): Promise<void> {
    (this as any).onServerClosing();
    (this as any).server = null;
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
    const subscriptionId = `telemetrypush-${++(this as any).subscriptionCounter}`;
    const timer = (this as any).timer as FakeTimer;
    this.subscribers.set(subscriptionId, {
      socket: socket as unknown as Socket,
      subscriptionId,
      lastActivity: timer.now(),
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
      const timer = (this as any).timer as FakeTimer;
      subscriber.lastActivity = timer.now();
    }
  }

  triggerKeepalive(): void {
    (this as any).checkKeepalive();
  }
}

describe("boundBackfillEventText", () => {
  it("caps a large log message at 10KB", () => {
    const event: TelemetryEvent = {
      category: "log",
      timestamp: 1,
      deviceId: null,
      data: { level: 4, tag: "t", message: "m".repeat(50_000) },
    };
    const bounded = boundBackfillEventText(event);
    expect((bounded.data as { message: string }).message.length).toBe(10_240);
  });

  it("caps large storage value and previousValue at 10KB", () => {
    const event: TelemetryEvent = {
      category: "storage",
      timestamp: 1,
      deviceId: null,
      data: {
        key: "k",
        value: "v".repeat(30_000),
        previousValue: "p".repeat(30_000),
        valueType: "string",
      },
    };
    const bounded = boundBackfillEventText(event);
    const data = bounded.data as { value: string; previousValue: string };
    expect(data.value.length).toBe(10_240);
    expect(data.previousValue.length).toBe(10_240);
  });

  it("leaves small fields and unrelated categories untouched", () => {
    const event: TelemetryEvent = {
      category: "log",
      timestamp: 1,
      deviceId: null,
      data: { level: 4, tag: "t", message: "small" },
    };
    const bounded = boundBackfillEventText(event);
    expect((bounded.data as { message: string }).message).toBe("small");

    const os: TelemetryEvent = {
      category: "os",
      timestamp: 1,
      deviceId: null,
      data: { category: "lifecycle", kind: "foreground", details: null },
    };
    expect(boundBackfillEventText(os)).toEqual(os);
  });

  it("does not split a surrogate pair in a bounded field", () => {
    const event: TelemetryEvent = {
      category: "log",
      timestamp: 1,
      deviceId: null,
      data: { level: 4, tag: "t", message: "m".repeat(10_239) + "😀" + "n".repeat(50) },
    };
    const bounded = boundBackfillEventText(event);
    const msg = (bounded.data as { message: string }).message;
    expect(msg.length).toBe(10_239);
    expect(msg.isWellFormed()).toBe(true);
  });

  it("replaces an oversized os details object with a valid-JSON marker", () => {
    const bigDetails = { blob: "x".repeat(50_000) };
    const event: TelemetryEvent = {
      category: "os",
      timestamp: 1,
      deviceId: null,
      data: { category: "lifecycle", kind: "foreground", details: bigDetails },
    };
    const bounded = boundBackfillEventText(event);
    const details = (bounded.data as { details: unknown }).details as {
      _truncated: boolean;
      bytes: number;
    };
    expect(details._truncated).toBe(true);
    expect(details.bytes).toBe(JSON.stringify(bigDetails).length);
    // Result must round-trip through JSON.parse (dashboard contract).
    expect(() => JSON.parse(JSON.stringify(bounded.data))).not.toThrow();
  });

  it("leaves a small os details object untouched", () => {
    const details = { screen: "Home", extra: 1 };
    const event: TelemetryEvent = {
      category: "os",
      timestamp: 1,
      deviceId: null,
      data: { category: "lifecycle", kind: "foreground", details },
    };
    const bounded = boundBackfillEventText(event);
    expect((bounded.data as { details: unknown }).details).toBe(details);
  });

  it("replaces an oversized layout detailsJson raw string with a marker", () => {
    const raw = JSON.stringify({ frames: "y".repeat(50_000) });
    const event: TelemetryEvent = {
      category: "layout",
      timestamp: 1,
      deviceId: null,
      data: { composableId: "c", detailsJson: raw },
    };
    const bounded = boundBackfillEventText(event);
    const dj = (bounded.data as { detailsJson: unknown }).detailsJson as {
      _truncated: boolean;
      bytes: number;
    };
    expect(dj._truncated).toBe(true);
    expect(dj.bytes).toBe(raw.length);
  });

  it("leaves a small layout detailsJson string untouched", () => {
    const raw = JSON.stringify({ ok: true });
    const event: TelemetryEvent = {
      category: "layout",
      timestamp: 1,
      deviceId: null,
      data: { composableId: "c", detailsJson: raw },
    };
    const bounded = boundBackfillEventText(event);
    expect((bounded.data as { detailsJson: unknown }).detailsJson).toBe(raw);
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
    const bounded = boundStructuredField(frames, false) as {
      _truncated: boolean;
      bytes: number;
    };
    expect(bounded._truncated).toBe(true);
    expect(bounded.bytes).toBe(JSON.stringify(frames).length);
    expect(() => JSON.parse(JSON.stringify(bounded))).not.toThrow();
  });

  it("measures raw JSON strings by their own length when isJsonString", () => {
    const raw = "z".repeat(20_000);
    const bounded = boundStructuredField(raw, true) as { bytes: number };
    expect(bounded.bytes).toBe(20_000);
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
      data: { method: "GET", url: "/users", statusCode: 200, durationMs: 42 },
    };

    server.pushTelemetryEvent(event);

    const msgs1 = socket1.getWrittenMessages<{ type: string; data?: TelemetryEvent }>();
    const msgs2 = socket2.getWrittenMessages<{ type: string; data?: TelemetryEvent }>();

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
      data: { method: "GET", url: "/users", statusCode: 200, durationMs: 42 },
    };

    server.pushTelemetryEvent(networkEvent);

    expect(networkSocket.getWrittenMessages()).toHaveLength(1);
    expect(logSocket.getWrittenMessages()).toHaveLength(0);
    expect(allSocket.getWrittenMessages()).toHaveLength(1);
  });

  it("pushes different event categories to matching subscribers", () => {
    const { socket: logSocket } = server.simulateSubscription({ category: "log" });

    const logEvent: TelemetryEvent = {
      category: "log",
      timestamp: 2000,
      deviceId: null,
      data: { level: 4, tag: "TestTag", message: "hello" },
    };

    const networkEvent: TelemetryEvent = {
      category: "network",
      timestamp: 3000,
      deviceId: null,
      data: { method: "POST", url: "/submit", statusCode: 201, durationMs: 100 },
    };

    server.pushTelemetryEvent(logEvent);
    server.pushTelemetryEvent(networkEvent);

    const msgs = logSocket.getWrittenMessages<{ type: string; data?: TelemetryEvent }>();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data?.category).toBe("log");
  });

  it("pushes custom events correctly", () => {
    const { socket } = server.simulateSubscription({ category: "custom" });

    const event: TelemetryEvent = {
      category: "custom",
      timestamp: 4000,
      deviceId: null,
      data: { name: "purchase", properties: { item: "premium" } },
    };

    server.pushTelemetryEvent(event);

    const msgs = socket.getWrittenMessages<{ type: string; data?: TelemetryEvent }>();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data?.category).toBe("custom");
  });

  it("pushes os events correctly", () => {
    const { socket } = server.simulateSubscription({ category: "os" });

    const event: TelemetryEvent = {
      category: "os",
      timestamp: 5000,
      deviceId: null,
      data: { category: "lifecycle", kind: "foreground", details: null },
    };

    server.pushTelemetryEvent(event);

    const msgs = socket.getWrittenMessages<{ type: string; data?: TelemetryEvent }>();
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
      data: { method: "GET", url: "/test", statusCode: 200, durationMs: 10 },
    };

    server.pushTelemetryEvent(event);

    const msgs = socket.getWrittenMessages<{
      type: string;
      timestamp: number;
      data?: TelemetryEvent;
    }>();
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

    const d1 = d1Socket.getWrittenMessages<{ data?: TelemetryEvent }>();
    expect(d1).toHaveLength(1);
    // Live events carry the resolved epoch key (AC1).
    expect(d1[0].data?.deviceSessionUuid).toBe("uuid-1");
    expect(d2Socket.getWrittenMessages()).toHaveLength(0);
    expect(allSocket.getWrittenMessages()).toHaveLength(1);
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

    expect(socket.getWrittenMessages()).toHaveLength(0);
  });

  it("filters by both category and deviceSessionUuid", () => {
    const { socket } = server.simulateSubscription({ category: "log", deviceSessionUuid: "uuid-1" });

    const matchEvent: TelemetryEvent = {
      category: "log",
      timestamp: 1000,
      deviceId: "device-1",
      data: { level: 4, tag: "t", message: "m" },
    };
    const wrongCategory: TelemetryEvent = {
      category: "network",
      timestamp: 2000,
      deviceId: "device-1",
      data: { method: "GET", url: "/x", statusCode: 200, durationMs: 0 },
    };
    const wrongDevice: TelemetryEvent = {
      category: "log",
      timestamp: 3000,
      deviceId: "device-2",
      data: { level: 4, tag: "t", message: "m" },
    };

    server.pushTelemetryEvent(matchEvent);
    server.pushTelemetryEvent(wrongCategory);
    server.pushTelemetryEvent(wrongDevice);

    expect(socket.getWrittenMessages()).toHaveLength(1);
  });

  it("skips subscribers that are backfilling", () => {
    const { socket, subscriptionId } = server.simulateSubscription({});

    // Simulate backfill in progress
    const subscriber = server.subscribers.get(subscriptionId)!;
    subscriber.backfilling = true;

    const event: TelemetryEvent = {
      category: "log",
      timestamp: 1000,
      deviceId: null,
      data: { level: 4, tag: "Test", message: "during backfill" },
    };

    server.pushTelemetryEvent(event);

    // Should not receive the event while backfilling
    expect(socket.getWrittenMessages()).toHaveLength(0);

    // After backfill completes, events should flow again
    subscriber.backfilling = false;

    server.pushTelemetryEvent(event);
    expect(socket.getWrittenMessages()).toHaveLength(1);
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
      const db = getDatabase() as unknown as Kysely<Database>;
      await runMigrations(db as unknown as Kysely<unknown>);

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
      (server as any).subscribers.set("backfill-test", {
        socket: socket as unknown as Socket,
        subscriptionId: "backfill-test",
        lastActivity: 0,
        filter: { category: "crash", deviceId: "emulator-5554", sessionId: "session-abc" },
        backfilling: true,
        drainPending: false,
      });

      await (server as any).backfillRecentEvents(
        "backfill-test",
        { category: "crash", deviceId: "emulator-5554", sessionId: "session-abc" },
        socket as unknown as Socket,
      );

      const messages = socket.getWrittenMessages<{ data: TelemetryEvent; subscriptionId: string }>();
      const crash = messages.find((m) => m.data.category === "crash");
      expect(crash).toBeDefined();
      expect(crash!.data.sessionId).toBe("session-abc");
      expect(crash!.subscriptionId).toBe("backfill-test");

      socket.reset();
      (server as any).subscribers.set("backfill-test", {
        socket: socket as unknown as Socket,
        subscriptionId: "backfill-test",
        lastActivity: 0,
        filter: { category: "crash", deviceId: "emulator-5554", sessionId: "session-abc" },
        backfilling: true,
        drainPending: false,
      });
      const backfill = (server as any).backfillRecentEvents(
        "backfill-test",
        { category: "crash", deviceId: "emulator-5554", sessionId: "session-abc" },
        socket as unknown as Socket,
      );
      (server as any).subscribers.delete("backfill-test");

      await backfill;

      expect(socket.getWrittenMessages()).toHaveLength(0);
    });
  });

  // AC4 for the BACKFILL path (epic #5256): a subscription that named a specific
    // deviceSessionUuid which no longer resolves to a live serial (deviceId === null)
    // must backfill NOTHING — never fall through to an all-devices DB query that would
    // dump every device's history to a stale-uuid subscriber. Discriminating: delete
    // the guard in backfillRecentEvents and the stale case below leaks the crash.
    it("backfills zero events for a specific deviceSessionUuid that no longer resolves (AC4)", async () => {
      await withInMemorySingletonDatabase(async () => {
        const db = getDatabase() as unknown as Kysely<Database>;
        await runMigrations(db as unknown as Kysely<unknown>);

        await db
          .insertInto("failure_groups")
          .values({
            id: "group-x", type: "crash", signature: "sig-x", title: "Boom", message: "boom",
            severity: "critical", first_occurrence: 1000, last_occurrence: 1000,
            total_count: 1, unique_sessions: 1, stack_trace_json: null, tool_call_info_json: null,
          })
          .execute();
        await db
          .insertInto("failure_occurrences")
          .values({
            id: "occ-x", group_id: "group-x", timestamp: 1000, device_id: "emulator-5554",
            device_model: "Pixel", os: "34", app_version: "1.0.0", session_id: "session-x",
            screen_at_failure: "MainActivity", test_name: null, test_execution_id: null,
            error_code: null, duration_ms: null, tool_args_json: null,
          })
          .execute();

        const server = new TestableTelemetryPushSocketServer(new FakeTimer());

        // Stale/retired uuid: resolves to deviceId === null → the guard suppresses the query.
        const staleSocket = new FakeSocket();
        const staleFilter = { category: null, deviceSessionUuid: "uuid-retired", deviceId: null, sessionId: null };
        (server as any).subscribers.set("stale", {
          socket: staleSocket as unknown as Socket, subscriptionId: "stale",
          lastActivity: 0, filter: staleFilter, backfilling: true, drainPending: false,
        });
        await (server as any).backfillRecentEvents("stale", staleFilter, staleSocket as unknown as Socket);
        expect(staleSocket.getWrittenMessages()).toHaveLength(0);

        // Contrast: an all-devices subscription (deviceSessionUuid === null) still backfills.
        const allSocket = new FakeSocket();
        const allFilter = { category: null, deviceSessionUuid: null, deviceId: null, sessionId: null };
        (server as any).subscribers.set("all", {
          socket: allSocket as unknown as Socket, subscriptionId: "all",
          lastActivity: 0, filter: allFilter, backfilling: true, drainPending: false,
        });
        await (server as any).backfillRecentEvents("all", allFilter, allSocket as unknown as Socket);
        expect(allSocket.getWrittenMessages().length).toBeGreaterThan(0);
      });
    });
  });
