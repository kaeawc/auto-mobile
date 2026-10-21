import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BootedDevice } from "../../../src/models";
import { VideoRecorderService } from "../../../src/features/video";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { TASK_ELIGIBILITY, taskEligibleByName } from "../../../src/server/tasks/toolCallTasks";
import { resetSegmentedSessions } from "../../../src/server/videoRecordingTools";
import {
  getVideoRecordingMetadata,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
} from "../../../src/daemon/videoRecordingManager";
import type { TaskLeaseHoldRequest } from "../../../src/daemon/tasks/taskLeaseKeepalive";
import { FakeTaskManager } from "../../fakes/FakeTaskManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeVideoCaptureBackend } from "../../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingRepository } from "../../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../../fakes/FakeVideoRecordingConfigRepository";
import { FakeHighlightClient } from "../../fakes/FakeHighlightClient";
import { FakeSecurePermissions } from "../../fakes/FakeSecurePermissions";
import { createVideoRecordingToolsHarness } from "../../helpers/videoRecordingToolsHarness";
import { connect } from "../../helpers/mcpTaskWire";
import { installHermeticServerFixture } from "../../helpers/hermeticServerFixture";
import { toolJson } from "../../helpers/toolResponse";

const SESSION = "video-session";
const KEY = "video-key";
const device: BootedDevice = { deviceId: "fake-video-device", name: "Pixel", platform: "android" };

async function flush(): Promise<void> {
  for (let turn = 0; turn < 80; turn++) {
    await Promise.resolve();
  }
}

describe("videoRecording stop as an MCP task (#13090)", () => {
  const videoTools = createVideoRecordingToolsHarness();
  let restoreHermetic: () => void;
  let restorePipeline: () => void;
  let archiveRoot: string;
  let timer: FakeTimer;
  let manager: FakeTaskManager;
  let backend: FakeVideoCaptureBackend;
  let server: Awaited<ReturnType<typeof connect>>;
  let holds: TaskLeaseHoldRequest[];
  let releases: string[];
  let signals: Array<AbortSignal | undefined>;

  beforeAll(async () => {
    restoreHermetic = installHermeticServerFixture();
    archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "video-stop-task-"));
    // Warm the server connect and one stop outside the per-test budget: the first test otherwise
    // pays the cold MCP setup in its beforeEach (113 ms median on CI for a pure-function test).
    await setUp();
    try {
      await server.wire.call("videoRecording", await activeRecording(), false);
    } finally {
      await tearDown();
    }
  });
  afterAll(async () => {
    restoreHermetic();
    await fs.rm(archiveRoot, { recursive: true, force: true });
  });
  async function setUp(): Promise<void> {
    timer = new FakeTimer();
    manager = new FakeTaskManager({ timer });
    backend = new FakeVideoCaptureBackend();
    backend.setNowProvider(() => new Date(timer.now()));
    holds = [];
    releases = [];
    signals = [];
    await setVideoRecordingManagerDependencies({
      videoRecorderService: new VideoRecorderService({
        backend,
        archiveRoot,
        idGenerator: new FakeIdGenerator(),
        now: () => new Date(timer.now()),
        securePermissions: new FakeSecurePermissions(),
      }),
      recordingRepository: new FakeVideoRecordingRepository(),
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(timer.now()),
    });
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
        run: async (input) => {
          signals.push(input.signal);
          return input.handler(input.device, input.args, input.progress, input.signal);
        },
      },
      afterToolCall: {
        handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      planLifecycleManager: { afterExecution: async () => {} },
    });
    server = await connect({
      requestMcpSessionId: KEY,
      taskManager: manager,
      taskLeaseKeepalive: {
        hold: (request) => {
          holds.push(request);
          return () => releases.push(request.taskId);
        },
      },
    });
    videoTools.configure({
      deviceDetector: { detectConnectedPlatforms: async () => [device] },
      requesterResolver: {
        baseSessionUuid: (uuid) => uuid.split(":")[0],
        connectionOwnsDeviceSession: () => false,
        isDeviceHeld: () => false,
      },
    });
  }
  async function tearDown(): Promise<void> {
    await server.close();
    restorePipeline();
    videoTools.clear();
    resetVideoRecordingManagerDependencies();
    resetSegmentedSessions();
    timer.reset();
  }
  beforeEach(setUp);
  afterEach(tearDown);

  async function activeRecording() {
    const active = await startVideoRecording({ device, ownerSessionUuid: SESSION });
    await fs.writeFile(active.outputPath, "fake-video");
    return { action: "stop", recordingId: active.recordingId, sessionUuid: SESSION };
  }

  function parkStop() {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const stop = backend.stop.bind(backend);
    let calls = 0;
    backend.stop = async (handle) => {
      calls++;
      entered.resolve();
      await gate.promise;
      return stop(handle);
    };
    return { release: () => gate.resolve(), entered: entered.promise, calls: () => calls };
  }

  test("eligibility is per call and existing name allowlists use abort", () => {
    expect(TASK_ELIGIBILITY({ name: "videoRecording", args: { action: "stop" } })).toEqual({
      onCancel: "detach",
    });
    for (const args of [{ action: "start" }, {}, { action: "exportPlan" }]) {
      expect(TASK_ELIGIBILITY({ name: "videoRecording", args })).toBeUndefined();
    }
    for (const name of ["startDevice", "installApp", "executePlan"]) {
      expect(TASK_ELIGIBILITY({ name, args: {} })).toEqual({ onCancel: "abort" });
    }
    for (const name of ["tap", "exportPlan", "unknown"]) {
      expect(TASK_ELIGIBILITY({ name, args: { action: "stop" } })).toBeUndefined();
    }
    const byName = taskEligibleByName(new Set(["custom"]));
    expect(byName({ name: "custom", args: {} })).toEqual({ onCancel: "abort" });
    expect(byName({ name: "other", args: {} })).toBeUndefined();
  });

  test("non-declaring stop is synchronous with no task or hold", async () => {
    const result = await server.wire.call("videoRecording", await activeRecording(), false);
    expect(result.result.resultType).toBeUndefined();
    expect(toolJson(result.result)).toMatchObject({ action: "stop", count: 1 });
    expect(manager.calls).toEqual([]);
    expect(holds).toEqual([]);
    expect(backend.stopCalls).toHaveLength(1);
  });

  test("declaring start stays synchronous with no task", async () => {
    const result = await server.wire.call(
      "videoRecording",
      { action: "start", sessionUuid: SESSION },
      true,
    );
    expect(result.result.resultType).toBeUndefined();
    expect(toolJson(result.result)).toMatchObject({ action: "start", count: 1 });
    expect(manager.calls).toEqual([]);
    expect(holds).toEqual([]);
    // Finalize the fake capture before resetting its dependencies.
    await server.wire.call("videoRecording", { action: "stop", sessionUuid: SESSION }, false);
  });

  test("declaring stop returns a task with exactly the synchronous stop result", async () => {
    const args = await activeRecording();
    const parked = parkStop();
    const created = await server.wire.call("videoRecording", args, true);
    expect(created.result).toMatchObject({ resultType: "task", status: "working" });
    const taskId = created.result.taskId as string;
    await parked.entered;
    try {
      expect(holds).toEqual([{ taskId, ownerKey: KEY, sessionUuid: SESSION }]);
      expect(releases).toEqual([]);
      const synchronous = server.wire.call("videoRecording", args, false);
      await flush();
      parked.release();
      const [sync, done] = await Promise.all([synchronous, server.wire.settled(taskId)]);
      expect(sync.result.isError).not.toBe(true);
      expect(done.result).toMatchObject({ resultType: "complete", status: "completed" });
      expect(done.result.result).toEqual(sync.result);
      expect(releases).toEqual([taskId]);
      expect(parked.calls()).toBe(1);
    } finally {
      parked.release();
    }
  });

  test("cancel ends polling while stop keeps its signal and lease; a second stop joins and the video is retrievable", async () => {
    const args = await activeRecording();
    const parked = parkStop();
    const created = await server.wire.call("videoRecording", args, true);
    const taskId = created.result.taskId as string;
    await parked.entered;
    const workSignal = signals[0];
    try {
      const ack = await server.wire.task("tasks/cancel", taskId);
      expect(ack.result).toEqual({ resultType: "complete" });
      const cancelled = await server.wire.task("tasks/get", taskId);
      expect(cancelled.result.status).toBe("cancelled");
      expect(cancelled.result.statusMessage).toContain("continues");
      expect(workSignal).toBeDefined();
      expect(workSignal?.aborted).toBe(false);
      expect(releases).toEqual([]);
      expect(backend.stopCalls).toHaveLength(0);

      const second = await server.wire.call("videoRecording", args, true);
      const secondId = second.result.taskId as string;
      await flush();
      expect((await server.wire.task("tasks/get", secondId)).result.status).toBe("working");
      expect(parked.calls()).toBe(1);
      expect(releases).toEqual([]);
      parked.release();
      const done = await server.wire.settled(secondId);
      expect(done.result.status).toBe("completed");
      expect(toolJson(done.result.result)).toMatchObject({ action: "stop", count: 1 });
      const final = await server.wire.task("tasks/get", taskId);
      expect(final.result.status).toBe("cancelled");
      expect(final.result.result).toBeUndefined();
      expect(releases.sort()).toEqual([taskId, secondId].sort());
      expect(backend.stopCalls).toHaveLength(1);
      expect(workSignal?.aborted).toBe(false);
      const metadata = await getVideoRecordingMetadata(args.recordingId, {
        ownerSessionUuid: SESSION,
      });
      expect(metadata?.recordingId).toBe(args.recordingId);
      expect(await fs.readFile(metadata!.filePath, "utf8")).toBe("fake-video");
      const retrieved = await server.wire.call("videoRecording", args, false);
      expect(toolJson(retrieved.result)).toMatchObject({
        action: "stop",
        count: 1,
        alreadyStopped: true,
      });
    } finally {
      parked.release();
    }
  });
});
