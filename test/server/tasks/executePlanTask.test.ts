import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import { executionTracker } from "../../../src/daemon/executionTracker";
import { ExecutionTrackerPlanExecutionLock } from "../../../src/server/ExecutionTrackerPlanExecutionLock";
import { registerPlanTools } from "../../../src/server/planTools";
import type {
  TaskLeaseHoldRequest,
  TaskLeaseKeepalive,
} from "../../../src/daemon/tasks/taskLeaseKeepalive";
import { TASK_ELIGIBILITY } from "../../../src/server/tasks/toolCallTasks";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import * as videoRecordingManager from "../../../src/daemon/videoRecordingManager";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../../fakes/FakeDisplayInventoryProvider";
import { FakePlanVideoRecorder } from "../../fakes/FakePlanVideoRecorder";
import { FakeTaskManager } from "../../fakes/FakeTaskManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { connect, type Frame } from "../../helpers/mcpTaskWire";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();

/*
 * executePlan as an MCP task (#13088), through the real executePlan handler and plan executor
 * over a fake device target. The plan's steps run a test tool that can be held mid-step on a
 * gate until it is released or its call is aborted.
 */

const KEY = "key-plan";
const SESSION = "plan-session";
const GATE = "__plan_task_gate__";
const phone: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const tablet: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const PLAN = ["name: task-plan", "steps:", `  - tool: ${GATE}`, "    params: {}", ""].join("\n");
const ARGS = { planContent: PLAN, platform: "android", sessionUuid: SESSION };

/** Records what a task holds and releases, in place of the daemon's heartbeat keepalive. */
class RecordingKeepalive implements TaskLeaseKeepalive {
  readonly holds: TaskLeaseHoldRequest[] = [];
  readonly released: string[] = [];

  hold(request: TaskLeaseHoldRequest): () => void {
    this.holds.push(request);
    return () => this.released.push(request.sessionUuid);
  }
}

/** A step held until {@link open} runs or its call is aborted. */
class StepGate {
  aborted = false;
  open: () => void = () => {};
  readonly reached: Promise<void>;
  private markReached: () => void = () => {};

  constructor() {
    this.reached = new Promise<void>((resolve) => (this.markReached = resolve));
  }

  wait(signal: AbortSignal | undefined): Promise<void> {
    this.markReached();
    return new Promise<void>((resolve, reject) => {
      this.open = resolve;
      signal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}

const planLock = new ExecutionTrackerPlanExecutionLock(executionTracker, {
  getScope: () => "session",
});
const planRunning = (sessionUuid = SESSION): boolean =>
  planLock.evaluate({ toolName: "tapOn", sessionUuid }).blocked;

describe("executePlan as an MCP task (#13088)", () => {
  let taskManager: FakeTaskManager;
  let keepalive: RecordingKeepalive;
  let gate: StepGate | undefined;
  let stepsRun: number;
  let restores: Array<() => void>;

  function arrange(): void {
    restores = [];
    gate = undefined;
    stepsRun = 0;
    const recorder = new FakePlanVideoRecorder();
    const spies = [
      spyOn(videoRecordingManager, "startVideoRecording").mockImplementation(
        recorder.startVideoRecording,
      ),
      spyOn(videoRecordingManager, "stopVideoRecording").mockImplementation(
        recorder.stopVideoRecording,
      ),
      spyOn(videoRecordingManager, "rollbackVideoRecordingStart").mockResolvedValue(undefined),
      spyOn(videoRecordingManager, "getVideoRecordingStatus").mockResolvedValue(undefined),
      spyOn(videoRecordingManager, "getVideoRecordingMetadata").mockResolvedValue(null),
    ];
    restores.push(() => spies.forEach((spy) => spy.mockRestore()));
    const devices = new FakeDeviceUtils();
    devices.setBootedDevices("android", [phone, tablet]);
    PlatformDeviceManagerFactory.setInstance(devices);
    restores.push(() => PlatformDeviceManagerFactory.reset());
    restores.push(
      ToolRegistry.setPipelineOverridesForTesting({
        displayInventory: new FakeDisplayInventoryProvider(),
        // Every call lands on the phone, under the session it names.
        executionTargetResolver: {
          resolveExecutionTarget: async (input) => ({
            args: input.args,
            baseSessionUuid: input.args.sessionUuid,
            device: phone,
            internalCall: false,
            sessionUuid: input.args.sessionUuid,
            shouldResolveDevice: true,
          }),
        },
        auditRunner: {
          run: (input) => input.handler(input.device, input.args, input.progress, input.signal),
        },
        afterToolCall: {
          async handle(input) {
            return { durationMs: 0, finalizedResponse: input.response };
          },
        },
        planLifecycleManager: { afterExecution: async () => {} },
      }),
    );
    registerPlanTools();
    ToolRegistry.registerDeviceAware(
      GATE,
      "gate",
      z.object({}).passthrough(),
      async (_device, _args, _progress, signal) => {
        stepsRun++;
        await gate?.wait(signal);
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      },
    );
    taskManager = new FakeTaskManager({ timer: new FakeTimer() });
    keepalive = new RecordingKeepalive();
  }

  function teardown(): void {
    gate?.open();
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
  }

  /** A server for the caller's session key, wired to the fake task manager and keepalive. */
  const request = () =>
    connect({
      sessionContext: { sessionId: KEY },
      taskManager,
      taskLeaseKeepalive: keepalive,
    });

  async function onServer<T>(
    run: (wire: Awaited<ReturnType<typeof request>>["wire"]) => Promise<T>,
  ) {
    const server = await request();
    try {
      return await run(server.wire);
    } finally {
      await server.close();
    }
  }

  // The first plan through the handler loads and compiles the plan pipeline; pay that once here
  // rather than inside a test's 100 ms budget.
  beforeAll(async () => {
    arrange();
    try {
      await onServer((wire) => wire.call("executePlan", ARGS, false));
    } finally {
      teardown();
    }
  });
  beforeEach(arrange);
  afterEach(teardown);

  test("executePlan is task-eligible beside startDevice", () => {
    expect(TASK_ELIGIBILITY({ name: "executePlan", args: {} })).toEqual({ onCancel: "abort" });
  });

  test("a non-declaring call blocks for the plan result and creates no task", async () => {
    const frame = await onServer((wire) => wire.call("executePlan", ARGS, false));

    expect(frame.result.resultType).toBeUndefined();
    expect(frame.result.structuredContent).toMatchObject({ success: true, executedSteps: 1 });
    expect(taskManager.calls).toEqual([]);
    expect(keepalive.holds).toEqual([]);
  });

  test("a declaring call gets a task whose tasks/get result is the synchronous result, holding the plan session until it settles", async () => {
    const sync = await onServer((wire) => wire.call("executePlan", ARGS, false));
    const created = await onServer((wire) => wire.call("executePlan", ARGS, true));
    expect(created.result).toMatchObject({ resultType: "task", status: "working" });
    const taskId = created.result.taskId as string;

    const done = await onServer((wire) => wire.settled(taskId));

    expect(done.result).toMatchObject({ resultType: "complete", status: "completed" });
    expect(done.result.result).toEqual(sync.result);
    expect(keepalive.holds).toEqual([{ taskId, ownerKey: KEY, sessionUuid: SESSION }]);
    expect(keepalive.released).toEqual([SESSION]);
    expect(planRunning()).toBe(false);
  });

  test("tasks/cancel aborts the in-flight step, cancels the task and releases the plan lock", async () => {
    gate = new StepGate();
    const created = await onServer((wire) => wire.call("executePlan", ARGS, true));
    const taskId = created.result.taskId as string;
    await gate.reached;
    // The plan holds its session's lock while it runs, past the request that started it.
    expect(planRunning()).toBe(true);
    expect((await onServer((wire) => wire.task("tasks/get", taskId))).result.status).toBe(
      "working",
    );

    const ack = await onServer((wire) => wire.task("tasks/cancel", taskId));
    const done = await onServer((wire) => wire.settled(taskId));

    expect(ack.result).toEqual({ resultType: "complete" });
    expect(gate.aborted).toBe(true);
    expect(done.result.status).toBe("cancelled");
    expect(planRunning()).toBe(false);
    expect(keepalive.released).toEqual([SESSION]);
  });

  test("a call that fails reports failed with the JSON-RPC error the synchronous call answers", async () => {
    const invalid = { planContent: PLAN, sessionUuid: SESSION };
    const sync = await onServer((wire) => wire.call("executePlan", invalid, false));
    const created = await onServer((wire) => wire.call("executePlan", invalid, true));

    const done: Frame = await onServer((wire) => wire.settled(created.result.taskId));

    expect(sync.error).toMatchObject({ code: -32602 });
    expect(done.result.status).toBe("failed");
    expect(done.result.error).toEqual(sync.error);
  });

  describe("a multi-device plan", () => {
    const LABELED = [
      "name: two-devices",
      "devices:",
      "  - A",
      "  - B",
      "steps:",
      `  - tool: ${GATE}`,
      "    device: A",
      "    params: {}",
      `  - tool: ${GATE}`,
      "    device: B",
      "    params: {}",
      "",
    ].join("\n");

    /** A daemon whose generic allocator gives each label session its own device. */
    async function arrangeDaemon(): Promise<void> {
      const timer = new FakeTimer();
      const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      sessions.stopCleanupTimer();
      const pool = new DevicePool(
        createDevicePoolDependencies(sessions, "plan-task-daemon", {
          timer,
          deviceManager: new FakeDeviceUtils(),
        }),
      );
      await pool.initializeWithDevices([phone, tablet]);
      // The generic allocator stands in: each label session gets its own device.
      pool.assignMultipleDevices = async (sessionIds: string[]) => {
        const assigned = new Map<string, string>();
        for (const [index, sessionId] of sessionIds.entries()) {
          const target = [phone, tablet][index];
          await sessions.createSession(sessionId, target.deviceId, "android");
          assigned.set(sessionId, target.deviceId);
        }
        return assigned;
      };
      DaemonState.getInstance().initialize(sessions, pool);
      restores.push(() => {
        sessions.stopCleanupTimer();
        DaemonState.getInstance().reset();
      });
    }

    // The first label runs on the base session itself; each further label gets its own session.
    test("holds the base session and each label session until the task settles", async () => {
      await arrangeDaemon();
      const args = { ...ARGS, planContent: LABELED, devices: ["A", "B"] };
      const created = await onServer((wire) => wire.call("executePlan", args, true));
      const taskId = created.result.taskId as string;

      const done = await onServer((wire) => wire.settled(taskId));

      expect(done.result.status).toBe("completed");
      expect(done.result.result.structuredContent).toMatchObject({ success: true });
      const held = keepalive.holds.map((hold) => hold.sessionUuid).sort();
      expect(held).toEqual([SESSION, `${SESSION}:B`]);
      expect(stepsRun).toBe(2);
      expect(keepalive.holds.every((hold) => hold.taskId === taskId)).toBe(true);
      expect([...keepalive.released].sort()).toEqual(held);
    });
  });
});
