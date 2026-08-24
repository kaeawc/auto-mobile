import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  DefaultAfterToolCallHandler,
  ToolRegistry,
  ToolRegistryClass,
} from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import type {
  ObservationArtifactPayload,
  ObservationArtifactWriter,
} from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse, stringifyToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeTimer } from "../fakes/FakeTimer";
import { TelemetryRecorder } from "../../src/features/telemetry/TelemetryRecorder";
import {
  getMcpRecordingStatus,
  resetMcpRecordingState,
  startMcpRecording,
} from "../../src/server/mcpRecordingManager";
import {
  stripToolResultStructuredContent,
  structuredContentOmissionReason,
} from "../../src/server/stripToolResultStructuredContent";
import type { ToolOutputArtifactRetention } from "../../src/server/toolOutputArtifactWriter";

describe("ToolRegistry device-aware pipeline", () => {
  const device: BootedDevice = {
    name: "Pixel",
    deviceId: "emulator-5554",
    platform: "android",
  };

  let restorePipelineOverrides: (() => void) | undefined;
  let originalToolCallRepository: unknown;

  beforeEach(() => {
    ToolRegistry.clearTools();
    originalToolCallRepository = (ToolRegistry as any).toolCallRepository;
  });

  afterEach(() => {
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    (ToolRegistry as any).toolCallRepository = originalToolCallRepository;
    serverConfig.setToolOutputsDir(undefined);
    ToolRegistry.clearTools();
  });

  test("stores registerDeviceAware flags from the options bag", () => {
    ToolRegistry.registerDeviceAware(
      "optionsProbe",
      "Options probe",
      z.object({}),
      async () => ({ success: true }),
      {
        supportsProgress: true,
        debugOnly: true,
        embeddedSdkOnly: true,
        planExecutable: true,
        outputSchema: z.object({ success: z.boolean() }),
      },
    );

    const tool = ToolRegistry.getAllTools({ includeUnavailable: true })[0];
    expect(tool.supportsProgress).toBe(true);
    expect(tool.debugOnly).toBe(true);
    expect(tool.embeddedSdkOnly).toBe(true);
    expect(tool.planExecutable).toBe(true);
    expect(tool.outputSchema).toBeDefined();
  });

  test("stores register flags from the options bag", () => {
    ToolRegistry.register(
      "plainOptionsProbe",
      "Plain options probe",
      z.object({}),
      async () => ({ success: true }),
      {
        supportsProgress: true,
        debugOnly: true,
        outputSchema: z.object({ success: z.boolean() }),
      },
    );

    const tool = ToolRegistry.getAllTools({ includeUnavailable: true })[0];
    expect(tool.requiresDevice).toBe(false);
    expect(tool.supportsProgress).toBe(true);
    expect(tool.debugOnly).toBe(true);
    expect(tool.outputSchema).toBeDefined();
  });

  test("wrapped handler delegates to fakeable pipeline collaborators in order", async () => {
    const events: string[] = [];
    const args = { sessionUuid: "session-1", platform: "android" };

    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        async resolveExecutionTarget(input: any) {
          events.push("resolve");
          expect(input.name).toBe("pipelineProbe");
          expect(input.args).toBe(args);
          return {
            args: input.args,
            baseSessionUuid: "session-1",
            device,
            internalCall: false,
            sessionUuid: "session-1",
            shouldResolveDevice: true,
          };
        },
      },
      auditRunner: {
        async run(input: any) {
          events.push("audit");
          return input.handler(input.device, input.args, input.progress, input.signal);
        },
      },
      afterToolCall: {
        async handle(input: any) {
          events.push("after");
          expect(input.name).toBe("pipelineProbe");
          expect(input.response).toEqual({ success: true });
          return {
            durationMs: 7,
            finalizedResponse: { success: true, finalized: true },
          };
        },
      },
      planLifecycleManager: {
        async afterExecution() {
          events.push("planLifecycle");
        },
      },
    });
    (ToolRegistry as any).toolCallRepository = {
      async recordToolCall(record: any) {
        events.push("record");
        expect(record.toolName).toBe("pipelineProbe");
        expect(record.sessionUuid).toBe("session-1");
        expect(record.durationMs).toBe(7);
      },
    };

    ToolRegistry.registerDeviceAware(
      "pipelineProbe",
      "Pipeline probe",
      z.object({}),
      async () => {
        events.push("handler");
        return { success: true };
      },
      { supportsProgress: true },
    );

    const tool = ToolRegistry.getTool("pipelineProbe")!;
    const response = await tool.handler(args);

    expect(response).toEqual({ success: true, finalized: true });
    expect(events).toEqual(["resolve", "audit", "handler", "after", "planLifecycle", "record"]);
  });

  test("logs and continues when best-effort CtrlProxy session bind fails", async () => {
    const fakeDeviceSessionManager = new FakeDeviceSessionManager();
    fakeDeviceSessionManager.setConnectedDevices([device]);
    const originalGetInstance = (AndroidCtrlProxyClient as any).getInstance;
    const log = new FakeLogger();
    const registry = new ToolRegistryClass(undefined, log);

    (registry as any).deviceSessionManager = fakeDeviceSessionManager;
    (registry as any).toolCallRepository = {
      async recordToolCall(): Promise<void> {},
    };
    (AndroidCtrlProxyClient as any).getInstance = () => ({
      bindSession() {
        throw new Error("bind unavailable");
      },
    });
    try {
      registry.registerDeviceAware(
        "bindFailureProbe",
        "Bind failure probe",
        z.object({}),
        async () => ({ success: true }),
      );

      const tool = registry.getTool("bindFailureProbe")!;
      await expect(
        tool.handler({ platform: "android", sessionUuid: "session-1" }),
      ).resolves.toEqual({ success: true });
      expect(log.at("debug")).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining(
            "[ToolRegistry] Best-effort CtrlProxy session bind skipped for bindFailureProbe: Error: bind unavailable",
          ),
        }),
      );
    } finally {
      (AndroidCtrlProxyClient as any).getInstance = originalGetInstance;
    }
  });
});

describe("DefaultAfterToolCallHandler observation artifact config path", () => {
  class FakeObservationArtifactWriter implements ObservationArtifactWriter {
    writes: Array<{ tool: string; payload: string; data: unknown }> = [];
    throwOnWrite: Error | undefined;

    writeJsonArtifact(input: { tool: string; payload: ObservationArtifactPayload; data: unknown }) {
      if (this.throwOnWrite) {
        throw this.throwOnWrite;
      }
      this.writes.push(input);
      return {
        artifact: {
          path: `/tmp/artifacts/${input.tool}-1.json`,
          format: "json" as const,
          payload: input.payload,
          bytes: 123,
          tool: input.tool,
        },
      };
    }
  }

  const makeObservePayload = () => ({
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      hierarchy: {
        node: {
          "resource-id": "com.example:id/root",
          "view-id": "com.example:id/root",
        },
      },
    },
  });

  const makeLargeOcclusionHeavyObservePayload = () => {
    const overlayId = "com.example:id/floating_overlay";
    return {
      updatedAt: 1,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: {
        hierarchy: {
          node: {
            "resource-id": "com.example:id/root",
            "view-id": "com.example:id/root",
            node: [
              {
                "resource-id": overlayId,
                "view-id": overlayId,
                bounds: { left: 850, top: 1500, right: 1030, bottom: 1680 },
                "content-desc": "Compose floating action button",
              },
              ...Array.from({ length: 900 }, (_, index) => ({
                "resource-id": `com.example:id/card_${index}`,
                "view-id": `com.example:id/card_${index}`,
                text: `Occlusion-heavy card row ${index} ${"detail ".repeat(12)}`,
                bounds: { left: 24, top: index * 4, right: 1056, bottom: index * 4 + 120 },
                occlusionState: "partial",
                occludedBy: "Compose floating action button",
                occludedByViewId: overlayId,
              })),
            ],
          },
        },
      },
    };
  };

  afterEach(() => {
    serverConfig.setToolOutputsDir(undefined);
    resetMcpRecordingState();
  });

  test("configured artifact directory creates a writer and replaces observe output metadata", async () => {
    const writer = new FakeObservationArtifactWriter();
    const requestedDirectories: string[] = [];
    const requestedRetentions: Array<ToolOutputArtifactRetention | undefined> = [];
    const handler = new DefaultAfterToolCallHandler((outputDirectory, _timer, retention) => {
      requestedDirectories.push(outputDirectory);
      requestedRetentions.push(retention);
      return writer;
    });
    const timer = new FakeTimer();
    timer.setCurrentTime(25);
    serverConfig.setToolOutputsDir("/tmp/artifacts");

    // Skeleton is the default observe projection now; this test inspects the
    // written full view hierarchy, so request the full projection per-call.
    const result = await handler.handle({
      name: "observe",
      args: { project: "full" },
      device: undefined,
      internalCall: false,
      response: createStructuredToolResponse(makeObservePayload()),
      sessionUuid: "session-1",
      shouldResolveDevice: false,
      timer,
      toolStartMs: 20,
    });

    expect(result.durationMs).toBe(5);
    expect(requestedDirectories).toEqual(["/tmp/artifacts"]);
    expect(requestedRetentions).toEqual([undefined]);
    expect(writer.writes).toHaveLength(1);
    expect((writer.writes[0].data as any).viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
    expect(result.finalizedResponse.structuredContent).toEqual({
      artifact: {
        path: "/tmp/artifacts/observe-1.json",
        format: "json",
        payload: "ObserveResult",
        bytes: 123,
        tool: "observe",
      },
    });
    expect(result.finalizedResponse.content[0].text).toBe(
      stringifyToolResponse(result.finalizedResponse.structuredContent),
    );
  });

  test("oversized occlusion-heavy observe auto-spills to an artifact when no directory is configured", async () => {
    const originalNoStructuredContent = serverConfig.isToolResultsNoStructuredContentEnabled();
    const writer = new FakeObservationArtifactWriter();
    const requestedDirectories: string[] = [];
    const requestedRetentions: Array<ToolOutputArtifactRetention | undefined> = [];
    const handler = new DefaultAfterToolCallHandler((outputDirectory, _timer, retention) => {
      requestedDirectories.push(outputDirectory);
      requestedRetentions.push(retention);
      return writer;
    });
    const timer = new FakeTimer();
    timer.setCurrentTime(25);
    serverConfig.setToolOutputsDir(undefined);
    // Bounds compaction and compact single-line JSON are now unconditional
    // defaults; only no-structured-content remains an opt-in flag.
    serverConfig.setToolResultsNoStructuredContentEnabled(true);

    try {
      const result = await handler.handle({
        name: "observe",
        // Skeleton is the default projection; this test inspects the written full
        // view hierarchy, so request the full projection per-call.
        args: { project: "full" },
        device: undefined,
        internalCall: false,
        response: createStructuredToolResponse(makeLargeOcclusionHeavyObservePayload()),
        sessionUuid: "session-1",
        shouldResolveDevice: false,
        timer,
        toolStartMs: 20,
      });
      const wireResult = stripToolResultStructuredContent(
        result.finalizedResponse,
        structuredContentOmissionReason(true),
      );

      expect(requestedDirectories).toEqual([expect.stringContaining("tool_outputs")]);
      expect(requestedRetentions).toEqual([
        {
          maxAgeMs: 24 * 60 * 60 * 1000,
          maxFiles: 500,
          overflowMinAgeMs: 60 * 60 * 1000,
        },
      ]);
      expect(writer.writes).toHaveLength(1);
      const writtenRoot = (writer.writes[0].data as any).viewHierarchy.hierarchy.node;
      expect(writtenRoot["view-id"]).toBeUndefined();
      expect(writtenRoot.node[0]["view-id"]).toBe("com.example:id/floating_overlay");
      expect(writtenRoot.node[1].occludedByViewId).toBe("com.example:id/floating_overlay");
      expect(writtenRoot.node[1].bounds).toEqual([24, 0, 1056, 120]);
      expect(wireResult.structuredContent).toBeUndefined();
      expect(JSON.parse(wireResult.content[0].text)).toEqual({
        artifact: {
          path: "/tmp/artifacts/observe-1.json",
          format: "json",
          payload: "ObserveResult",
          bytes: 123,
          tool: "observe",
        },
      });
      expect(wireResult.content[0].text).not.toContain("\n");
    } finally {
      serverConfig.setToolResultsNoStructuredContentEnabled(originalNoStructuredContent);
    }
  });

  test("small observe results remain inline when no artifact directory is configured", async () => {
    const writer = new FakeObservationArtifactWriter();
    const handler = new DefaultAfterToolCallHandler(() => writer);
    serverConfig.setToolOutputsDir(undefined);

    const result = await handler.handle({
      name: "observe",
      // Skeleton is the default projection; this test asserts the served full
      // view hierarchy stays inline, so request the full projection per-call.
      args: { project: "full" },
      device: undefined,
      internalCall: false,
      response: createStructuredToolResponse(makeObservePayload()),
      sessionUuid: "session-1",
      shouldResolveDevice: false,
      timer: new FakeTimer(),
      toolStartMs: 0,
    });

    expect(writer.writes).toHaveLength(0);
    expect((result.finalizedResponse.structuredContent as any).viewHierarchy).toBeDefined();
    expect((result.finalizedResponse.structuredContent as any).artifact).toBeUndefined();
    expect(result.finalizedResponse.content[0].text).toBe(
      stringifyToolResponse(result.finalizedResponse.structuredContent),
    );
  });

  test("internal calls bypass configured artifact writers", async () => {
    const writer = new FakeObservationArtifactWriter();
    const requestedDirectories: string[] = [];
    const handler = new DefaultAfterToolCallHandler((outputDirectory) => {
      requestedDirectories.push(outputDirectory);
      return writer;
    });
    serverConfig.setToolOutputsDir("/tmp/artifacts");

    const result = await handler.handle({
      name: "observe",
      // Skeleton is the default projection; this test asserts the full view
      // hierarchy is preserved for internal callers, so request it per-call.
      args: { project: "full" },
      device: undefined,
      internalCall: true,
      response: createStructuredToolResponse(makeObservePayload()),
      sessionUuid: "session-1",
      shouldResolveDevice: false,
      timer: new FakeTimer(),
      toolStartMs: 0,
    });

    expect(requestedDirectories).toEqual([]);
    expect(writer.writes).toHaveLength(0);
    expect((result.finalizedResponse.structuredContent as any).viewHierarchy).toBeDefined();
  });

  test("artifact finalization failures are not recorded as successful tool calls", async () => {
    const writer = new FakeObservationArtifactWriter();
    writer.throwOnWrite = new Error("artifact disk is full");
    const telemetryEvents: unknown[] = [];
    const originalGetInstance = (TelemetryRecorder as any).getInstance;
    (TelemetryRecorder as any).getInstance = () => ({
      recordToolCallEvent(event: unknown) {
        telemetryEvents.push(event);
      },
    });
    const timer = new FakeTimer();
    timer.setCurrentTime(25);
    startMcpRecording(timer);
    serverConfig.setToolOutputsDir("/tmp/artifacts");

    try {
      const handler = new DefaultAfterToolCallHandler(() => writer);

      await expect(
        handler.handle({
          name: "observe",
          args: {},
          device: undefined,
          internalCall: false,
          response: createStructuredToolResponse(makeObservePayload()),
          sessionUuid: "session-1",
          shouldResolveDevice: false,
          timer,
          toolStartMs: 20,
        }),
      ).rejects.toThrow("artifact disk is full");

      expect(telemetryEvents).toHaveLength(0);
      expect(getMcpRecordingStatus(timer)?.stepCount).toBe(0);
    } finally {
      (TelemetryRecorder as any).getInstance = originalGetInstance;
    }
  });

  test("records a structured tool error as its code:message, not [object Object]", async () => {
    const telemetryEvents: Array<{ success: boolean; error: unknown }> = [];
    const originalGetInstance = (TelemetryRecorder as any).getInstance;
    (TelemetryRecorder as any).getInstance = () => ({
      recordToolCallEvent(event: { success: boolean; error: unknown }) {
        telemetryEvents.push(event);
      },
    });
    const timer = new FakeTimer();
    timer.setCurrentTime(25);

    try {
      const handler = new DefaultAfterToolCallHandler();
      // The already-stopped killDevice envelope (issue #1678): the failure code
      // and message live inside a nested `error` object.
      const response = {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              message: "Failed to kill android device: Emulator is not running",
              error: {
                code: "device_already_stopped",
                message: "Failed to kill android device: Emulator is not running",
              },
            }),
          },
        ],
      };

      await handler.handle({
        name: "killDevice",
        args: {},
        device: undefined,
        internalCall: false,
        response,
        sessionUuid: "session-1",
        shouldResolveDevice: false,
        timer,
        toolStartMs: 20,
      });

      expect(telemetryEvents).toHaveLength(1);
      expect(telemetryEvents[0].success).toBe(false);
      expect(telemetryEvents[0].error).toBe(
        "device_already_stopped: Failed to kill android device: Emulator is not running",
      );
    } finally {
      (TelemetryRecorder as any).getInstance = originalGetInstance;
    }
  });
});
