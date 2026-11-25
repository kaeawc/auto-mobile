import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { SessionReleaseBroadcaster } from "../../src/daemon/sessionReleaseBroadcast";
import { PerformanceTraceStopTimeoutError } from "../../src/features/performanceTrace/PerformanceTraceStopTimeoutError";
import { PerformanceTraceManager } from "../../src/features/performanceTrace/PerformanceTraceManager";
import type { PerformanceTraceRecorder } from "../../src/features/performanceTrace/PerformanceTraceRecorder";
import {
  createPerformanceTraceHandler,
  performanceTraceResultSchema,
  performanceTraceSchema,
  registerPerformanceTraceTools,
  type PerformanceTraceSessionHost,
} from "../../src/server/performanceTraceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolStructured } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

function fakeManager(stopError?: Error) {
  const stops: string[] = [];
  const starts: string[] = [];
  const discards: string[] = [];
  const recorder: PerformanceTraceRecorder = {
    start: async (request) => (
      starts.push(request.traceId),
      {
        artifactPath: `/artifacts/${request.traceId}.perfetto-trace`,
        warnings: [],
        signalled: true,
        stop: async () => {
          stops.push(request.traceId);
          if (stopError) {
            throw stopError;
          }
        },
        discard: async () => {
          discards.push(request.traceId);
        },
        summarize: async () => ({ summary: { durationMs: 900 }, warnings: [] }),
      }
    ),
  };
  const manager = new PerformanceTraceManager({
    recorderFor: () => recorder,
    artifactDir: async () => "/artifacts",
    idGenerator: new CountingIdGenerator("t"),
    timer: new FakeTimer(),
  });
  return { manager, stops, starts, discards };
}

interface FakeSession {
  sessionId: string;
  assignedDevice: string;
}

/** A session host whose one session can be released before or during a tracked start. */
class FakeTraceSessionHost implements PerformanceTraceSessionHost<FakeSession> {
  readonly session: FakeSession = { sessionId: "session-a", assignedDevice: device.deviceId };
  admitted = true;
  /** The release drain gave up: the session ends right after the start finished. */
  releaseDuringStart = false;
  /** The session began releasing before the tracked setup could run. */
  refuseSetup = false;
  tracked = 0;
  readonly pending: Array<{ deviceId: string; cleanup: Promise<unknown> }> = [];

  getSession(sessionId: string): FakeSession | null {
    return sessionId === this.session.sessionId ? this.session : null;
  }

  isAdmittedForAutomation(): boolean {
    return this.admitted;
  }

  async trackSessionSetup(_session: FakeSession, createSetup: () => Promise<void>): Promise<void> {
    if (this.refuseSetup) {
      return;
    }
    this.tracked += 1;
    await createSetup();
    if (this.releaseDuringStart) {
      this.admitted = false;
    }
  }

  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>): void {
    this.pending.push({ deviceId, cleanup });
  }
}

function sessionCall(
  manager: PerformanceTraceManager,
  host: FakeTraceSessionHost,
  args: Record<string, unknown>,
) {
  const handler = createPerformanceTraceHandler(manager, { sessionHost: () => host });
  return handler(device, performanceTraceSchema.parse({ sessionUuid: "session-a", ...args }));
}

async function call(manager: PerformanceTraceManager, args: Record<string, unknown>) {
  const handler = createPerformanceTraceHandler(manager);
  return toolStructured(await handler(device, performanceTraceSchema.parse(args)));
}

describe("performanceTrace tool (#14102)", () => {
  beforeEach(() => ToolRegistry.clearToolsForTesting());
  let unregister: (() => void) | undefined;
  afterEach(() => {
    unregister?.();
    unregister = undefined;
    ToolRegistry.clearToolsForTesting();
  });

  test("is disabled by default and validates start and stop arguments", () => {
    unregister = registerPerformanceTraceTools(fakeManager().manager);
    const tool = ToolRegistry.getTool("performanceTrace")!;

    expect(tool.defaultEnabled).toBe(false);
    expect(tool.schema.safeParse({ action: "start", template: "hitches" }).success).toBe(true);
    expect(tool.schema.safeParse({ action: "start" }).success).toBe(false);
    expect(tool.schema.safeParse({ action: "stop" }).success).toBe(false);
    expect(tool.schema.safeParse({ action: "start", template: "gpu" }).success).toBe(false);
    expect(
      tool.schema.safeParse({ action: "start", template: "hitches", timeLimitMs: 600_000 }).success,
    ).toBe(false);
    expect(
      tool.schema.safeParse({ action: "start", template: "hitches", appId: "rm -rf /" }).success,
    ).toBe(false);
  });

  test("starts and stops a trace with the default time limit", async () => {
    const { manager } = fakeManager();

    const started = await call(manager, {
      action: "start",
      template: "hitches",
      appId: "com.example.app",
    });
    expect(started).toMatchObject({
      success: true,
      action: "start",
      traceId: "trace-t-1",
      state: "recording",
      timeLimitMs: 30_000,
    });

    const stopped = await call(manager, { action: "stop", traceId: "trace-t-1" });
    expect(stopped).toMatchObject({
      success: true,
      action: "stop",
      state: "stopped",
      artifactPath: "/artifacts/trace-t-1.perfetto-trace",
      summary: { durationMs: 900 },
    });
  });

  test("surfaces the typed stop failure through the manager and handler", async () => {
    const error = new PerformanceTraceStopTimeoutError("/artifacts/incomplete.trace", 60000);
    const { manager } = fakeManager(error);
    await call(manager, { action: "start", template: "timeProfiler" });
    await expect(call(manager, { action: "stop", traceId: "trace-t-1" })).rejects.toBe(error);
    expect(manager.activeTraceIds()).toEqual([]);
    expect(manager.lookup("trace-t-1")).toBeUndefined();
  });

  test("a session release stops the traces that session started", async () => {
    const { manager, stops } = fakeManager();
    unregister = registerPerformanceTraceTools(manager);
    await call(manager, { action: "start", template: "hangs", sessionUuid: "session-a" });

    SessionReleaseBroadcaster.emit("session-a");
    await Promise.resolve();
    await Promise.resolve();

    expect(stops).toEqual(["trace-t-1"]);
    expect(manager.activeTraceIds()).toEqual([]);
  });
});

describe("performanceTrace categories (#18688)", () => {
  const issues = (args: Record<string, unknown>) =>
    performanceTraceSchema.safeParse(args).error?.issues.map((issue) => issue.message) ?? [];

  test("accepts typed categories with a buffer size instead of a template", () => {
    const ok = { action: "start", categories: ["gfx", "binder_driver"], bufferMb: 64 };
    expect(performanceTraceSchema.safeParse(ok).success).toBe(true);
    expect(performanceTraceSchema.safeParse({ ...ok, categories: ["raw"] }).success).toBe(false);
    expect(performanceTraceSchema.safeParse({ ...ok, categories: [] }).success).toBe(false);
    expect(performanceTraceSchema.safeParse({ ...ok, bufferMb: 1000 }).success).toBe(false);
    expect(performanceTraceSchema.safeParse({ ...ok, config: "buffers {}" }).success).toBe(false);
  });

  test("refuses template with categories, neither, and bufferMb without categories", () => {
    expect(issues({ action: "start", template: "hitches", categories: ["sched"] })).toEqual([
      "start takes a template or categories, not both",
    ]);
    expect(issues({ action: "start" })).toEqual(["start requires a template or categories"]);
    expect(issues({ action: "start", template: "hitches", bufferMb: 64 })).toEqual([
      "bufferMb applies only with categories",
    ]);
  });

  test("a categories trace returns a schema-valid result with the resolved categories", async () => {
    const { manager } = fakeManager();

    const started = await call(manager, {
      action: "start",
      categories: ["sched"],
      appId: "com.example.app",
    });
    expect(performanceTraceResultSchema.safeParse(started).success).toBe(true);
    expect(started).toMatchObject({ categories: ["sched", "app"], bufferMb: 32 });
    expect(started.template).toBeUndefined();

    const stopped = await call(manager, { action: "stop", traceId: "trace-t-1" });
    expect(performanceTraceResultSchema.safeParse(stopped).success).toBe(true);
  });

  test("iOS refuses a categories start through the handler", async () => {
    const { manager, starts } = fakeManager();
    const handler = createPerformanceTraceHandler(manager);
    const iphone: BootedDevice = { deviceId: "sim-1", name: "iPhone", platform: "ios" };
    await expect(
      handler(iphone, performanceTraceSchema.parse({ action: "start", categories: ["sched"] })),
    ).rejects.toThrow("categories are Android (Perfetto) only");
    expect(starts).toEqual([]);
  });
});

describe("performanceTrace start against session release (#18698)", () => {
  test("a live session's start runs as tracked session setup", async () => {
    const { manager } = fakeManager();
    const host = new FakeTraceSessionHost();

    const started = toolStructured(
      await sessionCall(manager, host, { action: "start", template: "hitches" }),
    );

    expect(started).toMatchObject({ traceId: "trace-t-1", state: "recording" });
    expect(host.tracked).toBe(1);
    expect(host.pending).toEqual([]);
  });

  test("a start on a released session is refused before any recorder runs", async () => {
    const { manager, starts } = fakeManager();
    const host = new FakeTraceSessionHost();
    host.admitted = false;

    await expect(
      sessionCall(manager, host, { action: "start", template: "hitches" }),
    ).rejects.toThrow("Cannot start a performance trace: session is released");
    expect(starts).toEqual([]);
    expect(host.tracked).toBe(0);
  });

  test("a start is refused when the session began releasing before its setup ran", async () => {
    const { manager, starts } = fakeManager();
    const host = new FakeTraceSessionHost();
    host.refuseSetup = true;

    await expect(
      sessionCall(manager, host, { action: "start", template: "hitches" }),
    ).rejects.toThrow("before the trace started; nothing was recorded");
    expect(starts).toEqual([]);
  });

  test("a start that finishes after release is discarded as pending device cleanup", async () => {
    const { manager, starts, stops, discards } = fakeManager();
    const host = new FakeTraceSessionHost();
    host.releaseDuringStart = true;

    await expect(
      sessionCall(manager, host, { action: "start", template: "hitches" }),
    ).rejects.toThrow("trace-t-1 was discarded");

    expect(starts).toEqual(["trace-t-1"]);
    expect(host.pending.map((entry) => entry.deviceId)).toEqual([device.deviceId]);
    await host.pending[0]!.cleanup;
    expect(discards).toEqual(["trace-t-1"]);
    expect(stops).toEqual([]);
    expect(manager.activeTraceIds()).toEqual([]);
  });
});
