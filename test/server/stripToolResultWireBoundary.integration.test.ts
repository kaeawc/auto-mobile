import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { logger, LogLevel } from "../../src/utils/logger";

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
    ToolRegistry.register(
      TOOL,
      "probe tool for structuredContent strip",
      z.object({}).passthrough(),
      async () =>
        createStructuredToolResponse({
          success: true,
          marker: "probe",
          observationDiff: { mode: "full", reason: "screen_changed" },
        }),
      {
        outputSchema: z.object({
          success: z.boolean(),
          marker: z.string(),
          observationDiff: z.object({ mode: z.string(), reason: z.string() }),
        }),
      },
    );
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
    // oxlint-disable-next-line auto-mobile/no-structured-content-read -- intentional raw-wire assertion
    expect(res.structuredContent.marker).toBe("probe");
  });

  test("gate on: structuredContent stripped, content text retains the full payload", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const { client } = fixture.getContext();
    const res: any = await client.callTool({ name: TOOL, arguments: {} });
    expect(res.structuredContent).toBeUndefined();
    // No data lost: the full payload is still recoverable from content[0].text.
    const payload = JSON.parse(res.content[0].text);
    expect(payload.marker).toBe("probe");
    expect(payload.observationDiff).toEqual({ mode: "full", reason: "screen_changed" });
  });
});

/**
 * Field-debuggability trace (issue #2962): when the wire boundary intentionally
 * omits `structuredContent`, it emits exactly one `logger.debug` trace naming the
 * tool and the omission reason (no-schema vs flag) as structured fields (issue
 * #3216). Debug level only — never info/warn — so there is no default (INFO)
 * noise. A retained call (schema tool, flag off) emits no omission trace.
 *
 * Level-gate coverage (issue #3215): the method-spy tests below replace
 * `logger.debug` wholesale, which bypasses the real `currentLogLevel` gate in
 * src/utils/logger.ts — so the final two tests instead observe the actual log
 * sink (stdout mirroring; the fixture's MCP wire is an InMemoryTransport, not
 * stdio) with the real, un-spied logger methods, proving the trace is suppressed
 * at INFO and written at DEBUG by the real gate.
 */
describe("CallTool wire boundary debug-logs structuredContent omission (issue #2962)", () => {
  let fixture: McpTestFixture;
  // Deliberately NOT containing "omit"/"structuredContent" so a probe name can
  // never coincidentally satisfy the omission-line matcher below.
  const SCHEMA_TOOL = "__strip_log_schema_2962__";
  const NOSCHEMA_TOOL = "__strip_log_noschema_2962__";
  const PLAIN_TOOL = "__strip_log_plain_2962__";

  // Match ONLY the exact omission trace emitted at the strip site (index.ts):
  // exact message equality plus the structured fields argument (issue #3216),
  // scoped to the probe tool, returning the `reason` field. This is precise on
  // purpose: it must not be satisfied by any other debug line the handler path
  // emits, nor by the tool name happening to contain a keyword — and it reads
  // stable fields instead of regex-parsing a formatted message.
  const omissionReasons = (calls: unknown[][], tool: string): string[] =>
    calls
      .filter((args) => args[0] === "[MCP] Omitted structuredContent")
      .map((args) => args[1] as { tool?: unknown; reason?: unknown } | undefined)
      .filter(
        (fields): fields is { tool: string; reason: string } =>
          fields !== undefined &&
          fields !== null &&
          fields.tool === tool &&
          typeof fields.reason === "string",
      )
      .map((fields) => fields.reason);

  beforeAll(async () => {
    ToolRegistry.register(
      SCHEMA_TOOL,
      "probe tool for omission debug log (schema)",
      z.object({}).passthrough(),
      async () => createStructuredToolResponse({ success: true, marker: "probe" }),
      { outputSchema: z.object({ success: z.boolean(), marker: z.string() }) },
    );
    ToolRegistry.register(
      NOSCHEMA_TOOL,
      "probe tool for omission debug log (no schema)",
      z.object({}).passthrough(),
      async () => createStructuredToolResponse({ success: true, marker: "probe" }),
    );
    // A no-schema tool whose handler returns a response that never carried a
    // `structuredContent` tree (e.g. an image/plain-text result). The omission
    // policy still applies, but nothing is actually dropped — so no trace fires.
    ToolRegistry.register(
      PLAIN_TOOL,
      "probe tool with no structuredContent to drop",
      z.object({}).passthrough(),
      async () => ({ content: [{ type: "text", text: "no structuredContent here" }] }),
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

  // ---- Real level-gate coverage (issue #3215) ----
  //
  // The logger's file/stdout writes are fire-and-forget async (each performs one
  // real fs.stat before writing). Rather than race that async write with a
  // real-timer poll (which timed out under concurrent CI load and produced the
  // intermittent `Received: []` flake tracked in #3256), we await the logger's
  // own `flush()` barrier — it resolves once the most recent write has settled,
  // so the sink assertion is deterministic regardless of host load.

  // Extract the level and structured fields of omission traces that actually
  // reached the stdout sink for the given probe tool. Anchored to the exact
  // `[LEVEL] <message> {json}` line the logger composes, but deliberately
  // level-AGNOSTIC — so the suppression test also catches a regression that
  // re-emits the trace at info/warn (which would pass the INFO gate).
  const sinkOmissionFields = (
    writes: unknown[][],
    tool: string,
  ): Array<{ level: string; tool: string; reason: string }> =>
    writes
      .map((args) => String(args[0] ?? ""))
      .flatMap((chunk) => chunk.split("\n"))
      .map((line) =>
        / \[(DEBUG|INFO|WARN|ERROR)\] \[MCP\] Omitted structuredContent (\{.*\})$/.exec(line),
      )
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ level: m[1], ...(JSON.parse(m[2]) as { tool: string; reason: string }) }))
      .filter((fields) => fields.tool === tool);

  test("real gate at INFO (default): omission trace never reaches the log sink", async () => {
    // No method spy on logger.debug here — a wholesale spy bypasses the
    // `currentLogLevel <= LogLevel.DEBUG` guard this test exists to exercise.
    const previousLevel = logger.getLogLevel();
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.enableStdoutLogging();
    try {
      logger.setLogLevel(LogLevel.INFO);
      serverConfig.setToolResultsNoStructuredContentEnabled(false);
      const { client } = fixture.getContext();
      await client.callTool({ name: NOSCHEMA_TOOL, arguments: {} });

      // Sentinel barrier: prove the sink pipeline flushes at this level, so the
      // empty assertion below cannot pass merely because async writes never
      // landed. info() passes the INFO gate; the omission trace must not have.
      const SENTINEL = "__sink_flush_sentinel_3215__";
      logger.info(SENTINEL);
      await logger.flush();
      expect(stdoutSpy.mock.calls.some((args) => String(args[0] ?? "").includes(SENTINEL))).toBe(
        true,
      );

      expect(sinkOmissionFields(stdoutSpy.mock.calls, NOSCHEMA_TOOL)).toEqual([]);
    } finally {
      logger.setLogLevel(previousLevel);
      logger.disableStdoutLogging();
      stdoutSpy.mockRestore();
    }
  });

  test("real gate at DEBUG: exactly one structured omission trace reaches the log sink", async () => {
    const previousLevel = logger.getLogLevel();
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.enableStdoutLogging();
    try {
      logger.setLogLevel(LogLevel.DEBUG);
      serverConfig.setToolResultsNoStructuredContentEnabled(false);
      const { client } = fixture.getContext();
      await client.callTool({ name: NOSCHEMA_TOOL, arguments: {} });

      // Deterministic barrier: await the logger's in-flight write instead of
      // polling with a real-timer loop (the #3256 flake). Once flush() resolves
      // the DEBUG omission trace has reached the stdout sink.
      await logger.flush();
      // Structured fields (issue #3216) are asserted by object equality — the
      // sink line carries the exact { tool, reason } payload, exactly once, at
      // DEBUG level specifically.
      expect(sinkOmissionFields(stdoutSpy.mock.calls, NOSCHEMA_TOOL)).toEqual([
        { level: "DEBUG", tool: NOSCHEMA_TOOL, reason: "no-schema" },
      ]);
    } finally {
      logger.setLogLevel(previousLevel);
      logger.disableStdoutLogging();
      stdoutSpy.mockRestore();
    }
  });
});
