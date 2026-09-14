import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerDownloadsFixtureTools } from "../../src/server/downloadsFixtureTools";
import type {
  DownloadsFixtureService,
  StageSessionDownloadsRequest,
} from "../../src/server/downloadsFixtureService";

describe("stageSessionDownloads tool (#7007)", () => {
  beforeAll(() => {
    new Ajv2020({ strict: false }).compile({
      type: "object",
      properties: { warmup: { type: "string" } },
    });
  });
  beforeEach(() => (ToolRegistry as any).tools.clear());
  afterEach(() => (ToolRegistry as any).tools.clear());

  test("registers a discoverable, opt-in, strict schema", () => {
    registerDownloadsFixtureTools();
    const definition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "stageSessionDownloads",
    );
    expect(definition).toBeDefined();
    expect(definition!.inputSchema.properties.sessionUuid).toBeDefined();
    expect(definition!.inputSchema.properties.directory).toBeDefined();
    expect(definition!.inputSchema.properties.files).toBeDefined();
    expect(ToolRegistry.getTool("stageSessionDownloads")!.defaultEnabled).toBe(false);
    expect(ToolRegistry.getTool("stageSessionDownloads")!.requiresDevice).toBe(false);

    const validate = new Ajv2020({ strict: false }).compile(definition!.inputSchema);
    expect(
      validate({
        sessionUuid: "session-1",
        directory: "run-42",
        files: [{ contentText: "fixture", destinationPath: "fixture.txt" }],
      }),
    ).toBe(true);
    // reset and indexMedia are defaulted, so they are advertised as optional.
    expect(
      validate({
        sessionUuid: "session-1",
        directory: "run-42",
        reset: true,
        indexMedia: false,
        files: [{ contentText: "fixture", destinationPath: "fixture.txt" }],
      }),
    ).toBe(true);
    expect(validate({ directory: "run-42", files: [] })).toBe(false);
  });

  test("delegates the session-scoped request to the service and returns JSON", async () => {
    const requests: StageSessionDownloadsRequest[] = [];
    const service: DownloadsFixtureService = {
      stage: async (request) => {
        requests.push(request);
        return {
          success: true,
          sessionUuid: request.sessionUuid ?? "",
          deviceId: "emulator-5554",
          platform: "android",
          directory: request.directory,
          userId: 0,
          userSource: "primary",
          destinationDirectory: `/storage/emulated/0/Download/${request.directory}`,
          reset: request.reset ?? false,
          files: [],
        };
      },
    };
    registerDownloadsFixtureTools(() => service);

    const tool = ToolRegistry.getTool("stageSessionDownloads")!;
    const response = await tool.handler({
      sessionUuid: "session-1",
      directory: "run-42",
      reset: true,
      indexMedia: false,
      files: [{ contentText: "fixture", destinationPath: "fixture.txt" }],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sessionUuid: "session-1",
      directory: "run-42",
      reset: true,
      indexMedia: false,
    });
    const payload = JSON.parse(response.content[0].text);
    expect(payload).toMatchObject({
      success: true,
      sessionUuid: "session-1",
      platform: "android",
      directory: "run-42",
    });
  });
});
