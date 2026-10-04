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
}

describe("TelemetryPushSocketServer backfill characterization", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let timer: FakeTimer;
  let server: BackfillTelemetryServer;
  let socket: FakeSocket;
  let restores: Array<() => void>;
  let navigationSpy: ReturnType<typeof spyOn<typeof navigation, "getNavigationEvents">>;
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
    const networkSpy = spyOn(network, "getNetworkEvents").mockImplementation(async () => {
      queryOrder.push("network");
      return [];
    });
    const logSpy = spyOn(log, "getLogEvents").mockImplementation(async () => {
      queryOrder.push("log");
      return [];
    });
    const osSpy = spyOn(os, "getOsEvents").mockImplementation(async () => {
      queryOrder.push("os");
      return [];
    });
    navigationSpy = spyOn(navigation, "getNavigationEvents").mockImplementation(async () => {
      queryOrder.push("navigation");
      return [];
    });
    const storageSpy = spyOn(storage, "getStorageEvents").mockImplementation(async () => {
      queryOrder.push("storage");
      return [];
    });
    const layoutSpy = spyOn(layout, "getLayoutEvents").mockImplementation(async () => {
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
});
