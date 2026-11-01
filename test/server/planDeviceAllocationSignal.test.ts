import { describe, expect, test } from "bun:test";
import type { DevicePool } from "../../src/daemon/devicePool";
import type { BootedDevice } from "../../src/models";
import { PlanExecutionOrchestrator } from "../../src/server/planExecutionOrchestrator";
import { normalizePlanDevices } from "../../src/utils/plan/PlanDevices";
import { FakePlanVideoRecorder } from "../fakes/FakePlanVideoRecorder";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * A multi-device plan hands the pool allocator its own request signal explicitly (#15671), so the
 * allocation's retry wait and attempts follow the plan's cancellation rather than an ambient read.
 */

type Allocator = Pick<DevicePool, "assignMultipleDevices" | "assignMultipleDevicesByCriteria">;

/** Records the signal each allocator entry point receives. */
function recordingAllocator(): { pool: Allocator; signals: Array<AbortSignal | undefined> } {
  const signals: Array<AbortSignal | undefined> = [];
  const pool: Allocator = {
    assignMultipleDevices: async (sessionIds, _timeoutMs, _platform, signal) => {
      signals.push(signal);
      return new Map(sessionIds.map((id) => [id, `device-${id}`]));
    },
    assignMultipleDevicesByCriteria: async (requests, _timeoutMs, signal) => {
      signals.push(signal);
      return new Map(requests.map((request) => [request.sessionId, `device-${request.sessionId}`]));
    },
  };
  return { pool, signals };
}

function orchestrator(signal: AbortSignal | undefined): PlanExecutionOrchestrator {
  const device: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "Pixel" };
  return new PlanExecutionOrchestrator(
    {
      device,
      signal,
      request: {
        platform: "android",
        planContent: "name: p\nsteps: []\n",
        startStep: 0,
        deviceAllocationTimeoutMs: 5_000,
      },
    },
    { timer: new FakeTimer(), videoRecorder: new FakePlanVideoRecorder() },
  );
}

const LABEL_SESSIONS = { A: "base:A", B: "base:B" };

describe("plan device allocation signal", () => {
  for (const devices of [
    ["A", "B"],
    [
      { label: "A", platform: "android" as const },
      { label: "B", platform: "android" as const },
    ],
  ]) {
    const kind = typeof devices[0] === "string" ? "label" : "criteria";

    test(`a ${kind} plan passes its request signal to the allocator`, async () => {
      const { pool, signals } = recordingAllocator();
      const controller = new AbortController();
      await orchestrator(controller.signal)["requestDeviceAllocation"](
        pool as DevicePool,
        normalizePlanDevices(devices),
        ["A", "B"],
        { labelToSessionMap: LABEL_SESSIONS, sessionIds: Object.values(LABEL_SESSIONS) },
      );
      expect(signals).toHaveLength(1);
      expect(signals[0]).toBe(controller.signal);
    });

    test(`a ${kind} plan with no signal passes none`, async () => {
      const { pool, signals } = recordingAllocator();
      await orchestrator(undefined)["requestDeviceAllocation"](
        pool as DevicePool,
        normalizePlanDevices(devices),
        ["A", "B"],
        { labelToSessionMap: LABEL_SESSIONS, sessionIds: Object.values(LABEL_SESSIONS) },
      );
      expect(signals).toEqual([undefined]);
    });
  }
});
