import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerDownloadsFixtureTools } from "../../src/server/downloadsFixtureTools";
import { FakeTimer } from "../fakes/FakeTimer";
import type {
  DownloadsFixtureService,
  StageSessionDownloadsRequest,
} from "../../src/server/downloadsFixtureService";

describe("stageSessionDownloads tool (#7007)", () => {
  let originalTimer: unknown;
  let originalToolCallRepository: unknown;

  beforeAll(() => {
    new Ajv2020({ strict: false }).compile({
      type: "object",
      properties: { warmup: { type: "string" } },
    });
  });
  beforeEach(() => {
    (ToolRegistry as any).tools.clear();
    // The tool is now device-aware, so its wrapped handler records a tool call
    // via the ToolRegistry's repository/timer. Stub both so the fast unit test
    // never resolves the real file-backed getDatabase() (issue #3067) and stays
    // deterministic.
    originalTimer = (ToolRegistry as any).timer;
    originalToolCallRepository = (ToolRegistry as any).toolCallRepository;
    (ToolRegistry as any).timer = new FakeTimer();
    (ToolRegistry as any).toolCallRepository = { async recordToolCall(): Promise<void> {} };
  });
  afterEach(() => {
    (ToolRegistry as any).timer = originalTimer;
    (ToolRegistry as any).toolCallRepository = originalToolCallRepository;
    (ToolRegistry as any).tools.clear();
  });

  test("registers a discoverable, opt-in, device-aware, strict schema", () => {
    registerDownloadsFixtureTools();
    const definition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "stageSessionDownloads",
    );
    expect(definition).toBeDefined();
    expect(definition!.inputSchema.properties.sessionUuid).toBeDefined();
    expect(definition!.inputSchema.properties.directory).toBeDefined();
    expect(definition!.inputSchema.properties.files).toBeDefined();
    expect(ToolRegistry.getTool("stageSessionDownloads")!.defaultEnabled).toBe(false);
    // Device-aware registration is what makes the MCP boundary's #6069
    // cross-session ownership guard run for this tool.
    expect(ToolRegistry.getTool("stageSessionDownloads")!.requiresDevice).toBe(true);

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

  test("published schema advertises the runtime path and content-source constraints", () => {
    // Test (b): the PUBLISHED/served schema (from the registered tool
    // definition, not the inner zod) must reject what the runtime refinements
    // reject, so a client generating a call from tools/list does not hit an
    // avoidable runtime failure.
    registerDownloadsFixtureTools();
    const definition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "stageSessionDownloads",
    );
    const validate = new Ajv2020({ strict: false }).compile(definition!.inputSchema);
    const base = { sessionUuid: "session-1", directory: "run-42" };

    // Directory traversal / separators / values the runtime trims to blank.
    for (const directory of ["../escape", "a/b", "..", ".", "   "]) {
      expect(
        validate({ ...base, directory, files: [{ contentText: "x", destinationPath: "a.txt" }] }),
      ).toBe(false);
    }
    // Absolute / traversal destinationPath, including empty path segments.
    for (const destinationPath of [
      "/etc/passwd",
      "../secret.txt",
      "docs/../../escape.txt",
      "a//b",
      "a/b/",
    ]) {
      expect(validate({ ...base, files: [{ contentText: "x", destinationPath }] })).toBe(false);
    }
    // Zero content sources.
    expect(validate({ ...base, files: [{ destinationPath: "a.txt" }] })).toBe(false);
    // Multiple content sources.
    expect(
      validate({
        ...base,
        files: [{ contentText: "x", contentBase64: "aGk=", destinationPath: "a.txt" }],
      }),
    ).toBe(false);
    // Malformed or non-canonical base64.
    for (const contentBase64 of ["not base64!!", "A", "AB=="]) {
      expect(validate({ ...base, files: [{ contentBase64, destinationPath: "a.txt" }] })).toBe(
        false,
      );
    }
    // Empty base64.
    expect(validate({ ...base, files: [{ contentBase64: "", destinationPath: "a.txt" }] })).toBe(
      false,
    );

    // Positive controls: each single content source is accepted.
    expect(validate({ ...base, files: [{ contentText: "x", destinationPath: "a.txt" }] })).toBe(
      true,
    );
    expect(
      validate({ ...base, files: [{ contentBase64: "aGVsbG8=", destinationPath: "a.txt" }] }),
    ).toBe(true);
    expect(
      validate({ ...base, files: [{ contentBase64: "aGVsbG8", destinationPath: "a.txt" }] }),
    ).toBe(true);
    expect(
      validate({ ...base, files: [{ sourcePath: "/host/f", destinationPath: "sub/dir/a.txt" }] }),
    ).toBe(true);
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
