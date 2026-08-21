import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry, toolHasOutputSchema } from "../../../src/server/toolRegistry";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";

/**
 * End-to-end gating of the duplicated `structuredContent` tree (issue #2759 —
 * the no-schema unconditional strip — on top of the flag-gated #2899 strip).
 *
 * Exercises the real CallTool wire boundary (`createMcpServer` custom
 * `CallToolRequestSchema` handler) and `tools/list` (`getToolDefinitions`) via
 * an in-memory client, using two throwaway tools:
 *   - `__test_no_schema__`  — no outputSchema (e.g. a plain `register()` tool)
 *   - `__test_schema__`     — declares outputSchema (models `observe`/`tapOn`)
 */

const NO_SCHEMA_TOOL = "__test_no_schema__";
const SCHEMA_TOOL = "__test_schema__";

// A deliberately chunky payload so the size-win assertion (EC4) is meaningful.
const bigPayload = () => ({
  success: true,
  viewHierarchy: {
    node: Array.from({ length: 40 }, (_, i) => ({
      "resource-id": `com.example:id/node_${i}`,
      "text": `label ${i} with some descriptive content to add bytes`,
      "bounds": `[0,${i * 10}][1080,${i * 10 + 48}]`,
      "clickable": i % 2 === 0,
    })),
  },
});

const schemaResult = z.object({ success: z.boolean(), value: z.string() });

const permissiveCallResult = z.object({
  content: z.array(z.object({}).passthrough()),
  structuredContent: z.unknown().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough();

const listResult = z.object({
  tools: z.array(z.object({
    name: z.string(),
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough().optional(),
  }).passthrough()),
});

describe("structuredContent gating (issue #2759)", () => {
  let fixture: McpTestFixture;

  beforeAll(async () => {
    ToolRegistry.register(
      NO_SCHEMA_TOOL,
      "throwaway tool without outputSchema",
      z.object({}),
      async () => createStructuredToolResponse(bigPayload())
    );
    ToolRegistry.register(SCHEMA_TOOL, "throwaway tool with outputSchema", z.object({}), async () => createStructuredToolResponse({ success: true, value: "hello" }), { outputSchema: schemaResult });

    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterEach(() => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    // Surgically remove the throwaway tools from the singleton registry.
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(NO_SCHEMA_TOOL);
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(SCHEMA_TOOL);
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  const call = async (name: string) => {
    const { client } = fixture.getContext();
    return client.request(
      { method: "tools/call", params: { name, arguments: {} } },
      permissiveCallResult
    );
  };

  const list = async () => {
    const { client } = fixture.getContext();
    return client.request({ method: "tools/list", params: {} }, listResult);
  };

  test("EC1: no-schema tool returns content only, no structuredContent key (flag off)", async () => {
    const result = await call(NO_SCHEMA_TOOL);
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect("structuredContent" in result).toBe(false);
  });

  test("EC5: no-schema tool text block still carries the full payload", async () => {
    const result = await call(NO_SCHEMA_TOOL);
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("viewHierarchy");
    expect(text).toContain("com.example:id/node_0");
  });

  test("EC2: schema tool with flag off keeps conforming structuredContent", async () => {
    const result = await call(SCHEMA_TOOL);
    expect("structuredContent" in result).toBe(true);
    expect(result.structuredContent).toEqual({ success: true, value: "hello" });
  });

  test("EC3: schema tool with flag on drops structuredContent", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const result = await call(SCHEMA_TOOL);
    expect("structuredContent" in result).toBe(false);
    // text block is preserved
    expect((result.content[0] as { text?: string }).text).toContain("hello");
  });

  test("EC2/EC8: tools/list advertises outputSchema for schema tool, not for no-schema tool (flag off)", async () => {
    const result = await list();
    const schemaTool = result.tools.find(t => t.name === SCHEMA_TOOL);
    const noSchemaTool = result.tools.find(t => t.name === NO_SCHEMA_TOOL);
    expect(schemaTool?.outputSchema).toBeDefined();
    expect(noSchemaTool?.outputSchema).toBeUndefined();
  });

  test("EC3/EC8: tools/list omits outputSchema for every tool when flag on", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const result = await list();
    for (const tool of result.tools) {
      expect(tool.outputSchema).toBeUndefined();
    }
  });

  test("EC4: stripping the no-schema payload removes a substantial chunk of the wire size", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    const stripped = await call(NO_SCHEMA_TOOL);
    const strippedSize = JSON.stringify(stripped).length;
    // Reconstruct what the un-stripped envelope would have serialized to: the
    // same payload duplicated under structuredContent (compact JSON, which is
    // what the SDK emits on the wire).
    const payload = JSON.parse((stripped.content[0] as { text: string }).text);
    const withStructured = { ...stripped, structuredContent: payload };
    const fullSize = JSON.stringify(withStructured).length;
    const savedBytes = fullSize - strippedSize;
    // The duplicate is the compact serialization of the payload plus its
    // `,"structuredContent":` key — a real, non-trivial fraction of the
    // two-copy total (~40% here).
    expect(savedBytes).toBeGreaterThanOrEqual(JSON.stringify(payload).length);
    expect(savedBytes).toBeGreaterThan(1000);
    expect(strippedSize).toBeLessThan(fullSize * 0.7);
  });

  test("shared predicate: toolHasOutputSchema is the single source both gate sites key off", () => {
    // Both the wire-boundary strip and the tools/list advertisement resolve
    // "has schema" through this one predicate, so they can never disagree.
    expect(toolHasOutputSchema(ToolRegistry.getTool(SCHEMA_TOOL)!)).toBe(true);
    expect(toolHasOutputSchema(ToolRegistry.getTool(NO_SCHEMA_TOOL)!)).toBe(false);
    expect(toolHasOutputSchema({ outputSchema: undefined })).toBe(false);
    expect(toolHasOutputSchema({ outputSchema: null })).toBe(false);
  });

  test("EC6: internal callers invoking handler directly still receive structuredContent (flag on)", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const tool = ToolRegistry.getTool(SCHEMA_TOOL);
    const direct = await tool!.handler({}, undefined, undefined as unknown as AbortSignal);
    expect((direct as { structuredContent?: unknown }).structuredContent).toEqual({ success: true, value: "hello" });
  });

  // #2990: bounds compaction is now a permanent default, so the server always emits
  // the tuple form and a `tools/list` client is always told to expect it. The
  // advertised `tapOn` outputSchema therefore carries the bounds tuple arm
  // unconditionally.
  test("EC-C1: tapOn outputSchema always advertises the bounds tuple arm", async () => {
    const boundsHasTupleArm = async (): Promise<boolean> => {
      const result = await list();
      const tapOn = result.tools.find(t => t.name === "tapOn");
      // Depth-first scan for a JSON-Schema tuple (prefixItems) under tapOn's outputSchema.
      const stack: unknown[] = [tapOn?.outputSchema];
      while (stack.length) {
        const node = stack.pop();
        if (Array.isArray(node)) {
          stack.push(...node);
        } else if (node && typeof node === "object") {
          if ("prefixItems" in (node as Record<string, unknown>)) {
            return true;
          }
          stack.push(...Object.values(node as Record<string, unknown>));
        }
      }
      return false;
    };

    expect(await boundsHasTupleArm()).toBe(true);
  });
});
