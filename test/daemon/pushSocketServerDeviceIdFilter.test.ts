import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Socket } from "node:net";
import { TelemetryPushSocketServer } from "../../src/daemon/telemetryPushSocketServer";
import { FailuresPushSocketServer } from "../../src/daemon/failuresPushSocketServer";
import {
  DEFAULT_THRESHOLDS,
  PerformancePushSocketServer,
  type LivePerformanceData,
} from "../../src/daemon/performancePushSocketServer";
import type { TelemetryEvent } from "../../src/features/telemetry/TelemetryRecorder";
import * as database from "../../src/db/database";
import * as network from "../../src/db/networkEventRepository";
import * as log from "../../src/db/logEventRepository";
import * as os from "../../src/db/osEventRepository";
import * as navigation from "../../src/db/navigationEventRepository";
import * as storage from "../../src/db/storageEventRepository";
import * as layout from "../../src/db/layoutEventRepository";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeDeviceSessionResolver } from "../fakes/FakeDeviceSessionResolver";

// The Kotlin TelemetryPushSocketClient subscribes per device with `deviceId` only; the
// daemon used to read just `deviceSessionUuid`, so every "per-device" subscription was
// acked and silently became all-devices, for live pushes and for backfill (#10143).

interface Reply {
  type: string;
  success?: boolean;
  error?: string;
  code?: string;
  subscriptionId?: string;
  filter?: Record<string, unknown>;
}

interface Pushed<T> {
  type: string;
  data: T;
}

interface LineDrivable {
  drive(socket: Socket, line: string): Promise<void>;
  getSubscriberCount(): number;
}

class DrivableTelemetryServer extends TelemetryPushSocketServer implements LineDrivable {
  drive(socket: Socket, line: string): Promise<void> {
    return this.processLine(socket, line);
  }
}

class DrivableFailuresServer extends FailuresPushSocketServer implements LineDrivable {
  drive(socket: Socket, line: string): Promise<void> {
    return this.processLine(socket, line);
  }
}

class DrivablePerformanceServer extends PerformancePushSocketServer implements LineDrivable {
  drive(socket: Socket, line: string): Promise<void> {
    return this.processLine(socket, line);
  }
}

const authenticator = { authorize: () => {} };

async function subscribe(
  server: LineDrivable,
  request: Record<string, unknown>,
  socket: FakeSocket = new FakeSocket(),
): Promise<{ socket: FakeSocket; reply: Reply }> {
  await server.drive(socket, JSON.stringify({ id: "sub-1", command: "subscribe", ...request }));
  const replies = socket.getWrittenMessages<Reply>();
  return { socket, reply: replies[0] };
}

/** Drain the fire-and-forget backfill chain; every query below is a resolved promise. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

function newResolver(): FakeDeviceSessionResolver {
  return new FakeDeviceSessionResolver().bind("device-a", "uuid-a").bind("device-b", "uuid-b");
}

describe("TelemetryPushSocketServer deviceId subscription filter (#10143)", () => {
  let server: DrivableTelemetryServer;
  let resolver: FakeDeviceSessionResolver;
  let spies: Array<{ mockRestore(): void }>;
  const rowFor = (deviceId: string, timestamp: number) => ({
    timestamp,
    deviceId,
    sessionId: null,
    level: "I",
    tag: "T",
    message: `msg-${deviceId}`,
  });
  const rows = [rowFor("device-a", 1), rowFor("device-b", 2), rowFor("device-a", 3)];
  const liveEvent = (deviceId: string): TelemetryEvent => ({
    category: "os",
    timestamp: 10,
    deviceId,
    sessionId: null,
    data: { marker: deviceId },
  });
  const deviceIdsOf = (socket: FakeSocket): Array<string | null> =>
    socket
      .getWrittenMessages<Pushed<TelemetryEvent>>()
      .filter((m) => m.type === "telemetry_push")
      .map((m) => m.data.deviceId);

  beforeEach(() => {
    const none = async () => [];
    spies = [
      // The repository fake honours the deviceId query like the real SQL does.
      spyOn(log, "getLogEvents").mockImplementation(async (query) =>
        rows.filter((r) => query?.deviceId === undefined || r.deviceId === query.deviceId),
      ),
      spyOn(network, "getNetworkEvents").mockImplementation(none),
      spyOn(os, "getOsEvents").mockImplementation(none),
      spyOn(navigation, "getNavigationEvents").mockImplementation(none),
      spyOn(storage, "getStorageEvents").mockImplementation(none),
      spyOn(layout, "getLayoutEvents").mockImplementation(none),
      // Crash/ANR/nonfatal backfill reads the DB and tolerates it being unavailable.
      spyOn(database, "getDatabase").mockImplementation(() => {
        throw new Error("no database in this unit test");
      }),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    server = new DrivableTelemetryServer("/fake/telemetry.sock", new FakeTimer(), {
      authenticator,
    });
    resolver = newResolver();
    server.setDeviceSessionResolver(resolver);
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  it("delivers only the named device's live events to a deviceId-only subscriber", async () => {
    const { socket: a } = await subscribe(server, { deviceId: "device-a" });
    const { socket: b } = await subscribe(server, { deviceId: "device-b" });
    const { socket: all } = await subscribe(server, {});
    await settle();

    server.pushTelemetryEvent(liveEvent("device-b"));
    server.pushTelemetryEvent(liveEvent("device-a"));

    const liveOnly = (socket: FakeSocket) =>
      socket
        .getWrittenMessages<Pushed<TelemetryEvent>>()
        .filter((m) => m.type === "telemetry_push" && m.data.category === "os")
        .map((m) => m.data.deviceId);
    expect(liveOnly(a)).toEqual(["device-a"]);
    expect(liveOnly(b)).toEqual(["device-b"]);
    // Neighbour behaviour that must not change: no key still means every device.
    expect(liveOnly(all)).toEqual(["device-b", "device-a"]);
  });

  it("backfills only the named device's history for a deviceId-only subscriber", async () => {
    const { socket: a } = await subscribe(server, { deviceId: "device-a" });
    const { socket: all } = await subscribe(server, {});
    await settle();

    expect(deviceIdsOf(a)).toEqual(["device-a", "device-a"]);
    expect(deviceIdsOf(all)).toEqual(["device-a", "device-b", "device-a"]);
  });

  it("keeps deviceSessionUuid routing working live and in backfill", async () => {
    const { socket: a } = await subscribe(server, { deviceSessionUuid: "uuid-a" });
    await settle();
    server.pushTelemetryEvent(liveEvent("device-b"));
    server.pushTelemetryEvent(liveEvent("device-a"));

    expect(deviceIdsOf(a)).toEqual(["device-a", "device-a", "device-a"]);
  });

  it("accepts a deviceId and deviceSessionUuid that name the same device", async () => {
    const { reply, socket } = await subscribe(server, {
      deviceId: "device-a",
      deviceSessionUuid: "uuid-a",
    });
    await settle();
    server.pushTelemetryEvent(liveEvent("device-b"));

    expect(reply.success).toBe(true);
    expect(deviceIdsOf(socket)).toEqual(["device-a", "device-a"]);
  });

  it("rejects conflicting deviceId and deviceSessionUuid with a typed error", async () => {
    const { reply } = await subscribe(server, {
      deviceId: "device-a",
      deviceSessionUuid: "uuid-b",
    });

    expect(reply).toMatchObject({
      type: "error",
      success: false,
      code: "SUBSCRIPTION_FILTER_CONFLICT",
    });
    expect(reply.error).toContain("deviceId 'device-a' conflicts with deviceSessionUuid 'uuid-b'");
    expect(server.getSubscriberCount()).toBe(0);
  });

  it("rejects a deviceId paired with a deviceSessionUuid that is not live", async () => {
    const { reply } = await subscribe(server, { deviceId: "device-a", deviceSessionUuid: "gone" });

    expect(reply).toMatchObject({ success: false, code: "SUBSCRIPTION_FILTER_CONFLICT" });
    expect(server.getSubscriberCount()).toBe(0);
  });

  it.each([
    ["blank", "   ", "deviceId must not be blank"],
    ["non-string", 5, "deviceId must be a string or null"],
  ])("rejects a %s deviceId instead of acking a dead subscription", async (_name, value, text) => {
    const { reply } = await subscribe(server, { deviceId: value });

    expect(reply.success).toBe(false);
    expect(reply.error).toContain(text);
    expect(server.getSubscriberCount()).toBe(0);
  });

  it("echoes the effective filter on the ack so an ignored key is detectable", async () => {
    const named = await subscribe(server, { deviceId: "device-a" });
    const unfiltered = await subscribe(server, { deviceID: "device-a" });

    expect(named.reply.filter).toEqual({
      category: null,
      deviceSessionUuid: null,
      deviceId: "device-a",
      sessionId: null,
    });
    // A misspelled key is still not rejected (that would break unseen clients), but the
    // ack now shows it was not applied: the effective filter is all-devices.
    expect(unfiltered.reply.success).toBe(true);
    expect(unfiltered.reply.filter).toMatchObject({ deviceSessionUuid: null, deviceId: null });
  });

  it("withholds history and live frames for a quarantined serial", async () => {
    resolver.quarantine("device-a");
    const { socket } = await subscribe(server, { deviceId: "device-a" });
    await settle();
    server.pushTelemetryEvent(liveEvent("device-a"));

    expect(deviceIdsOf(socket)).toEqual([]);
  });
});

describe("Failures/Performance push servers deviceId subscription filter (#10143)", () => {
  const failure = (deviceId: string) => ({
    occurrenceId: `occ-${deviceId}`,
    groupId: "grp",
    type: "crash" as const,
    severity: "high" as const,
    title: "Boom",
    message: "boom",
    timestamp: 1,
    deviceId,
    deviceSessionUuid: null,
  });
  const perf = (deviceId: string): LivePerformanceData => ({
    deviceId,
    deviceSessionUuid: null,
    packageName: "com.example.app",
    timestamp: 1,
    nodeId: null,
    screenName: null,
    metrics: {
      fps: 60,
      frameTimeMs: 16,
      jankFrames: 0,
      touchLatencyMs: null,
      ttffMs: null,
      ttiMs: null,
      cpuUsagePercent: null,
      memoryUsageMb: null,
    },
    thresholds: DEFAULT_THRESHOLDS,
    health: "healthy",
  });
  const pushedDevices = (socket: FakeSocket, type: string): Array<string | null> =>
    socket
      .getWrittenMessages<Pushed<{ deviceId: string | null }>>()
      .filter((m) => m.type === type)
      .map((m) => m.data.deviceId);

  it("FailuresPushSocketServer routes a deviceId-only subscriber to that device", async () => {
    const server = new DrivableFailuresServer("/fake/failures.sock", new FakeTimer(), {
      authenticator,
    });
    server.setDeviceSessionResolver(newResolver());
    const { socket: a, reply } = await subscribe(server, { deviceId: "device-a" });
    const { socket: all } = await subscribe(server, {});

    server.pushFailure(failure("device-b"));
    server.pushFailure(failure("device-a"));

    expect(pushedDevices(a, "failure_push")).toEqual(["device-a"]);
    expect(pushedDevices(all, "failure_push")).toEqual(["device-b", "device-a"]);
    expect(reply.filter).toMatchObject({ deviceId: "device-a", deviceSessionUuid: null });
  });

  it("FailuresPushSocketServer rejects conflicting device keys", async () => {
    const server = new DrivableFailuresServer("/fake/failures.sock", new FakeTimer(), {
      authenticator,
    });
    server.setDeviceSessionResolver(newResolver());

    const { reply } = await subscribe(server, {
      deviceId: "device-a",
      deviceSessionUuid: "uuid-b",
    });

    expect(reply).toMatchObject({ success: false, code: "SUBSCRIPTION_FILTER_CONFLICT" });
    expect(server.getSubscriberCount()).toBe(0);
  });

  it("PerformancePushSocketServer routes a deviceId-only subscriber to that device", async () => {
    const server = new DrivablePerformanceServer("/fake/performance.sock", new FakeTimer(), {
      authenticator,
    });
    server.setDeviceSessionResolver(newResolver());
    const { socket: a, reply } = await subscribe(server, { deviceId: "device-a" });
    const { socket: all } = await subscribe(server, {});

    server.pushPerformanceData(perf("device-b"));
    server.pushPerformanceData(perf("device-a"));

    expect(pushedDevices(a, "performance_push")).toEqual(["device-a"]);
    expect(pushedDevices(all, "performance_push")).toEqual(["device-b", "device-a"]);
    expect(reply.filter).toMatchObject({ deviceId: "device-a", deviceSessionUuid: null });
  });

  it("PerformancePushSocketServer rejects conflicting device keys", async () => {
    const server = new DrivablePerformanceServer("/fake/performance.sock", new FakeTimer(), {
      authenticator,
    });
    server.setDeviceSessionResolver(newResolver());

    const { reply } = await subscribe(server, {
      deviceId: "device-a",
      deviceSessionUuid: "uuid-b",
    });

    expect(reply).toMatchObject({ success: false, code: "SUBSCRIPTION_FILTER_CONFLICT" });
    expect(server.getSubscriberCount()).toBe(0);
  });
});
