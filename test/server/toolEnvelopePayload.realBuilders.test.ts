import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { createToolErrorResponse } from "../../src/server/deviceTools";
import {
  finalizeToolResponse,
  type ObservationArtifactWriter,
  type ObservationArtifactWriteInput,
} from "../../src/server/finalizeToolResponse";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { classifyToolResult } from "../../src/utils/toolEnvelopePayload";
import { createJSONToolResponse, createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry, unregisterTemporaryTools } from "../helpers/withTemporaryTool";

class FakeObservationArtifactWriter implements ObservationArtifactWriter {
  writes: ObservationArtifactWriteInput[] = [];

  writeJsonArtifact(input: ObservationArtifactWriteInput) {
    this.writes.push(input);
    return {
      artifact: {
        path: `/tmp/auto-mobile/${input.tool}-${this.writes.length}.json`,
        format: "json" as const,
        payload: input.payload,
        bytes: 123,
        tool: input.tool,
        resourceUri: `automobile:tool-output/${input.tool}-${this.writes.length}`,
      },
    };
  }
}

const probeName = "realBuilderEnvelopeProbe";
const deviceSchema = z.object({
  platform: z.string().optional(),
  deviceId: z.string().optional(),
  sessionUuid: z.string().optional(),
});

function registerResponse(name: string, response: unknown): void {
  ToolRegistry.register(name, "real response builder probe", deviceSchema, async () => response);
  const tool = ToolRegistry.getTool(name);
  if (!tool) {
    throw new Error(`Missing registered tool ${name}`);
  }
  tool.requiresDevice = true;
}

interface BuilderCase {
  name: string;
  build: () => { response: unknown; payload?: unknown; failure?: unknown };
  kind: "payload" | "uninterpretable";
  error?: string;
}

const rows: BuilderCase[] = [
  {
    name: "createJSONToolResponse success",
    kind: "payload",
    build: () => {
      const payload = { success: true, value: 1 };
      return { response: createJSONToolResponse(payload), payload };
    },
  },
  {
    name: "createJSONToolResponse failure",
    kind: "payload",
    error: "element not found",
    build: () => {
      const payload = { success: false, error: "element not found" };
      return { response: createJSONToolResponse(payload), payload };
    },
  },
  {
    name: "createJSONToolResponse without success",
    kind: "payload",
    build: () => {
      const payload = { updatedAt: 0, value: 1 };
      return { response: createJSONToolResponse(payload), payload };
    },
  },
  {
    name: "createJSONToolResponse array is accepted as payload",
    kind: "payload",
    build: () => {
      const payload = [{ value: 1 }];
      return { response: createJSONToolResponse(payload), payload };
    },
  },
  ...[true, false].map((success): BuilderCase => ({
    name: `createStructuredToolResponse hoisted success ${success}`,
    kind: "payload",
    error: success ? undefined : "structured failure",
    build: () => {
      const response = createStructuredToolResponse(
        success ? { success, value: 1 } : { success, error: "structured failure" },
      );
      // Hoisted success preserves the legacy top-level-envelope precedence.
      return { response, payload: response };
    },
  })),
  {
    name: "createToolErrorResponse object error",
    kind: "payload",
    error: "code: message",
    build: () => {
      const payload = {
        success: false,
        message: "message",
        error: { code: "code", message: "message" },
      };
      return { response: createToolErrorResponse("code", "message"), payload, failure: payload };
    },
  },
  {
    name: "observe text plus image plus structuredContent",
    kind: "payload",
    build: () => {
      const payload = {
        updatedAt: 0,
        screenshotImage: { included: true, mimeType: "image/png", sizeBytes: 5 },
      };
      const r = createStructuredToolResponse(payload);
      // Mirrors observeTools.ts withCapturedScreenshotImage; neither observe builder is exported.
      return {
        response: {
          ...r,
          content: [...r.content, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        },
        payload,
      };
    },
  },
  {
    name: "finalizeToolResponse internal without artifact writer",
    kind: "payload",
    build: () => {
      const response = finalizeToolResponse(
        createStructuredToolResponse({ success: true, value: 1 }),
        { name: "tapOn", internal: true },
      );
      return { response, payload: response };
    },
  },
  {
    name: "finalizeToolResponse external oversized artifact residue",
    kind: "payload",
    build: () => {
      const artifactWriter = new FakeObservationArtifactWriter();
      const payload = { success: true, rows: "q".repeat(90_000) };
      const response = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "tapOn",
        artifactMode: "oversized",
        artifactWriter,
      });
      expect(artifactWriter.writes).toHaveLength(1);
      expect(artifactWriter.writes[0]).toMatchObject({
        tool: "tapOn",
        payload: "ToolResponse",
        data: payload,
      });
      expect(response.structuredContent).toEqual({
        success: true,
        artifact: {
          path: "/tmp/auto-mobile/tapOn-1.json",
          format: "json",
          payload: "ToolResponse",
          bytes: 123,
          tool: "tapOn",
          resourceUri: "automobile:tool-output/tapOn-1",
        },
      });
      return { response, payload: response };
    },
  },
  ...[undefined, "plain string"].map((response): BuilderCase => ({
    name: `handler returns ${response === undefined ? "undefined" : "a non-object string"}`,
    kind: "uninterpretable",
    error: `Tool "${probeName}" result could not be interpreted`,
    build: () => ({
      response,
      failure: { success: false, error: `Tool "${probeName}" result could not be interpreted` },
    }),
  })),
  {
    name: "isError: true overrides payload success: true (today's verdict: failed step)",
    kind: "payload",
    error: "transport failure",
    build: () => {
      const payload = { success: true, error: "transport failure", value: 1 };
      return {
        response: { ...createStructuredToolResponse(payload), isError: true },
        payload,
        failure: { ...payload, success: false },
      };
    },
  },
];

describe("real response builders through classifier and PlanExecutor", () => {
  let restoreRegistry: () => void;
  beforeEach(() => {
    restoreRegistry = preserveToolRegistry();
  });
  afterEach(() => {
    unregisterTemporaryTools(probeName, "tapOn");
    restoreRegistry();
  });

  for (const row of rows) {
    for (const optional of [false, true]) {
      test(`${row.name}; optional: ${optional}`, async () => {
        const { response, payload, failure } = row.build();
        const interpretation = classifyToolResult(response, probeName, new FakeLogger());
        expect(interpretation).toEqual({
          kind: row.kind,
          ...(row.kind === "payload" ? { payload } : {}),
          ...(failure !== undefined ? { failure } : {}),
        });
        registerResponse(probeName, response);
        // No platform: a failed step cannot trigger a real follow-up observation.
        const result = await new DefaultPlanExecutor(new FakeTimer(), new FakeLogger()).executePlan(
          { name: row.name, steps: [{ tool: probeName, params: {}, optional }] },
          0,
        );
        expect(result.debug?.steps).toHaveLength(1);
        expect(result.debug?.steps[0].status).toBe(
          row.error ? (optional ? "skipped" : "failed") : "completed",
        );
        expect(result.success).toBe(!row.error || optional);
        expect(result.debug?.steps[0].details.error).toBe(row.error);
        expect(result.failedStep?.error).toBe(row.error && !optional ? row.error : undefined);
      });
    }
  }

  test("JSON-only payload without success promotes string warnings and tapDebug", async () => {
    const tapDebug = { target: "button", attempts: 1 };
    const payload = { updatedAt: 0, warnings: ["keyboard did not dismiss", 7, null], tapDebug };
    const response = createJSONToolResponse(payload);
    expect(classifyToolResult(response, "tapOn", new FakeLogger())).toEqual({
      kind: "payload",
      payload,
    });
    registerResponse("tapOn", response);
    const result = await new DefaultPlanExecutor(new FakeTimer(), new FakeLogger()).executePlan(
      { name: "JSON diagnostics", steps: [{ tool: "tapOn", params: {} }] },
      0,
    );
    expect(result.success).toBe(true);
    expect(result.debug?.steps[0].status).toBe("completed");
    expect(result.debug?.steps[0].details.warnings).toEqual(["keyboard did not dismiss"]);
    expect(result.debug?.steps[0].details.tapDebug).toEqual(tapDebug);
    expect(result.warnings).toEqual([
      { stepIndex: 0, tool: "tapOn", warnings: ["keyboard did not dismiss"] },
    ]);
  });
});
