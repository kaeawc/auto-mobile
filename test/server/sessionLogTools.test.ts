import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerSessionLogTools } from "../../src/server/sessionLogTools";
import type { ResetAppLogsRequest, SessionLogService } from "../../src/server/sessionLogService";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

describe("resetAppLogs tool (#7006)", () => {
  beforeEach(() => (ToolRegistry as any).tools.clear());
  afterEach(() => (ToolRegistry as any).tools.clear());

  test("registers a discoverable, strict schema that defaults the container", () => {
    registerSessionLogTools();
    const definition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "resetAppLogs",
    );
    expect(definition).toBeDefined();
    expect(definition!.inputSchema.properties.appId).toBeDefined();
    expect(definition!.inputSchema.properties.paths).toBeDefined();
    expect(definition!.inputSchema.properties.container).toBeDefined();

    const validate = new Ajv2020({ strict: false }).compile(definition!.inputSchema);
    expect(validate({ appId: "com.example.app", paths: ["logs/app.log"] })).toBe(true);
    expect(validate({ appId: "com.example.app", paths: [] })).toBe(false);
    expect(validate({ appId: "com.example.app" })).toBe(false);

    const tool = ToolRegistry.getTool("resetAppLogs")!;
    expect(tool.schema.parse({ appId: "com.example.app", paths: ["a.log"] })).toMatchObject({
      container: "documents",
    });
    expect(tool.schema.safeParse({ appId: "com.example.app", paths: ["../a.log"] }).success).toBe(
      false,
    );
  });

  test("resets through the service on the resolved session device", async () => {
    const requests: ResetAppLogsRequest[] = [];
    const service: SessionLogService = {
      collect: async () => {
        throw new Error("not used");
      },
      resetAppLogs: async (request) => {
        requests.push(request);
        return {
          success: true,
          deviceId: request.device.deviceId,
          platform: request.device.platform,
          appId: request.appId,
          container: request.container,
          entries: request.paths.map((path) => ({ path, status: "reset" as const })),
        };
      },
    };
    registerSessionLogTools(() => service);
    const registryInternals = ToolRegistry as unknown as { toolCallRepository: unknown };
    const originalRepository = registryInternals.toolCallRepository;
    registryInternals.toolCallRepository = { recordToolCall: async () => {} };
    const restore = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          baseSessionUuid: "session-1",
          device,
          internalCall: true,
          sessionUuid: "session-1",
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

    try {
      const tool = ToolRegistry.getTool("resetAppLogs")!;
      const response = await tool.handler(
        tool.schema.parse({
          bundleId: "com.example.app",
          container: "cache",
          paths: ["a.log", "b.log"],
        }),
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        device,
        appId: "com.example.app",
        container: "cache",
        paths: ["a.log", "b.log"],
      });
      const text = (response as { content: Array<{ text: string }> }).content[0]!.text;
      expect(JSON.parse(text)).toMatchObject({
        success: true,
        deviceId: "emulator-5554",
        entries: [
          { path: "a.log", status: "reset" },
          { path: "b.log", status: "reset" },
        ],
      });
    } finally {
      restore();
      registryInternals.toolCallRepository = originalRepository;
    }
  });
});
