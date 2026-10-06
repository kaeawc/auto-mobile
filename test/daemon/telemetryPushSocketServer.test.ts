import { Socket } from "node:net";
import { TelemetryPushSocketServer } from "../../src/daemon/telemetryPushSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";

import { streamSubscribeAuthCases } from "../helpers/streamSubscribeAuthCases";
import type { StreamSocketAuthenticator } from "../../src/daemon/streamSocketAuth";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as database from "../../src/db/database";
import * as network from "../../src/db/networkEventRepository";
import * as log from "../../src/db/logEventRepository";
import * as os from "../../src/db/osEventRepository";
import * as navigation from "../../src/db/navigationEventRepository";
import * as storage from "../../src/db/storageEventRepository";
import * as layout from "../../src/db/layoutEventRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeSocket } from "../fakes/FakeNetServer";
import type { TelemetryEvent } from "../../src/features/telemetry/TelemetryRecorder";
import { logger } from "../../src/utils/logger";
import { BODY_TRUNCATION_LIMIT } from "../../src/utils/truncateBodyText";

class AuthTelemetryServer extends TelemetryPushSocketServer {
  private subscribed = 0;
  constructor(timer: FakeTimer, authenticator: StreamSocketAuthenticator) {
    super("/fake/telemetry.sock", timer, { authenticator });
  }
  receive(socket: Socket, line: string): Promise<void> {
    return this.processLine(socket, line);
  }
  protected override onSubscribed(): void {
    this.subscribed++;
  }
  effects(): number {
    return this.subscribed;
  }
}

class EventKeyTelemetryServer extends TelemetryPushSocketServer {
  key(event: TelemetryEvent): string | null {
    return this.pushEventKey(event);
  }
}
streamSubscribeAuthCases(
  "telemetry-push",
  (timer, authenticator) => new AuthTelemetryServer(timer, authenticator),
);

type BackfillFilter = ReturnType<BackfillTelemetryServer["filter"]>;

class BackfillTelemetryServer extends TelemetryPushSocketServer {
  override waitForDrain(socket: Socket): Promise<boolean> {
    return super.waitForDrain(socket);
  }
  filter(category: string | null = null, sessionId: string | null = null) {
    return { category, deviceSessionUuid: null, deviceId: null, sessionId };
  }
  subscribe(socket: Socket, filter: BackfillFilter): void {
    this.subscribers.set("backfill", {
      socket,
      filter,
      subscriptionId: "backfill",
      lastActivity: 0,
      backfilling: true,
      drainPending: false,
    });
    this.startBackfill("backfill");
  }
  unsubscribe(): void {
    this.subscribers.delete("backfill");
  }
  backfill(socket: Socket, filter: BackfillFilter): Promise<void> {
    return this["backfillRecentEvents"]("backfill", filter, socket);
  }
  finish(): Promise<void> {
    return this.finishBackfill("backfill");
  }
}

describe("TelemetryPushSocketServer backfill characterization", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let timer: FakeTimer;
  let server: BackfillTelemetryServer;
  let socket: FakeSocket;
  let restores: Array<() => void>;
  let navigationSpy: ReturnType<typeof spyOn<typeof navigation, "getNavigationEvents">>;
  let networkSpy: ReturnType<typeof spyOn<typeof network, "getNetworkEvents">>;
  let logSpy: ReturnType<typeof spyOn<typeof log, "getLogEvents">>;
  let osSpy: ReturnType<typeof spyOn<typeof os, "getOsEvents">>;
  let storageSpy: ReturnType<typeof spyOn<typeof storage, "getStorageEvents">>;
  let layoutSpy: ReturnType<typeof spyOn<typeof layout, "getLayoutEvents">>;
  let infoSpy: ReturnType<typeof spyOn<typeof logger, "info">>;
  let warnSpy: ReturnType<typeof spyOn<typeof logger, "warn">>;
  const queryOrder: string[] = [];
  const row = (timestamp: number, sessionId: string | null = null) => ({
    timestamp,
    deviceId: "device",
    applicationId: "com.example",
    sessionId,
    destination: "Home",
    source: null,
    arguments: null,
    metadata: null,
  });
  const messages = () => socket.getWrittenMessages<{ data: TelemetryEvent }>();

  beforeAll(async () => {
    // Warm the migrated in-memory template outside the per-test timing budget.
    const template = await createTestDatabase();
    await template.destroy();
  });
  beforeEach(async () => {
    db = await createTestDatabase();
    restores = [];
    queryOrder.length = 0;
    const databaseSpy = spyOn(database, "getDatabase").mockImplementation(() => {
      queryOrder.push("database");
      return db;
    });
    networkSpy = spyOn(network, "getNetworkEvents").mockImplementation(async () => {
      queryOrder.push("network");
      return [];
    });
    logSpy = spyOn(log, "getLogEvents").mockImplementation(async () => {
      queryOrder.push("log");
      return [];
    });
    osSpy = spyOn(os, "getOsEvents").mockImplementation(async () => {
      queryOrder.push("os");
      return [];
    });
    navigationSpy = spyOn(navigation, "getNavigationEvents").mockImplementation(async () => {
      queryOrder.push("navigation");
      return [];
    });
    storageSpy = spyOn(storage, "getStorageEvents").mockImplementation(async () => {
      queryOrder.push("storage");
      return [];
    });
    layoutSpy = spyOn(layout, "getLayoutEvents").mockImplementation(async () => {
      queryOrder.push("layout");
      return [];
    });
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    for (const spy of [
      databaseSpy,
      networkSpy,
      logSpy,
      osSpy,
      navigationSpy,
      storageSpy,
      layoutSpy,
      infoSpy,
      warnSpy,
    ]) {
      restores.push(() => spy.mockRestore());
    }
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    server = new BackfillTelemetryServer("/fake/telemetry.sock", timer, {
      authenticator: { authorize: () => {} },
    });
    socket = new FakeSocket();
  });
  afterEach(async () => {
    for (const restore of restores.reverse()) {
      restore();
    }
    await db.destroy();
  });

  const seedFailure = async (
    id: string,
    stackTrace: string | null,
    deviceId: string | null = "device",
    sessionId = "session",
  ) => {
    await db
      .insertInto("failure_groups")
      .values({
        id,
        type: "crash",
        signature: id,
        title: id,
        message: "boom",
        severity: "critical",
        first_occurrence: 1,
        last_occurrence: 1,
        total_count: 1,
        unique_sessions: 1,
        stack_trace_json: stackTrace,
        tool_call_info_json: null,
      })
      .execute();
    await db
      .insertInto("failure_occurrences")
      .values({
        id,
        group_id: id,
        timestamp: 1,
        device_id: deviceId,
        device_model: "Pixel",
        os: "34",
        app_version: "1",
        session_id: sessionId,
        screen_at_failure: "Home",
        test_name: null,
        test_execution_id: null,
        error_code: null,
        duration_ms: null,
        tool_args_json: null,
      })
      .execute();
  };

  test("retired device epoch returns before every query and write", async () => {
    const filter = { ...server.filter(), deviceSessionUuid: "retired" };
    server.subscribe(socket, filter);
    await server.backfill(socket, filter);
    expect(queryOrder).toEqual([]);
    expect(messages()).toEqual([]);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test("queues distinct overlay sequences during backfill and deduplicates repeated sequence", async () => {
    const filter = server.filter("overlay");
    server.subscribe(socket, filter);
    const overlayEvent = (sequence: number): TelemetryEvent => ({
      category: "overlay",
      timestamp: sequence,
      deviceId: "device",
      sessionId: "session",
      data: { id: "panel", sequence, kind: "page_changed" },
    });
    server.pushTelemetryEvent(overlayEvent(1));
    server.pushTelemetryEvent(overlayEvent(2));
    server.pushTelemetryEvent(overlayEvent(3));
    server.pushTelemetryEvent(overlayEvent(3));
    await server.backfill(socket, filter);
    // Explicitly finish because the harness's manual backfill bypasses onSubscribed.
    await server["finishBackfill"]("backfill");
    expect(messages().map(({ data }) => (data.data as { sequence: number }).sequence)).toEqual([
      1, 2, 3,
    ]);
  });

  test("preserves non-overlay event key serialization", () => {
    const keys = new EventKeyTelemetryServer("/fake/key.sock", timer);
    const base = { timestamp: 1, deviceId: "device", sessionId: "session" } as const;
    expect(keys.key({ ...base, category: "navigation", data: { id: "event" } })).toBe(
      '["navigation","device","session","event"]',
    );
    expect(keys.key({ ...base, category: "toolcall", data: { occurrenceId: 12 } })).toBe(
      '["toolcall","device","session",12]',
    );
  });

  test.each([
    [{ id: "panel", occurrenceId: "ignored", sequenceNumber: 9, requestId: "ignored" }, "panel"],
    [{ id: null, occurrenceId: "panel", sequenceNumber: 9, requestId: "ignored" }, "panel"],
    [{ id: null, occurrenceId: null, sequenceNumber: 0, requestId: "ignored" }, 0],
    [{ requestId: "panel" }, "panel"],
  ] as const)("overlay identity retains id fallback precedence (%j)", (data, id) => {
    const keys = new EventKeyTelemetryServer("/fake/key.sock", timer);
    const base = { timestamp: 1, deviceId: "device", sessionId: "session" } as const;
    expect(keys.key({ ...base, category: "overlay", data: { ...data, sequence: 2 } })).toBe(
      JSON.stringify(["overlay", "device", "session", id, 2]),
    );
    expect(keys.key({ ...base, category: "overlay", data })).toBe(
      JSON.stringify(["overlay", "device", "session", id]),
    );
    expect(keys.key({ ...base, category: "toolcall", data })).toBe(
      JSON.stringify(["toolcall", "device", "session", id]),
    );
  });

  test("overlay identity requires a valid id and a numeric sequence", () => {
    const keys = new EventKeyTelemetryServer("/fake/key.sock", timer);
    const base = {
      category: "overlay",
      timestamp: 1,
      deviceId: "device",
      sessionId: "session",
    } as const;
    expect(keys.key({ ...base, data: { sequence: 2 } })).toBeNull();
    expect(keys.key({ ...base, data: { id: {}, occurrenceId: "panel", sequence: 2 } })).toBeNull();
    expect(keys.key({ ...base, data: { id: "panel", sequence: "2" } })).toBe(
      '["overlay","device","session","panel"]',
    );
  });

  test("keeps query phases in order and skips screenshot lookup for no navigation rows", async () => {
    const filter = server.filter();
    server.subscribe(socket, filter);
    await server.backfill(socket, filter);
    expect(queryOrder).toEqual([
      "network",
      "log",
      "os",
      "navigation",
      "database",
      "database",
      "database",
      "storage",
      "layout",
    ]);
    expect(messages()).toEqual([]);
    expect(infoSpy).toHaveBeenCalledWith("[TelemetryPush] Backfilled 0 events to new subscriber");
  });

  test("looks up colliding screenshot names by app and sorts oldest first", async () => {
    await db
      .insertInto("navigation_apps")
      .values([{ app_id: "com.other" }, { app_id: "com.example" }])
      .execute();
    await db
      .insertInto("navigation_nodes")
      .values({
        app_id: "com.other",
        screen_name: "Home",
        first_seen_at: 1,
        last_seen_at: 1,
        visit_count: 1,
      })
      .execute();
    const node = await db
      .insertInto("navigation_nodes")
      .values({
        app_id: "com.example",
        screen_name: "Home",
        first_seen_at: 1,
        last_seen_at: 1,
        visit_count: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    navigationSpy.mockResolvedValue([row(3), { ...row(1), destination: "Missing" }, row(2)]);
    const filter = server.filter("navigation");
    server.subscribe(socket, filter);
    await server.backfill(socket, filter);
    expect(messages().map((m) => m.data.timestamp)).toEqual([1, 2, 3]);
    expect(messages().map((m) => m.data.data)).toEqual([
      { ...row(1), destination: "Missing", screenshotUri: null },
      {
        ...row(2),
        screenshotUri: `automobile:navigation/nodes/${node.id}/screenshot?appId=com.example`,
      },
      {
        ...row(3),
        screenshotUri: `automobile:navigation/nodes/${node.id}/screenshot?appId=com.example`,
      },
    ]);
    expect(navigationSpy).toHaveBeenCalledWith({
      deviceId: undefined,
      sessionId: undefined,
      limit: 100,
    });
  });

  test("screenshot lookup failure is swallowed and navigation still delivers", async () => {
    navigationSpy.mockResolvedValue([row(1)]);
    await db.schema.dropTable("navigation_nodes").execute();
    const filter = server.filter("navigation");
    server.subscribe(socket, filter);
    await server.backfill(socket, filter);
    expect(messages()[0].data.data).toEqual({ ...row(1), screenshotUri: null });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toStartWith("Telemetry screenshot URI lookup failed:");
  });

  test.each([
    [null, null, undefined],
    ["", null, undefined],
    ["invalid", null, undefined],
    ["{}", null, undefined],
    ["[]", [], undefined],
    [
      '[{"className":"Class","declaringClass":"Fallback"}]',
      [{ className: "Class", declaringClass: "Fallback" }],
      "Class",
    ],
    ['[{"declaringClass":"Fallback"}]', [{ declaringClass: "Fallback" }], "Fallback"],
    ["[null]", [null], undefined],
  ])("preserves stack parsing for %s", async (json, stackTrace, exceptionType) => {
    await seedFailure("failure", json);
    const filter = server.filter("crash");
    server.subscribe(socket, filter);
    await server.backfill(socket, filter);
    expect(messages()).toHaveLength(1);
    expect(messages()[0].data).toMatchObject({
      category: "crash",
      timestamp: 1,
      deviceId: "device",
      sessionId: "session",
      data: {
        type: "crash",
        occurrenceId: "failure",
        groupId: "failure",
        severity: "critical",
        title: "failure",
        ...(exceptionType === undefined ? {} : { exceptionType }),
        screen: "Home",
        timestamp: 1,
        stackTrace,
      },
    });
    if (exceptionType === undefined) {
      expect(messages()[0].data.data).not.toHaveProperty("exceptionType");
    }
    if (json === "invalid" || json === "[null]") {
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toStartWith(
        "Telemetry stored stack trace parse failed:",
      );
    } else {
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  test("reads exception summary before bounding oversized stack traces", async () => {
    await seedFailure(
      "large",
      JSON.stringify([{ className: "Large", message: "x".repeat(BODY_TRUNCATION_LIMIT + 100) }]),
    );
    const filter = server.filter("crash");
    server.subscribe(socket, filter);
    await server.backfill(socket, filter);
    expect(messages()[0].data.data).toMatchObject({
      exceptionType: "Large",
      stackTrace: { _truncated: true },
    });
  });

  test("failure queries exclude empty devices and apply device and session filters", async () => {
    await seedFailure("good", null);
    await seedFailure("null-device", null, null);
    await seedFailure("empty-device", null, "");
    await seedFailure("other-device", null, "other");
    await seedFailure("other-session", null, "device", "other");
    const all = server.filter("crash");
    server.subscribe(socket, all);
    await server.backfill(socket, all);
    expect(
      messages()
        .map((m) => m.data.deviceId)
        .sort(),
    ).toEqual(["device", "device", "other"]);
    socket.resetWrittenData();
    server = new BackfillTelemetryServer("/fake/telemetry.sock", timer, {
      authenticator: { authorize: () => {} },
    });
    const scoped = { ...server.filter("crash", "session"), deviceId: "device" };
    server.subscribe(socket, scoped);
    await server.backfill(socket, scoped);
    expect(messages()).toHaveLength(1);
    expect(messages()[0].data.data).toMatchObject({ occurrenceId: "good" });
  });

  test("failure query errors log per category and allow later phases", async () => {
    await db.schema.dropTable("failure_occurrences").execute();
    const filter = server.filter();
    server.subscribe(socket, filter);
    await server.backfill(socket, filter);
    expect(warnSpy.mock.calls.map(([message]) => String(message).split(" events:")[0])).toEqual([
      "[TelemetryPush] Failed to backfill crash",
      "[TelemetryPush] Failed to backfill anr",
      "[TelemetryPush] Failed to backfill nonfatal",
    ]);
    expect(queryOrder.slice(-2)).toEqual(["storage", "layout"]);
  });

  test.each(["removed", "replaced"])("delivery returns when subscriber is %s", async (mode) => {
    navigationSpy.mockResolvedValue([row(1), row(2)]);
    const filter = server.filter("navigation");
    server.subscribe(socket, filter);
    const write = socket.write.bind(socket);
    spyOn(socket, "write").mockImplementation((data) => {
      const ok = write(data);
      if (mode === "removed") {
        server.unsubscribe();
      } else {
        server.subscribe(new FakeSocket(), filter);
      }
      return ok;
    });
    await server.backfill(socket, filter);
    expect(messages()).toHaveLength(1);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test("session mismatch and duplicate continue without writes or incrementing yield count", async () => {
    navigationSpy.mockResolvedValue([
      row(0, "other"),
      { ...row(1, "session"), id: "duplicate" },
      { ...row(2, "session"), id: "duplicate" },
      ...Array.from({ length: 49 }, (_, i) => row(i + 3, "session")),
    ]);
    const filter = server.filter("navigation", "session");
    server.subscribe(socket, filter);
    await server.backfill(socket, filter);
    expect(messages()).toHaveLength(50);
    expect(messages().map((m) => m.data.timestamp)).toEqual([
      1,
      ...Array.from({ length: 49 }, (_, i) => i + 3),
    ]);
    expect(timer.getSleepHistory()).toEqual([0]);
    expect(infoSpy).toHaveBeenCalledWith("[TelemetryPush] Backfilled 52 events to new subscriber");
  });

  test.each([true, false])(
    "backpressure drain %s controls remaining writes and final log",
    async (drained) => {
      navigationSpy.mockResolvedValue([row(1), row(2)]);
      const filter = server.filter("navigation");
      server.subscribe(socket, filter);
      const write = socket.write.bind(socket);
      const order: string[] = [];
      spyOn(socket, "write").mockImplementation((data) => {
        order.push("write");
        write(data);
        return false;
      });
      const drain = spyOn(server, "waitForDrain").mockImplementation(async () => {
        order.push("drain");
        return drained;
      });
      restores.push(() => drain.mockRestore());
      await server.backfill(socket, filter);
      expect(order).toEqual(drained ? ["write", "drain", "write", "drain"] : ["write", "drain"]);
      expect(timer.getSleepHistory()).toEqual([]);
      expect(infoSpy.mock.calls).toEqual(
        drained ? [["[TelemetryPush] Backfilled 2 events to new subscriber"]] : [],
      );
    },
  );
  describe("live/backfill dedupe identity (#10118)", () => {
    const networkInput = (overrides: Partial<network.NetworkEventWithId> = {}) => ({
      id: 1,
      deviceId: "device",
      sessionId: "session",
      timestamp: 1000,
      applicationId: "com.example",
      url: "https://example.com/a",
      method: "GET",
      statusCode: 200,
      durationMs: 5,
      requestBodySize: -1,
      responseBodySize: -1,
      protocol: null,
      requestId: null,
      connectionId: null,
      direction: null,
      metadata: null,
      sequenceNumber: null,
      host: null,
      path: null,
      error: null,
      requestHeaders: null,
      responseHeaders: null,
      requestBody: null,
      responseBody: null,
      contentType: null,
      ...overrides,
    });
    // The live recorder input carries no row id: it is pushed before it is persisted.
    const liveNetwork = (overrides: Partial<network.NetworkEventWithId> = {}): TelemetryEvent => {
      const data: Partial<network.NetworkEventWithId> = networkInput(overrides);
      delete data.id;
      return {
        category: "network",
        timestamp: data.timestamp ?? 0,
        deviceId: "device",
        sessionId: "session",
        data,
      };
    };
    const sequences = () =>
      messages().map((m) => (m.data.data as { sequenceNumber: number | null }).sequenceNumber);

    // Subscribe, then deliver `live` events either while the backfill is still
    // queued ("before") or after its rows were recorded as seen ("after").
    const run = async (when: "before" | "after", live: TelemetryEvent[]) => {
      const filter = server.filter();
      server.subscribe(socket, filter);
      if (when === "before") {
        live.forEach((event) => server.pushTelemetryEvent(event));
      }
      await server.backfill(socket, filter);
      if (when === "after") {
        live.forEach((event) => server.pushTelemetryEvent(event));
      }
      await server.finish();
    };

    test.each(["before", "after"] as const)(
      "a live network event whose sequence equals an unrelated backfilled row id is delivered (%s)",
      async (when) => {
        networkSpy.mockResolvedValue([networkInput({ id: 21, sequenceNumber: 500 })]);
        await run(when, [liveNetwork({ sequenceNumber: 21, timestamp: 2000 })]);
        expect(sequences().sort()).toEqual([21, 500]);
      },
    );

    test.each(["before", "after"] as const)(
      "the live copy of a backfilled network row is delivered once (%s)",
      async (when) => {
        networkSpy.mockResolvedValue([networkInput({ id: 7, sequenceNumber: 21 })]);
        await run(when, [liveNetwork({ sequenceNumber: 21 })]);
        expect(sequences()).toEqual([21]);
      },
    );

    test("a live copy queued twice during one backfill is delivered once", async () => {
      await run("before", [liveNetwork({ sequenceNumber: 3 }), liveNetwork({ sequenceNumber: 3 })]);
      expect(sequences()).toEqual([3]);
    });

    test("an app restart re-using sequence numbers delivers both launches' events", async () => {
      networkSpy.mockResolvedValue([networkInput({ id: 1, sequenceNumber: 21, timestamp: 1000 })]);
      await run("after", [liveNetwork({ sequenceNumber: 21, timestamp: 9000 })]);
      expect(messages().map((m) => m.data.timestamp)).toEqual([1000, 9000]);
    });

    test("equal sequence numbers from two apps queued during one backfill both arrive", async () => {
      await run("before", [
        liveNetwork({ sequenceNumber: 4, applicationId: "com.one" }),
        liveNetwork({ sequenceNumber: 4, applicationId: "com.two" }),
      ]);
      expect(
        messages().map((m) => (m.data.data as { applicationId: string }).applicationId),
      ).toEqual(["com.one", "com.two"]);
    });

    test("without a sequence number, lifecycle records sharing a requestId all arrive", async () => {
      const lifecycle = (direction: string) =>
        liveNetwork({ requestId: "req-1", direction, timestamp: 1000 });
      await run("before", [lifecycle("request"), lifecycle("response"), lifecycle("response")]);
      expect(messages().map((m) => (m.data.data as { direction: string }).direction)).toEqual([
        "request",
        "response",
      ]);
    });

    test("without a sequence number, the live copy of a stored requestId row is delivered once", async () => {
      networkSpy.mockResolvedValue([
        networkInput({ id: 3, requestId: "req-1", direction: "response" }),
      ]);
      await run("before", [liveNetwork({ requestId: "req-1", direction: "response" })]);
      expect(messages()).toHaveLength(1);
    });

    test("network events with no sequence number or requestId are never deduplicated", async () => {
      networkSpy.mockResolvedValue([networkInput({ id: 5 })]);
      await run("before", [liveNetwork({ timestamp: 1000 })]);
      expect(messages()).toHaveLength(2);
    });

    test.each(["before", "after"] as const)(
      "the live copy of a backfilled crash is delivered once and a different crash is delivered (%s)",
      async (when) => {
        await seedFailure("occ-1", null);
        const crash = (occurrenceId: string): TelemetryEvent => ({
          category: "crash",
          timestamp: 1,
          deviceId: "device",
          sessionId: "session",
          data: { type: "crash", occurrenceId, groupId: occurrenceId, timestamp: 1 },
        });
        await run(when, [crash("occ-1"), crash("occ-2")]);
        const delivered = messages().map(
          (m) => (m.data.data as { occurrenceId: string }).occurrenceId,
        );
        expect(delivered.sort()).toEqual(["occ-1", "occ-2"]);
      },
    );

    // These categories have no id on either path, so there is nothing to
    // match on: a live event is never dropped because a stored row exists.
    const identityFreeCases = [
      [
        "log",
        () =>
          logSpy.mockResolvedValue([
            {
              deviceId: "device",
              timestamp: 1000,
              applicationId: "com.example",
              sessionId: "session",
              level: 4,
              tag: "T",
              message: "m",
              filterName: "f",
            },
          ]),
        { level: 4, tag: "T", message: "m", filterName: "f" },
      ],
      [
        "os",
        () =>
          osSpy.mockResolvedValue([
            {
              deviceId: "device",
              timestamp: 1000,
              applicationId: "com.example",
              sessionId: "session",
              category: "lifecycle",
              kind: "resumed",
              details: null,
            },
          ]),
        { category: "lifecycle", kind: "resumed", details: null },
      ],
      [
        "navigation",
        () => navigationSpy.mockResolvedValue([row(1000, "session")]),
        { destination: "Home", source: null },
      ],
      [
        "storage",
        () =>
          storageSpy.mockResolvedValue([
            {
              deviceId: "device",
              timestamp: 1000,
              applicationId: "com.example",
              sessionId: "session",
              fileName: "prefs",
              key: "k",
              value: "v",
              valueType: "string",
              changeType: "set",
              previousValue: null,
            },
          ]),
        { fileName: "prefs", key: "k", value: "v", changeType: "set" },
      ],
      [
        "layout",
        () =>
          layoutSpy.mockResolvedValue([
            {
              deviceId: "device",
              timestamp: 1000,
              applicationId: "com.example",
              sessionId: "session",
              subType: "recomposition",
              composableName: null,
              composableId: null,
              recompositionCount: null,
              durationMs: null,
              likelyCause: null,
              detailsJson: null,
              screenName: null,
            },
          ]),
        { subType: "recomposition" },
      ],
    ] as const;

    test.each(identityFreeCases)(
      "%s: a live event is never dropped for a stored row",
      async (category, seed, liveData) => {
        seed();
        const live: TelemetryEvent = {
          category,
          timestamp: 1000,
          deviceId: "device",
          sessionId: "session",
          data: { timestamp: 1000, applicationId: "com.example", ...liveData },
        };
        await run("before", [live]);
        expect(messages().map((m) => m.data.category)).toEqual([category, category]);
      },
    );
  });
});
