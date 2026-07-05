import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { logger } from "../../src/utils/logger";

/**
 * End-to-end proof that the `--tool-results-no-structured-content` strip runs at
 * the real MCP CallTool boundary (`src/server/index.ts`). Uses a plain
 * `ToolRegistry.register()` probe — the same non-device registration path as
 * `exportPlan`/`recordSteps` — so this also covers the tools that bypass
 * `finalizeToolResponse`. The probe declares an `outputSchema` (like
 * `exportPlan`/`recordSteps`) so its `structuredContent` survives the gate-off
 * case; the no-schema unconditional strip (#2759) is covered separately in
 * `structuredContentGating.test.ts`.
 */
describe("CallTool wire boundary strips structuredContent (issue #2899)", () => {
  let fixture: McpTestFixture;
  const TOOL = "__strip_probe_2899__";

  beforeAll(async () => {
    ToolRegistry.register(TOOL, "probe tool for structuredContent strip", z.object({}).passthrough(), async () => createStructuredToolResponse({ success: true, marker: "probe" }), { outputSchema: z.object({ success: z.boolean(), marker: z.string() }) });
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(TOOL);
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  afterEach(() => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  test("gate off: structuredContent is present on the wire", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    const { client } = fixture.getContext();
    const res: any = await client.callTool({ name: TOOL, arguments: {} });
    expect(res.structuredContent).toBeDefined();
    // This test asserts the RAW wire envelope, so it must read `structuredContent`
    // directly rather than via getStructuredField() — that helper is the #2907
    // production dead-read guard, but here inspecting the pre-strip wire shape is
    // the whole point of the test.
    // eslint-disable-next-line no-restricted-syntax -- intentional raw-wire assertion
    expect(res.structuredContent.marker).toBe("probe");
  });

  test("gate on: structuredContent stripped, content text retains the full payload", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const { client } = fixture.getContext();
    const res: any = await client.callTool({ name: TOOL, arguments: {} });
    expect(res.structuredContent).toBeUndefined();
    // No data lost: the full payload is still recoverable from content[0].text.
    expect(JSON.parse(res.content[0].text).marker).toBe("probe");
  });
});

/**
 * Field-debuggability trace (issue #2962): when the wire boundary intentionally
 * omits `structuredContent`, it emits exactly one `logger.debug` line naming the
 * tool and the omission reason (no-schema vs flag). Debug level only — never
 * info/warn — so there is no default (INFO) noise. A retained call (schema tool,
 * flag off) emits no omission trace.
 */
describe("CallTool wire boundary debug-logs structuredContent omission (issue #2962)", () => {
  let fixture: McpTestFixture;
  // Deliberately NOT containing "omit"/"structuredContent" so a probe name can
  // never coincidentally satisfy the omission-line matcher below.
  const SCHEMA_TOOL = "__strip_log_schema_2962__";
  const NOSCHEMA_TOOL = "__strip_log_noschema_2962__";
  const PLAIN_TOOL = "__strip_log_plain_2962__";

  // Match ONLY the exact omission trace emitted at the strip site (index.ts),
  // anchored to the real message format, and return the captured reason. This is
  // precise on purpose: it must not be satisfied by any other debug line the
  // handler path emits, nor by the tool name happening to contain a keyword.
  const omissionReasons = (calls: unknown[][], tool: string): string[] =>
    calls
      .map(args => new RegExp(`^\\[MCP\\] Omitted structuredContent for tool "${tool}" \\(reason: (no-schema|flag)\\)$`).exec(String(args[0] ?? "")))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => m[1]);

  beforeAll(async () => {
    ToolRegistry.register(
      SCHEMA_TOOL,
      "probe tool for omission debug log (schema)",
      z.object({}).passthrough(),
      async () => createStructuredToolResponse({ success: true, marker: "probe" }),
      { outputSchema: z.object({ success: z.boolean(), marker: z.string() }) }
    );
    ToolRegistry.register(
      NOSCHEMA_TOOL,
      "probe tool for omission debug log (no schema)",
      z.object({}).passthrough(),
      async () => createStructuredToolResponse({ success: true, marker: "probe" })
    );
    // A no-schema tool whose handler returns a response that never carried a
    // `structuredContent` tree (e.g. an image/plain-text result). The omission
    // policy still applies, but nothing is actually dropped — so no trace fires.
    ToolRegistry.register(
      PLAIN_TOOL,
      "probe tool with no structuredContent to drop",
      z.object({}).passthrough(),
      async () => ({ content: [{ type: "text", text: "no structuredContent here" }] })
    );
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(SCHEMA_TOOL);
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(NOSCHEMA_TOOL);
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(PLAIN_TOOL);
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  afterEach(() => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  test("no-schema tool: one debug line naming the tool and the 'no-schema' reason", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { client } = fixture.getContext();
      await client.callTool({ name: NOSCHEMA_TOOL, arguments: {} });

      // Exactly one omission trace, and it names the 'no-schema' reason.
      expect(omissionReasons(debugSpy.mock.calls, NOSCHEMA_TOOL)).toEqual(["no-schema"]);
      // No default noise: the omission is never surfaced at info/warn.
      expect(omissionReasons(infoSpy.mock.calls, NOSCHEMA_TOOL)).toEqual([]);
      expect(omissionReasons(warnSpy.mock.calls, NOSCHEMA_TOOL)).toEqual([]);
    } finally {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("schema tool, flag on: one debug line naming the tool and the 'flag' reason", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const { client } = fixture.getContext();
      await client.callTool({ name: SCHEMA_TOOL, arguments: {} });

      expect(omissionReasons(debugSpy.mock.calls, SCHEMA_TOOL)).toEqual(["flag"]);
    } finally {
      debugSpy.mockRestore();
    }
  });

  test("schema tool, flag off: no omission trace (structuredContent is retained)", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const { client } = fixture.getContext();
      await client.callTool({ name: SCHEMA_TOOL, arguments: {} });

      expect(omissionReasons(debugSpy.mock.calls, SCHEMA_TOOL)).toEqual([]);
    } finally {
      debugSpy.mockRestore();
    }
  });

  test("no-schema tool with no structuredContent to drop: no trace (nothing was actually omitted)", async () => {
    // Policy would omit (no schema), but the handler never produced a
    // `structuredContent` tree — so the trace must NOT fire on the mere policy.
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const { client } = fixture.getContext();
      await client.callTool({ name: PLAIN_TOOL, arguments: {} });

      expect(omissionReasons(debugSpy.mock.calls, PLAIN_TOOL)).toEqual([]);
    } finally {
      debugSpy.mockRestore();
    }
  });
});
