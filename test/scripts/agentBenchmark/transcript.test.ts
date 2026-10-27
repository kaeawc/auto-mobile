import { describe, expect, test } from "bun:test";
import { auditTranscript, toolResultText } from "../../../scripts/agent-benchmark/transcript";
import { TranscriptBuilder } from "./transcriptBuilder";

const NO_PATTERNS = { failurePatterns: [], ignoredFailurePatterns: [] };
/** Builder init output (a connected system/init on line 2 of 3), required before any assistant, user, or result event. */
const INIT = new TranscriptBuilder().init().build();

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

  test("activity before system/init fails the transcript", () => {
    const assistant = JSON.stringify({
      type: "assistant",
      message: { model: "wrong-model", content: [] },
    });
    const init = new TranscriptBuilder().init().build();
    const audit = auditTranscript(`${assistant}\n${init}`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["line 1: assistant event before system/init"]);
    expect(audit.observedModel).not.toBe("wrong-model");
  });

  test("a tool_use without a name fails the transcript", () => {
    const use = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_nameless", name: " ", input: {} }] },
    });
    const audit = auditTranscript(`${INIT}${use}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["line 4: tool_use without a name"]);
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
    const audit = auditTranscript(`${INIT}${lines.join("\n")}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([
      "line 4: assistant event has malformed content",
      "line 5: assistant event has malformed content",
      "line 6: user event has a non-object block",
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
    // A nested block needs a type too, or it reads as empty text.
    expect(auditTranscript(`${base}${result([{}])}`, NO_PATTERNS).parseErrors).toEqual(malformed);
    // A text block without its text would read as empty successful output.
    expect(
      auditTranscript(`${base}${result([{ type: "text" }])}`, NO_PATTERNS).parseErrors,
    ).toEqual(malformed);
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
    // A missing body would otherwise count as a completed, successful call.
    const bare = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false }] },
    });
    expect(auditTranscript(`${base}${bare}\n`, NO_PATTERNS).parseErrors).toEqual([
      `tool_result for ${id} has no content`,
    ]);
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

  test("a tool_use without an id fails the transcript and a blank result cannot complete it", () => {
    const use = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "", name: "mcp__auto-mobile__observe", input: {} }],
      },
    });
    const result = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "", content: "ok" }] },
    });
    const audit = auditTranscript(`${INIT}${use}\n${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([
      "line 4: tool_use without an id",
      "tool_result for unknown tool_use_id (missing)",
    ]);
    expect(audit.toolCalls[0].hasResult).toBe(false);
  });

  test("a padded tool name is not canonicalized into a registered tool", () => {
    const use = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_pad", name: " mcp__auto-mobile__observe ", input: {} },
        ],
      },
    });
    expect(auditTranscript(`${INIT}${use}\n`, NO_PATTERNS).parseErrors).toEqual([
      "line 4: tool_use name has surrounding whitespace",
    ]);
  });

  test("padded types and ids are not trimmed into a match", () => {
    const lines = [
      JSON.stringify({ type: " assistant ", message: { content: [] } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: " tool_use ", id: "toolu_a", name: "x", input: {} }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: " toolu_1 ", name: "mcp__auto-mobile__observe", input: {} },
          ],
        },
      }),
      // A clean id cannot complete the padded call.
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      }),
    ];
    expect(auditTranscript(`${INIT}${lines.join("\n")}\n`, NO_PATTERNS).parseErrors).toEqual([
      "line 4: event without an exact type",
      "line 5: assistant event has a block without an exact type",
      "line 6: tool_use id has surrounding whitespace",
      "tool_result for unknown tool_use_id toolu_1",
    ]);
  });

  test("tool blocks under the wrong message role fail the transcript", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_use", id: "toolu_misplaced", name: "mcp__auto-mobile__tapOn", input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "ok" }] },
      }),
    ];
    expect(auditTranscript(`${INIT}${lines.join("\n")}\n`, NO_PATTERNS).parseErrors).toEqual([
      "line 4: tool_use in a user event",
      "line 5: tool_result in an assistant event",
    ]);
  });

  test("a tool_use without an object input fails the transcript", () => {
    const uses = [undefined, "tap", [1]].map((input, index) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: `toolu_${index}`, name: "mcp__auto-mobile__tapOn", input },
          ],
        },
      }),
    );
    expect(auditTranscript(`${INIT}${uses.join("\n")}\n`, NO_PATTERNS).parseErrors).toEqual([
      "line 4: tool_use without an object input",
      "line 5: tool_use without an object input",
      "line 6: tool_use without an object input",
    ]);
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
    const audit = auditTranscript(`${INIT}${lines.join("\n")}\n`, NO_PATTERNS);
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
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: 1,
      total_cost_usd: 0,
      permission_denials: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      is_error: "true",
      result: "done",
    });
    const audit = auditTranscript(`${base}${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["result event has a missing or non-boolean is_error"]);
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
    expect(auditTranscript(`${init}\n${assistant}\n`, NO_PATTERNS).observedModel).toBeUndefined();
  });

  test("terminal metrics outside the baseline domains fail the transcript", () => {
    const result = (fields: Record<string, unknown>) =>
      `${INIT}${JSON.stringify({ type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0, permission_denials: [], usage: { input_tokens: 0, output_tokens: 0 }, is_error: false, result: "done", ...fields })}\n`;
    expect(auditTranscript(result({ num_turns: 2.5 }), NO_PATTERNS).parseErrors).toEqual([
      "result event has an invalid num_turns",
    ]);
    expect(auditTranscript(result({ num_turns: -1 }), NO_PATTERNS).parseErrors).toEqual([
      "result event has an invalid num_turns",
    ]);
    // Past 2^53 JSON parsing has already rounded the count.
    expect(auditTranscript(result({ num_turns: 2 ** 53 + 2 }), NO_PATTERNS).parseErrors).toEqual([
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

  test("a terminal result without is_error fails the transcript", () => {
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: 1,
      total_cost_usd: 0,
      permission_denials: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      result: "done",
    });
    const audit = auditTranscript(`${INIT}${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["result event has a missing or non-boolean is_error"]);
  });

  test("an event without a type fails the transcript; an unknown type is skipped", () => {
    const untyped = JSON.stringify({ message: { content: [] } });
    const blank = JSON.stringify({ type: " " });
    const future = JSON.stringify({ type: "future_event_kind" });
    const audit = auditTranscript(`${INIT}${untyped}\n${blank}\n${future}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([
      "line 4: event without an exact type",
      "line 5: event without an exact type",
    ]);
  });

  test("an invalid parent_tool_use_id fails the transcript", () => {
    const event = (parent: unknown) =>
      JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content: [] } });
    const audit = auditTranscript(
      `${INIT}${event(123)}\n${event(" ")}\n${event(null)}\n${event("toolu_parent")}\n${event(" toolu_parent ")}\n`,
      NO_PATTERNS,
    );
    expect(audit.parseErrors).toEqual([
      "line 4: invalid parent_tool_use_id",
      "line 5: invalid parent_tool_use_id",
      // A padded id is not the parent's exact id.
      "line 8: invalid parent_tool_use_id",
    ]);
  });

  test("token usage must be non-negative safe-integer counts", () => {
    const result = (usage: unknown) =>
      `${INIT}${JSON.stringify({ type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0, permission_denials: [], is_error: false, result: "done", usage })}\n`;
    // A fraction is not a count, and past 2^53 the value would lose precision in result.json.
    expect(
      auditTranscript(
        result({ input_tokens: 1.5, cache_read_input_tokens: 2 ** 53, output_tokens: 0 }),
        NO_PATTERNS,
      ).parseErrors,
    ).toEqual([
      "result event has an invalid usage.input_tokens",
      "result event has an invalid usage.cache_read_input_tokens",
    ]);
    expect(
      auditTranscript(result({ input_tokens: 0, output_tokens: -1 }), NO_PATTERNS).parseErrors,
    ).toEqual(["result event has an invalid usage.output_tokens"]);
    // A successful result's counters are required: an absent one would read as zero.
    expect(auditTranscript(result({ input_tokens: 4 }), NO_PATTERNS).parseErrors).toEqual([
      "result event has no usage.output_tokens",
    ]);
    expect(auditTranscript(result([1]), NO_PATTERNS).parseErrors).toEqual([
      "result event has a malformed usage",
    ]);
    // Safe components can still sum past 2^53 and store an imprecise total.
    const max = Number.MAX_SAFE_INTEGER;
    expect(
      auditTranscript(
        result({
          input_tokens: max,
          cache_creation_input_tokens: max,
          cache_read_input_tokens: max,
          output_tokens: 0,
        }),
        NO_PATTERNS,
      ).parseErrors,
    ).toEqual(["result event has an imprecise input token total"]);
    expect(
      auditTranscript(result({ input_tokens: 4, output_tokens: 2 }), NO_PATTERNS).parseErrors,
    ).toEqual([]);
  });

  test("a successful result must report num_turns, total_cost_usd, permission_denials and usage", () => {
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "x",
    });
    const audit = auditTranscript(`${INIT}${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([
      "result event has no num_turns",
      "result event has no total_cost_usd",
      "result event has no usage",
      "result event has no permission_denials",
    ]);
  });

  test("a terminal result without a final answer fails the transcript", () => {
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: 1,
      total_cost_usd: 0,
      permission_denials: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      is_error: false,
    });
    const audit = auditTranscript(`${INIT}${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["result event has a missing or non-string result"]);
  });

  test("a content block without a type fails the transcript; an unknown block type is skipped", () => {
    const assistant = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ id: "toolu_hidden", name: "mcp__auto-mobile__tapOn" }, { type: "future" }],
      },
    });
    const audit = auditTranscript(`${INIT}${assistant}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual([
      "line 4: assistant event has a block without an exact type",
    ]);
  });

  test("a non-string final answer fails the transcript", () => {
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: 1,
      total_cost_usd: 0,
      permission_denials: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      is_error: false,
      result: { text: "COUNT: 3" },
    });
    const audit = auditTranscript(`${INIT}${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["result event has a missing or non-string result"]);
  });

  test("a non-array permission_denials fails the transcript", () => {
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: 1,
      total_cost_usd: 0,
      is_error: false,
      result: "done",
      usage: { input_tokens: 0, output_tokens: 0 },
      permission_denials: { tool_name: "Bash" },
    });
    const audit = auditTranscript(`${INIT}${result}\n`, NO_PATTERNS);
    expect(audit.parseErrors).toEqual(["result event has a non-array permission_denials"]);
  });

  test("an empty transcript audits to zero calls with no init", () => {
    const audit = auditTranscript("", NO_PATTERNS);
    expect(audit.totalToolCalls).toBe(0);
    expect(audit.mcpServerStatus).toBeUndefined();
  });
});
