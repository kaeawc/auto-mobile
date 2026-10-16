import { describe, expect, test } from "bun:test";
import { auditTranscript, toolResultText } from "../../../scripts/agent-benchmark/transcript";
import { TranscriptBuilder } from "./transcriptBuilder";

const NO_PATTERNS = { failurePatterns: [], ignoredFailurePatterns: [] };

describe("agent benchmark transcript audit", () => {
  test("counts MCP and built-in tool calls and reads run metadata", () => {
    const jsonl = new TranscriptBuilder()
      .init({ model: "claude-x" })
      .tool("ToolSearch", "loaded")
      .mcp("observe")
      .mcp("tapOn")
      .mcp("tapOn")
      .text("all done")
      .result({ costUsd: 0.5, numTurns: 7, finalText: "EXPECTED_COUNT: 3" })
      .build();
    const audit = auditTranscript(jsonl, NO_PATTERNS);
    expect(audit.observedModel).toBe("claude-x");
    expect(audit.claudeCodeVersion).toBe("2.1.301");
    expect(audit.mcpServerStatus).toBe("connected");
    expect(audit.totalToolCalls).toBe(4);
    expect(audit.mcpToolCalls).toBe(3);
    expect(audit.toolCounts).toEqual({ ToolSearch: 1, observe: 1, tapOn: 2 });
    expect(audit.toolCalls.map((call) => call.shortName)).toEqual([
      "ToolSearch",
      "observe",
      "tapOn",
      "tapOn",
    ]);
    expect(audit.result).toMatchObject({
      subtype: "success",
      isError: false,
      numTurns: 7,
      costUsd: 0.5,
      finalText: "EXPECTED_COUNT: 3",
      inputTokens: 1104,
      outputTokens: 50,
    });
    expect(audit.parseErrors).toEqual([]);
  });

  test("tool errors and failure patterns become stumbles unless ignored", () => {
    const jsonl = new TranscriptBuilder()
      .init()
      .mcp("tapOn", "STALE_ELEMENT: element s2-4 is gone", { isError: true })
      .mcp("observe", "warning WAIT_TIMEOUT while settling")
      .mcp("tapOn", "element_disabled (expected probe)", { isError: true })
      .result()
      .build();
    const audit = auditTranscript(jsonl, {
      failurePatterns: ["STALE_ELEMENT", "WAIT_TIMEOUT", "element_disabled"],
      ignoredFailurePatterns: ["expected probe"],
    });
    expect(audit.toolErrors).toBe(1);
    expect(audit.patternMatches).toEqual([
      { pattern: "STALE_ELEMENT", tool: "tapOn", line: 4 },
      { pattern: "WAIT_TIMEOUT", tool: "observe", line: 6 },
    ]);
    expect(audit.toolCalls[2]).toMatchObject({ isError: true, errorIgnored: true });
  });

  test("tool_result content may be a string or text blocks", () => {
    expect(toolResultText("plain")).toBe("plain");
    expect(
      toolResultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
    ).toBe("a\nb");
    expect(toolResultText(undefined)).toBe("");
  });

  test("long results are truncated in the record but still pattern-matched", () => {
    const long = `${"x".repeat(1000)} SNAPSHOT_MISSING`;
    const audit = auditTranscript(new TranscriptBuilder().init().mcp("observe", long).build(), {
      failurePatterns: ["SNAPSHOT_MISSING"],
      ignoredFailurePatterns: [],
    });
    expect(audit.toolCalls[0].resultText.length).toBeLessThan(long.length);
    expect(audit.patternMatches).toHaveLength(1);
  });

  test("subagent calls are flagged, permission denials and MCP status are reported", () => {
    const jsonl = new TranscriptBuilder()
      .init({ mcpStatus: "failed" })
      .mcp("observe")
      .tool("mcp__auto-mobile__tapOn", "ok", { parentToolUseId: "toolu_parent" })
      .result({ permissionDenials: [{ tool_name: "Bash", tool_use_id: "t" }] })
      .build();
    const audit = auditTranscript(jsonl, NO_PATTERNS);
    expect(audit.mcpServerStatus).toBe("failed");
    expect(audit.toolCalls.map((call) => call.isSubagent)).toEqual([false, true]);
    expect(audit.permissionDenials).toEqual(["Bash"]);
  });

  test("a missing auto-mobile server and a truncated final line are reported, not thrown", () => {
    const jsonl = `${new TranscriptBuilder().init({ mcpStatus: null }).mcp("observe").build()}{"type":"res`;
    const audit = auditTranscript(jsonl, NO_PATTERNS);
    expect(audit.mcpServerStatus).toBe("missing");
    expect(audit.parseErrors).toHaveLength(1);
    expect(audit.parseErrors[0]).toStartWith("line 6:");
    expect(audit.result).toBeUndefined();
  });

  test("a tool_result for a call the stream never showed is a parse error", () => {
    const orphan = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_ghost", content: "boom", is_error: true },
        ],
      },
    });
    const jsonl = `${new TranscriptBuilder().init().mcp("observe").build()}${orphan}\n`;
    const audit = auditTranscript(jsonl, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["tool_result for unknown tool_use_id toolu_ghost"]);
    expect(audit.toolCalls).toHaveLength(1);
  });

  test("a second tool_result for one call is a parse error and does not overwrite the first", () => {
    const repeat = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "fine" }] },
    });
    const first = new TranscriptBuilder().init().mcp("tapOn", "boom", { isError: true }).build();
    const id = auditTranscript(first, NO_PATTERNS).toolCalls[0].id;
    const audit = auditTranscript(`${first}${repeat.replace("toolu_1", id)}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([`duplicate tool_result for tool_use_id ${id}`]);
    expect(audit.toolCalls[0].isError).toBe(true);
  });

  test("a second result event is a parse error and does not replace the first", () => {
    const first = new TranscriptBuilder()
      .init()
      .mcp("observe")
      .result({ finalText: "first", isError: true })
      .build();
    const second = new TranscriptBuilder().result({ finalText: "second" }).build();
    const audit = auditTranscript(`${first}${second}`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["duplicate result event"]);
    expect(audit.result?.finalText).toBe("first");
  });

  test("malformed message content fails the transcript instead of hiding blocks", () => {
    const event = (type: string, content: unknown) =>
      JSON.stringify({ type, message: { content } });
    const lines = [
      event("assistant", { type: "tool_use", id: "toolu_hidden", name: "mcp__auto-mobile__tapOn" }),
      JSON.stringify({ type: "assistant" }),
      event("user", ["stray"]),
      event("user", "plain text is fine"),
    ];
    const audit = auditTranscript(`${lines.join("\n")}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([
      "line 1: assistant event has malformed content",
      "line 2: assistant event has malformed content",
      "line 3: user event has a non-object block",
    ]);
  });

  test("an init that lists the server twice fails the transcript", () => {
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "m",
      mcp_servers: [
        { name: "auto-mobile", status: "connected" },
        { name: "auto-mobile", status: "failed" },
      ],
    });
    const audit = auditTranscript(`${init}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["init lists auto-mobile 2 times"]);
  });

  test("tool_result content members must be blocks with string text", () => {
    const base = new TranscriptBuilder().init().mcp("observe", "ok", { noResult: true }).build();
    const id = auditTranscript(base, NO_PATTERNS).toolCalls[0].id;
    const result = (content: unknown) =>
      `${JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
      })}\n`;
    const malformed = [`tool_result for ${id} has malformed content`];
    expect(auditTranscript(`${base}${result(["WAIT_TIMEOUT"])}`, NO_PATTERNS).parseErrors).toEqual(
      malformed,
    );
    expect(
      auditTranscript(`${base}${result([{ type: "text", text: 7 }])}`, NO_PATTERNS).parseErrors,
    ).toEqual(malformed);
    expect(
      auditTranscript(`${base}${result([{ type: "image", source: {} }])}`, NO_PATTERNS).parseErrors,
    ).toEqual([]);
  });

  test("a second init event fails the transcript and keeps the first status", () => {
    const init = (status: string) =>
      JSON.stringify({
        type: "system",
        subtype: "init",
        model: "m",
        mcp_servers: [{ name: "auto-mobile", status }],
      });
    const audit = auditTranscript(`${init("failed")}\n${init("connected")}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["duplicate system/init event"]);
    expect(audit.mcpServerStatus).toBe("failed");
  });

  test("tool_result content that is neither text nor blocks fails the transcript", () => {
    const base = new TranscriptBuilder().init().mcp("observe", "ok", { noResult: true }).build();
    const id = auditTranscript(base, NO_PATTERNS).toolCalls[0].id;
    const result = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: { type: "text", text: "WAIT_TIMEOUT" },
          },
        ],
      },
    });
    const audit = auditTranscript(`${base}${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([`tool_result for ${id} has malformed content`]);
  });

  test("a JSON line that is not an object fails the transcript", () => {
    const audit = auditTranscript(`false\nnull\n[1]\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([
      "line 1: not a JSON object",
      "line 2: not a JSON object",
      "line 3: not a JSON object",
    ]);
  });

  test("events after the terminal result fail the transcript and are not counted", () => {
    const before = new TranscriptBuilder().init().result().build();
    const after = new TranscriptBuilder().mcp("observe", "ok").build();
    const audit = auditTranscript(`${before}${after}`, NO_PATTERNS);
    expect(audit.parseErrors.length).toBeGreaterThan(0);
    expect(audit.parseErrors.every((error) => error.includes("event after the result"))).toBe(true);
    expect(audit.totalToolCalls).toBe(0);
  });

  test("a reused tool_use id fails the transcript", () => {
    const use = (name: string) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_x", name, input: {} }] },
      });
    const result = (content: string) =>
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", content }] },
      });
    const lines = [use("mcp__auto-mobile__observe"), result("WAIT_TIMEOUT")];
    lines.push(use("mcp__auto-mobile__tapOn"), result("ok"));
    const audit = auditTranscript(`${lines.join("\n")}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toContain("duplicate tool_use id toolu_x");
    expect(audit.toolCalls[0].resultText).toBe("WAIT_TIMEOUT");
  });

  test("a non-boolean is_error fails the transcript instead of reading as success", () => {
    const base = new TranscriptBuilder().init().mcp("tapOn", "ok", { noResult: true }).build();
    const id = auditTranscript(base, NO_PATTERNS).toolCalls[0].id;
    const result = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: "x", is_error: "true" }],
      },
    });
    const audit = auditTranscript(`${base}${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([`tool_result for ${id} has a non-boolean is_error`]);
  });

  test("a non-boolean terminal is_error fails the transcript", () => {
    const base = new TranscriptBuilder().init().build();
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: "true" });
    const audit = auditTranscript(`${base}${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["result event has a non-boolean is_error"]);
  });

  test("empty model and version strings stay unknown", () => {
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "",
      claude_code_version: " ",
      mcp_servers: [],
    });
    const audit = auditTranscript(`${init}\n`, NO_PATTERNS);
    expect(audit.observedModel).toBeUndefined();
    expect(audit.claudeCodeVersion).toBeUndefined();
    // The assistant-event fallback normalizes the same way.
    const assistant = JSON.stringify({ type: "assistant", message: { model: " ", content: [] } });
    expect(auditTranscript(`${assistant}\n`, NO_PATTERNS).observedModel).toBeUndefined();
  });

  test("terminal metrics outside the baseline domains fail the transcript", () => {
    const result = (fields: Record<string, unknown>) =>
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields })}\n`;
    expect(auditTranscript(result({ num_turns: 2.5 }), NO_PATTERNS).parseErrors).toEqual([
      "result event has an invalid num_turns",
    ]);
    expect(auditTranscript(result({ num_turns: -1 }), NO_PATTERNS).parseErrors).toEqual([
      "result event has an invalid num_turns",
    ]);
    expect(auditTranscript(result({ total_cost_usd: -0.1 }), NO_PATTERNS).parseErrors).toEqual([
      "result event has an invalid total_cost_usd",
    ]);
    expect(auditTranscript(result({ total_cost_usd: "1" }), NO_PATTERNS).parseErrors).toEqual([
      "result event has an invalid total_cost_usd",
    ]);
    expect(
      auditTranscript(result({ num_turns: 0, total_cost_usd: 0 }), NO_PATTERNS).parseErrors,
    ).toEqual([]);
  });

  test("a non-array permission_denials fails the transcript", () => {
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      permission_denials: { tool_name: "Bash" },
    });
    const audit = auditTranscript(`${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["result event has a non-array permission_denials"]);
  });

  test("an empty transcript audits to zero calls with no init", () => {
    const audit = auditTranscript("", NO_PATTERNS);
    expect(audit.totalToolCalls).toBe(0);
    expect(audit.mcpServerStatus).toBeUndefined();
  });
});
