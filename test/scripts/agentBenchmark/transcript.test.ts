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

  test("an empty transcript audits to zero calls with no init", () => {
    const audit = auditTranscript("", NO_PATTERNS);
    expect(audit.totalToolCalls).toBe(0);
    expect(audit.mcpServerStatus).toBeUndefined();
  });
});
