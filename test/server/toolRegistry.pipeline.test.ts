import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";

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
      }
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
      }
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
      { supportsProgress: true }
    );

    const tool = ToolRegistry.getTool("pipelineProbe")!;
    const response = await tool.handler(args);

    expect(response).toEqual({ success: true, finalized: true });
    expect(events).toEqual(["resolve", "audit", "handler", "after", "planLifecycle", "record"]);
  });

  test("logs and continues when best-effort CtrlProxy session bind fails", async () => {
    const fakeDeviceSessionManager = new FakeDeviceSessionManager();
    fakeDeviceSessionManager.setConnectedDevices([device]);
    const originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
    const originalGetInstance = (AndroidCtrlProxyClient as any).getInstance;
    const originalDebug = logger.debug;
    const debugMessages: string[] = [];

    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;
    (ToolRegistry as any).toolCallRepository = {
      async recordToolCall(): Promise<void> {},
    };
    (AndroidCtrlProxyClient as any).getInstance = () => ({
      bindSession() {
        throw new Error("bind unavailable");
      },
    });
    logger.debug = (message: string) => {
      debugMessages.push(message);
    };

    try {
      ToolRegistry.registerDeviceAware(
        "bindFailureProbe",
        "Bind failure probe",
        z.object({}),
        async () => ({ success: true })
      );

      const tool = ToolRegistry.getTool("bindFailureProbe")!;
      await expect(tool.handler({ platform: "android", sessionUuid: "session-1" })).resolves.toEqual({ success: true });
      expect(debugMessages).toEqual([
        expect.stringContaining("[ToolRegistry] Best-effort CtrlProxy session bind skipped for bindFailureProbe: Error: bind unavailable"),
      ]);
    } finally {
      (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
      (AndroidCtrlProxyClient as any).getInstance = originalGetInstance;
      logger.debug = originalDebug;
    }
  });
});
