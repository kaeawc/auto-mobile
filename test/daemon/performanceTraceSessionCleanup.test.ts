import { describe, expect, test } from "bun:test";
import { registerPerformanceTraceSessionCleanup } from "../../src/daemon/performanceTraceSessionCleanup";
import { registerProfilingSessionCleanup } from "../../src/daemon/profilingSessionCleanup";
import { ProfilingRegistry } from "../../src/features/profiling/ProfilingRegistry";
import { PerformanceTraceManager } from "../../src/features/performanceTrace/PerformanceTraceManager";
import type { PerformanceTraceRecorder } from "../../src/features/performanceTrace/PerformanceTraceRecorder";
import type { BootedDevice } from "../../src/models";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeProfilingDevice } from "../fakes/FakeProfilingDevice";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const deviceA: BootedDevice = { deviceId: "emulator-5554", name: "A", platform: "android" };
const deviceB: BootedDevice = { deviceId: "emulator-5556", name: "B", platform: "android" };
const trace = { categories: ["sched" as const], timeLimitMs: 10_000 };

function setup() {
  const stops: string[] = [];
  const stopSignals: Array<AbortSignal | undefined> = [];
  const recorder: PerformanceTraceRecorder = {
    start: async (request) => ({
      artifactPath: `/artifacts/${request.traceId}.perfetto-trace`,
      warnings: [],
      signalled: true,
      stop: async () => {
        stops.push(request.traceId);
        stopSignals.push(getAbortSignal());
      },
      discard: async () => {},
      summarize: async () => ({ summary: {}, warnings: [] }),
    }),
  };
  const traces = new PerformanceTraceManager({
    recorderFor: () => recorder,
    artifactDir: async () => "/artifacts",
    idGenerator: new CountingIdGenerator("t"),
    timer: new FakeTimer(),
  });
  const sessions = new FakeSessionCleanupManager();
  registerPerformanceTraceSessionCleanup(sessions, { manager: () => traces });
  return { traces, sessions, stops, stopSignals };
}

const LEFTOVER = "/data/local/tmp/automobile-trace-t-1.perfetto-trace";

/** A recorder whose stop could not delete its device copy, as the daemon wires the two cleanups. */
function setupWithLeftover() {
  const adb = new FakeProfilingDevice();
  const registry = new ProfilingRegistry();
  const recorder: PerformanceTraceRecorder = {
    start: async (request) => ({
      artifactPath: `/artifacts/${request.traceId}.perfetto-trace`,
      warnings: [],
      signalled: true,
      stop: async () => {
        adb.deviceFiles.set(LEFTOVER, 1);
        registry.addDeviceFile({
          deviceId: request.device.deviceId,
          sessionId: request.ownerSessionUuid,
          remotePath: LEFTOVER,
        });
      },
      discard: async () => {},
      summarize: async () => ({ summary: {}, warnings: [] }),
    }),
  };
  const traces = new PerformanceTraceManager({
    recorderFor: () => recorder,
    artifactDir: async () => "/artifacts",
    idGenerator: new CountingIdGenerator("t"),
    timer: new FakeTimer(),
  });
  const sessions = new FakeSessionCleanupManager();
  // Daemon order: the profiling take runs before the trace stop registers the file.
  registerProfilingSessionCleanup(sessions, { registry, adbFor: () => adb });
  registerPerformanceTraceSessionCleanup(sessions, {
    manager: () => traces,
    registry,
    adbFor: () => adb,
  });
  return { traces, sessions, adb, registry };
}

describe("registerPerformanceTraceSessionCleanup (#18688)", () => {
  test("a session moved off a device stops its trace there as pending device cleanup", async () => {
    const { traces, sessions, stops } = setup();
    await traces.start(deviceA, { ...trace, ownerSessionUuid: "s-1" });

    sessions.unbind("s-1", deviceA.deviceId);
    expect(sessions.pendingCleanups.map(({ deviceId, bound }) => [deviceId, bound])).toEqual([
      [deviceA.deviceId, { name: expect.any(String), leftover: expect.any(String) }],
    ]);
    await sessions.settle();

    expect(stops).toEqual(["trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual([]);
    await expect(traces.start(deviceA, trace)).resolves.toMatchObject({ traceId: "trace-t-2" });
  });

  test("a release stops the session's trace through pending device cleanup too", async () => {
    const { traces, sessions, stops } = setup();
    await traces.start(deviceA, { ...trace, ownerSessionUuid: "s-1" });

    sessions.release("s-1", deviceA.deviceId);
    await sessions.settle();

    expect(sessions.pendingCleanups).toHaveLength(1);
    expect(stops).toEqual(["trace-t-1"]);
  });

  test("a release inside an aborted request still stops the trace, outside that request", async () => {
    const { traces, sessions, stops, stopSignals } = setup();
    await traces.start(deviceA, { ...trace, ownerSessionUuid: "s-1" });
    const aborted = new AbortController();
    aborted.abort();

    await runWithAbortSignal(aborted.signal, async () => {
      sessions.release("s-1", deviceA.deviceId);
    });
    await sessions.settle();

    expect(stops).toEqual(["trace-t-1"]);
    expect(stopSignals).toEqual([undefined]);
  });

  test("a device copy the stop could not delete is removed after the stop (#18938)", async () => {
    const { traces, sessions, adb, registry } = setupWithLeftover();
    await traces.start(deviceA, { ...trace, ownerSessionUuid: "s-1" });

    sessions.release("s-1", deviceA.deviceId);
    await sessions.settle();

    expect(adb.deviceFiles.has(LEFTOVER)).toBe(false);
    expect(registry.takeOwnedBy(deviceA.deviceId, "s-1").deviceFiles).toEqual([]);
  });

  test("a leftover that still will not go does not fail the pending cleanup", async () => {
    const { traces, sessions, adb } = setupWithLeftover();
    adb.failing.set("rm -f", "adb: device offline");
    await traces.start(deviceA, { ...trace, ownerSessionUuid: "s-1" });

    sessions.unbind("s-1", deviceA.deviceId);
    await sessions.settle();

    expect(traces.activeTraceIds()).toEqual([]);
    expect(adb.deviceFiles.has(LEFTOVER)).toBe(true);
  });

  test("a release during the session's in-flight start still stops its recorder", async () => {
    const { traces, sessions, stops } = setup();
    const starting = traces.start(deviceA, { ...trace, ownerSessionUuid: "s-1" });

    sessions.release("s-1", deviceA.deviceId);
    expect(sessions.pendingCleanups).toHaveLength(1);
    await starting;
    await sessions.settle();

    expect(stops).toEqual(["trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual([]);
  });

  test("a release stops a sessionless trace on its device as pending device cleanup (#19316)", async () => {
    const { traces, sessions, stops } = setup();
    await traces.start(deviceA, trace);

    sessions.release("s-1", deviceA.deviceId);
    expect(sessions.pendingCleanups.map(({ deviceId }) => deviceId)).toEqual([deviceA.deviceId]);
    await sessions.settle();

    expect(stops).toEqual(["trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual([]);
  });

  test("a rebind and a replaced device leave a sessionless trace alone", async () => {
    const { traces, sessions, stops } = setup();
    await traces.start(deviceA, trace);

    sessions.unbind("s-1", deviceA.deviceId);
    sessions.release("s-1", deviceA.deviceId, false, true);
    await sessions.settle();

    expect(sessions.pendingCleanups).toEqual([]);
    expect(stops).toEqual([]);
    expect(traces.activeTraceIds()).toEqual(["trace-t-1"]);
  });

  test("other sessions, other devices and upgrades are left alone", async () => {
    const { traces, sessions, stops } = setup();
    await traces.start(deviceA, { ...trace, ownerSessionUuid: "s-1" });
    await traces.start(deviceB, trace);

    sessions.unbind("s-2", deviceA.deviceId);
    sessions.unbind("s-1", deviceB.deviceId);
    sessions.release("s-1", deviceA.deviceId, true);
    await sessions.settle();

    expect(sessions.pendingCleanups).toEqual([]);
    expect(stops).toEqual([]);
    expect(traces.activeTraceIds()).toEqual(["trace-t-1", "trace-t-2"]);
  });

  test("a replaced device drops the session's trace without signalling it", async () => {
    const { traces, sessions, stops } = setup();
    await traces.start(deviceA, { ...trace, ownerSessionUuid: "s-1" });
    await traces.start(deviceB, trace);

    sessions.release("s-1", deviceA.deviceId, false, true);
    await sessions.settle();

    expect(sessions.pendingCleanups).toEqual([]);
    expect(stops).toEqual([]);
    expect(traces.activeTraceIds()).toEqual(["trace-t-2"]);
    await expect(traces.start(deviceA, trace)).resolves.toMatchObject({ traceId: "trace-t-3" });
  });
});
