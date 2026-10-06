import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import {
  PlanExecutionOrchestrator,
  type PlanExecutionRequest,
} from "../../src/server/planExecutionOrchestrator";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

// #10153: a labelled plan started from a session that already holds a device.
const androidA: BootedDevice = { deviceId: "a", name: "a", platform: "android", status: "booted" };
const androidB: BootedDevice = { deviceId: "b", name: "b", platform: "android", status: "booted" };

const request: PlanExecutionRequest = {
  planContent: "name: two-device\nsteps:\n  - tool: observe\n    params: {}\n",
  startStep: 0,
  platform: "android",
  sessionUuid: "base",
  devices: ["A", "B"],
  deviceAllocationTimeoutMs: 300_000,
};

describe("PlanExecutionOrchestrator allocation failure with a caller-held device", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let pool: DevicePool;

  beforeEach(async () => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const discovery = new FakeDeviceManager([], [androidA, androidB]);
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "orchestrator-allocation", {
        timer,
        deviceHealthMarkers: new FakeDeviceHealthMarkers(timer),
        deviceManager: discovery,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(sessions, pool);
    await pool.bindOrReuseDeviceSession("base", "a", "android");
  });

  afterEach(async () => {
    await drainUntilQuiescent(timer);
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const orchestrate = (planRequest?: { deadlineMs: number }) => {
    const orchestrator = new PlanExecutionOrchestrator(
      { device: androidA, request },
      {
        timer,
        createSchemaValidator: () => ({
          loadSchema: async () => undefined,
          validateYaml: () => ({ valid: true }),
        }),
      },
    );
    return runWithToolSelectionContext({ planRequest }, () => orchestrator.execute());
  };

  const expectNothingLeaked = () => {
    expect(sessions.getDeviceLabels("base")).toBeUndefined();
    expect(sessions.getSession("base:B")).toBeNull();
    expect(pool.getDevice("a")?.sessionId).toBe("base");
    expect(sessions.getSession("base")?.assignedDevice).toBe("a");
  };

  test("fails at once, naming the shortfall, when another session holds the other device", async () => {
    await pool.bindOrReuseDeviceSession("other-client", "b", "android");

    const result = await orchestrate();

    expect(result.success).toBe(false);
    expect(result.error).toContain("needs 2 device(s)");
    expect(result.error).toContain("0 matching device(s) are idle");
    expect(result.error).toContain("calling session already holds a");
    expect(timer.now()).toBe(0);
    expectNothingLeaked();
    expect(pool.getDevice("b")?.sessionId).toBe("other-client");
  });

  test("a wait on a running plan's device ends with the request's remaining budget", async () => {
    await pool.bindOrReuseDeviceSession("plan-base", "b", "android");
    sessions.setDeviceLabels("plan-base", { A: "plan-base" });

    // 60 s left on the request, so the 300 s allocation timeout is bounded to 55 s.
    const run = orchestrate({ deadlineMs: 60_000 });
    let outcome: Awaited<typeof run> | undefined;
    void run.then((value) => {
      outcome = value;
    });
    await drainUntilQuiescent(timer);
    expect(outcome).toBeUndefined();

    timer.advanceTime(54_000);
    await drainUntilQuiescent(timer);
    expect(outcome).toBeUndefined();

    timer.advanceTime(2_000);
    await drainUntilQuiescent(timer);
    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain("Timed out allocating devices after 5");
    expect(timer.now()).toBeLessThan(60_000);
    expectNothingLeaked();
    expect(pool.getDevice("b")?.sessionId).toBe("plan-base");
  });
});
