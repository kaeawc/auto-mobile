import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models";
import { DeviceLostError, rememberDeviceLossAbort } from "../../src/server/deviceLossOutcome";
import { ToolRegistry } from "../../src/server/toolRegistry";
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

  afterEach(async () => {
    if (fixture) {
      await fixture.teardown();
      fixture = undefined;
    }
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
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
});
