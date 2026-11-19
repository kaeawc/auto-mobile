import { describe, expect, test } from "bun:test";
import { registerPerformanceTraceSessionCleanup } from "../../src/daemon/performanceTraceSessionCleanup";
import { PerformanceTraceManager } from "../../src/features/performanceTrace/PerformanceTraceManager";
import type { PerformanceTraceRecorder } from "../../src/features/performanceTrace/PerformanceTraceRecorder";
import type { BootedDevice } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const deviceA: BootedDevice = { deviceId: "emulator-5554", name: "A", platform: "android" };
const deviceB: BootedDevice = { deviceId: "emulator-5556", name: "B", platform: "android" };
const trace = { categories: ["sched" as const], timeLimitMs: 10_000 };

function setup() {
  const stops: string[] = [];
  const recorder: PerformanceTraceRecorder = {
    start: async (request) => ({
      artifactPath: `/artifacts/${request.traceId}.perfetto-trace`,
      warnings: [],
      signalled: true,
      stop: async () => void stops.push(request.traceId),
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
  return { traces, sessions, stops };
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

  test("other sessions, other devices, upgrades and replaced devices are left alone", async () => {
    const { traces, sessions, stops } = setup();
    await traces.start(deviceA, { ...trace, ownerSessionUuid: "s-1" });
    await traces.start(deviceB, trace);

    sessions.unbind("s-2", deviceA.deviceId);
    sessions.unbind("s-1", deviceB.deviceId);
    sessions.release("s-1", deviceA.deviceId, true);
    sessions.release("s-1", deviceA.deviceId, false, true);
    await sessions.settle();

    expect(sessions.pendingCleanups).toEqual([]);
    expect(stops).toEqual([]);
    expect(traces.activeTraceIds()).toEqual(["trace-t-1", "trace-t-2"]);
  });
});
