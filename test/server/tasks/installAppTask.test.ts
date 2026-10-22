import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { createAppToolsHarness } from "../../helpers/appToolsHarness";
import {
  resetInstalledAppResourceRefresh,
  setInstalledAppResourceRefresh,
} from "../../../src/server/appTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import type { TaskLeaseHoldRequest } from "../../../src/daemon/tasks/taskLeaseKeepalive";
import { TASK_ELIGIBILITY } from "../../../src/server/tasks/toolCallTasks";
import { FakeTaskManager } from "../../fakes/FakeTaskManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { connect, type Frame } from "../../helpers/mcpTaskWire";
import { installHermeticServerFixture } from "../../helpers/hermeticServerFixture";

/*
 * installApp as an MCP task (#13089, under #4668): the real installApp handler and device-aware
 * pipeline wrapper over a fake InstallApp executor, on the raw wire.
 */

const SESSION = "session-install";
const KEY = "key-install";
const APK = { artifactPath: "/tmp/app.apk" };
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

describe("installApp as an MCP task (#13089)", () => {
  const appTools = createAppToolsHarness();
  let restoreHermetic: () => void;
  let restorePipeline: () => void;
  let timer: FakeTimer;
  let taskManager: FakeTaskManager;
  let holds: TaskLeaseHoldRequest[];
  let releases: string[];
  let server: Awaited<ReturnType<typeof connect>>;
  let invalidations: number;
  /** What the fake install does; it may park until released or aborted. */
  let install: (signal: AbortSignal | undefined) => Promise<Record<string, unknown>>;
  let installSignals: Array<AbortSignal | undefined>;

  beforeAll(async () => {
    restoreHermetic = installHermeticServerFixture();
    // The first createMcpServer registers every real tool; pay that one-time cost here, outside
    // the timed tests, so the first test stays inside the unit-test budget.
    const warm = await connect({
      requestMcpSessionId: KEY,
      taskManager: new FakeTaskManager({ timer: new FakeTimer() }),
      taskEligibleTools: TASK_ELIGIBILITY,
      taskLeaseKeepalive: { hold: () => () => {} },
    });
    await warm.close();
  });
  afterAll(() => restoreHermetic());

  beforeEach(async () => {
    timer = new FakeTimer();
    taskManager = new FakeTaskManager({ timer });
    holds = [];
    releases = [];
    invalidations = 0;
    installSignals = [];
    install = async () => ({ success: true });
    setInstalledAppResourceRefresh({ invalidate: () => invalidations++, notify: async () => {} });
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          baseSessionUuid: SESSION,
          device,
          internalCall: true,
          sessionUuid: SESSION,
          shouldResolveDevice: true,
        }),
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      planLifecycleManager: { afterExecution: async () => {} },
    });
    server = await connect({
      requestMcpSessionId: KEY,
      taskManager,
      taskEligibleTools: TASK_ELIGIBILITY,
      taskLeaseKeepalive: {
        hold: (request) => {
          holds.push(request);
          return () => releases.push(request.taskId);
        },
      },
    });
    // createMcpServer registers the real tools; swap the install collaborator in afterwards.
    appTools.configure("installApp", {
      createInstallApp: () => ({
        execute: async (_artifact, call) => {
          installSignals.push(call?.signal);
          return (await install(call?.signal)) as never;
        },
      }),
    });
  });

  afterEach(async () => {
    await server.close();
    restorePipeline();
    appTools.clear();
    resetInstalledAppResourceRefresh();
    timer.reset();
  });

  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 40; turn++) {
      await Promise.resolve();
    }
  };
  const payloadOf = (result: Frame) => JSON.parse(result.content[0].text);

  test("installApp is task-eligible", () => {
    expect(TASK_ELIGIBILITY({ name: "installApp", args: {} })).toEqual({ onCancel: "abort" });
  });

  test("a non-declaring call gets the synchronous result and no task or hold", async () => {
    const frame = await server.wire.call("installApp", APK, false);
    expect(frame.result.resultType).toBeUndefined();
    expect(payloadOf(frame.result)).toMatchObject({ success: true });
    expect(taskManager.calls).toEqual([]);
    expect(holds).toEqual([]);
  });

  test("a declaring call gets a task whose result equals the synchronous one, holding the session until it settles", async () => {
    const sync = await server.wire.call("installApp", APK, false);
    holds.length = 0;

    let finish!: () => void;
    install = () => new Promise((resolve) => (finish = () => resolve({ success: true })));
    const created = await server.wire.call("installApp", APK, true);
    expect(created.result).toMatchObject({ resultType: "task", status: "working" });
    const taskId = created.result.taskId as string;
    await flush();

    expect(holds).toEqual([{ taskId, ownerKey: KEY, sessionUuid: SESSION }]);
    expect(releases).toEqual([]);
    expect((await server.wire.task("tasks/get", taskId)).result.status).toBe("working");

    finish();
    const done = await server.wire.settled(taskId);
    expect(done.result).toMatchObject({ resultType: "complete", status: "completed" });
    expect(done.result.result).toEqual(sync.result);
    expect(releases).toEqual([taskId]);
  });

  test("a failed install completes the task with the same isError result the synchronous call returns", async () => {
    install = async () => ({ success: false, error: "INSTALL_FAILED_INSUFFICIENT_STORAGE" });
    const sync = await server.wire.call("installApp", APK, false);
    const created = await server.wire.call("installApp", APK, true);
    const done = await server.wire.settled(created.result.taskId as string);

    expect(sync.result.isError).toBe(true);
    expect(JSON.stringify(sync.result)).toContain("INSTALL_FAILED_INSUFFICIENT_STORAGE");
    expect(done.result).toMatchObject({ resultType: "complete", status: "completed" });
    expect(done.result.result).toEqual(sync.result);
    expect(releases).toHaveLength(1);
  });

  test("tasks/cancel aborts the install, cancels the task, releases the hold and refreshes the app inventory", async () => {
    install = (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
          once: true,
        });
      });
    const created = await server.wire.call("installApp", APK, true);
    const taskId = created.result.taskId as string;
    await flush();
    expect(installSignals).toHaveLength(1);
    expect(installSignals[0]?.aborted).toBe(false);

    const ack = await server.wire.task("tasks/cancel", taskId);
    expect(ack.result).toEqual({ resultType: "complete" });
    const done = await server.wire.settled(taskId);

    expect(done.result.status).toBe("cancelled");
    expect(installSignals[0]?.aborted).toBe(true);
    expect(releases).toEqual([taskId]);
    // The interrupted transfer may have left device-side state: the inventory is re-read.
    expect(invalidations).toBe(1);
  });
});
