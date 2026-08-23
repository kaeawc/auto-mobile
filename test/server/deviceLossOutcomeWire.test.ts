import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models";
import { DeviceLostError, rememberDeviceLossAbort } from "../../src/server/deviceLossOutcome";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { TerminalSessionError } from "../../src/daemon/sessionManager";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { executionTracker } from "../../src/server/executionTracker";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

describe("device loss MCP outcome", () => {
  const toolName = "__device_lost_wire_probe__";
  const device: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel",
    platform: "android",
  };
  let restorePipelineOverrides: (() => void) | undefined;
  let fixture: McpTestFixture | undefined;
  const originalObserveExecute = RealObserveScreen.prototype.execute;

  afterEach(async () => {
    if (fixture) {
      await fixture.teardown();
      fixture = undefined;
    }
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    RealObserveScreen.prototype.execute = originalObserveExecute;
    ToolRegistry.unregister(toolName);
  });

  test("returns schema-independent device_lost text for an aborted device-aware call", async () => {
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        async resolveExecutionTarget(input) {
          return {
            args: input.args,
            baseSessionUuid: "device-session-a",
            device,
            internalCall: false,
            sessionUuid: "device-session-a",
            shouldResolveDevice: true,
          };
        },
      },
      auditRunner: {
        async run(input) {
          return await input.handler(input.device, input.args, input.progress, input.signal);
        },
      },
      afterToolCall: {
        async handle() {
          throw new Error("device-loss probe should not finalize");
        },
      },
      planLifecycleManager: {
        async afterExecution() {},
      },
    });
    ToolRegistry.registerDeviceAware(
      toolName,
      "device loss wire probe",
      z.object({}),
      async () => {
        throw new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554");
      },
      {
        outputSchema: z.object({
          success: z.boolean(),
        }),
      },
    );
    fixture = new McpTestFixture({
      sessionContext: {
        sessionId: "transport-a",
        initialSessionToolBinding: "device-session-a",
      },
    });
    await fixture.setup();

    const result: any = await fixture.client.callTool({ name: toolName, arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: "device_lost",
      deviceId: "emulator-5554",
      sessionUuid: "device-session-a",
      reason: "confirmed-unavailable",
    });
  });

  test("recovers device loss from an abort signal when a handler wraps cancellation", async () => {
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        async resolveExecutionTarget(input) {
          return {
            args: input.args,
            baseSessionUuid: "device-session-a",
            device,
            internalCall: false,
            sessionUuid: "device-session-a",
            shouldResolveDevice: true,
          };
        },
      },
      auditRunner: {
        async run(input) {
          return await input.handler(input.device, input.args, input.progress, input.signal);
        },
      },
      afterToolCall: {
        async handle() {
          throw new Error("wrapped device-loss probe should not finalize");
        },
      },
      planLifecycleManager: {
        async afterExecution() {},
      },
    });
    ToolRegistry.registerDeviceAware(
      toolName,
      "wrapped device loss wire probe",
      z.object({}),
      async (_device, _args, _progress, signal) => {
        rememberDeviceLossAbort(
          signal!,
          new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554"),
        );
        throw new ActionableError("Failed to install app: operation cancelled");
      },
      {
        outputSchema: z.object({
          success: z.boolean(),
        }),
      },
    );
    fixture = new McpTestFixture({
      sessionContext: {
        sessionId: "transport-a",
        initialSessionToolBinding: "device-session-a",
      },
    });
    await fixture.setup();

    const result: any = await fixture.client.callTool({ name: toolName, arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: "device_lost",
      deviceId: "emulator-5554",
      sessionUuid: "device-session-a",
    });
  });

  test("device loss wins when a handler swallows cancellation and returns a failure result", async () => {
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        async resolveExecutionTarget(input) {
          return {
            args: input.args,
            baseSessionUuid: "device-session-a",
            device,
            internalCall: false,
            sessionUuid: "device-session-a",
            shouldResolveDevice: true,
          };
        },
      },
      auditRunner: {
        async run(input) {
          return await input.handler(input.device, input.args, input.progress, input.signal);
        },
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
      planLifecycleManager: {
        async afterExecution() {},
      },
    });
    ToolRegistry.registerDeviceAware(
      toolName,
      "swallowed device loss wire probe",
      z.object({}),
      async (_device, _args, _progress, signal) => {
        rememberDeviceLossAbort(
          signal!,
          new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554"),
        );
        return {
          content: [{ type: "text" as const, text: "operation cancelled" }],
          structuredContent: { success: false },
        };
      },
      {
        outputSchema: z.object({
          success: z.boolean(),
        }),
      },
    );
    fixture = new McpTestFixture({
      sessionContext: {
        sessionId: "transport-a",
        initialSessionToolBinding: "device-session-a",
      },
    });
    await fixture.setup();

    const result: any = await fixture.client.callTool({ name: toolName, arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: "device_lost",
      deviceId: "emulator-5554",
      sessionUuid: "device-session-a",
    });
  });

  test("cancels an active observe and drains it before resolving device loss", async () => {
    const observeStarted = Promise.withResolvers<void>();
    RealObserveScreen.prototype.execute = async function (options) {
      observeStarted.resolve();
      return await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("observe cancelled")), {
          once: true,
        });
      });
    };
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        async resolveExecutionTarget(input) {
          return {
            args: input.args,
            baseSessionUuid: "device-session-a",
            device,
            internalCall: false,
            sessionUuid: "device-session-a",
            shouldResolveDevice: true,
          };
        },
      },
      auditRunner: {
        async run(input) {
          return await input.handler(input.device, input.args, input.progress, input.signal);
        },
      },
      afterToolCall: {
        async handle() {
          throw new Error("cancelled observe should not finalize");
        },
      },
      planLifecycleManager: {
        async afterExecution() {},
      },
    });
    fixture = new McpTestFixture({
      sessionContext: {
        sessionId: "transport-a",
        initialSessionToolBinding: "device-session-a",
      },
    });
    await fixture.setup();

    const resultPromise = fixture.client.callTool({
      name: "observe",
      arguments: { platform: "android" },
    });
    await observeStarted.promise;
    await executionTracker.cancelDeviceSessionExecutions(
      "device-session-a",
      "device-disconnected:emulator-5554",
    );

    await expect(
      executionTracker.waitForDeviceSessionExecutionsToEnd("device-session-a", 100),
    ).resolves.toBe(true);
    const result: any = await resultPromise;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: "device_lost",
      deviceId: "emulator-5554",
      sessionUuid: "device-session-a",
    });
  });

  test("direct mode returns structured ownership loss for a terminal heartbeat session", async () => {
    const release = {
      sessionId: "device-session-a",
      deviceId: "emulator-5554",
      releaseReason: "heartbeat-timeout",
      releasedAtMs: 20_000,
      terminal: true,
      heartbeat: {
        lastHeartbeatMs: 9_000,
        hasReceivedHeartbeat: true,
        timeoutMs: 10_000,
        ageMs: 11_000,
      },
    } as const;
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        async resolveExecutionTarget() {
          throw new TerminalSessionError("device-session-a", release);
        },
      },
      auditRunner: {
        async run() {
          throw new Error("terminal session must not reach the handler");
        },
      },
      afterToolCall: {
        async handle() {
          throw new Error("terminal session must not finalize");
        },
      },
      planLifecycleManager: {
        async afterExecution() {},
      },
    });
    ToolRegistry.registerDeviceAware(
      toolName,
      "terminal heartbeat wire probe",
      z.object({}),
      async () => ({ success: true }),
    );
    fixture = new McpTestFixture({
      sessionContext: {
        sessionId: "transport-a",
        initialSessionToolBinding: "device-session-a",
      },
    });
    await fixture.setup();

    const result: any = await fixture.client.callTool({ name: toolName, arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: {
        code: "session_ownership_lost",
        message: "Session ownership lost for device-session-a: heartbeat-timeout",
        sessionUuid: "device-session-a",
        reason: "heartbeat-timeout",
        release,
      },
    });
  });
});
