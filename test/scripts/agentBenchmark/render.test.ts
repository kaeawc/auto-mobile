import { describe, expect, test } from "bun:test";
import { load } from "js-yaml";
import {
  compareRun,
  diffToolSequence,
  type RunOutcome,
} from "../../../scripts/agent-benchmark/compare";
import { parseSuiteDefinition } from "../../../scripts/agent-benchmark/config";
import {
  formatDuration,
  renderBaselineSnippet,
  renderReport,
  renderSummary,
  visibleSequenceLines,
} from "../../../scripts/agent-benchmark/render";
import type { BenchmarkResult } from "../../../scripts/agent-benchmark/result";
import { auditTranscript } from "../../../scripts/agent-benchmark/transcript";
import { TranscriptBuilder } from "./transcriptBuilder";

function result(
  builder: TranscriptBuilder,
  options: { outcome?: Partial<RunOutcome>; answer?: string[]; sequence?: string[] } = {},
): BenchmarkResult {
  const audit = auditTranscript(builder.build(), {
    failurePatterns: ["WAIT_TIMEOUT"],
    ignoredFailurePatterns: [],
  });
  const outcome = {
    claudeExitCode: 0,
    timedOut: false,
    wallClockSeconds: 75.5,
    ...options.outcome,
  };
  return {
    suite: "demo",
    suitePath: "/suites/demo.yml",
    runDirectory: "/out/demo/20261016T010203Z",
    startedAt: "20261016T010203Z",
    deviceSerial: "emulator-5554",
    claude: { requestedModel: "m", observedModel: "claude-test-model", version: "2.1.301" },
    preflight: { log: [], durationSeconds: 4, appBuild: "versionName=1.0 versionCode=7" },
    outcome,
    audit,
    comparison: compareRun(
      audit,
      outcome,
      { answerIncludes: options.answer ?? [], screenIncludes: [] },
      { totalToolCalls: 2, costUsd: 0.01 },
      options.sequence,
    ),
  };
}

const passing = () =>
  new TranscriptBuilder().init().mcp("observe").mcp("tapOn").result({ costUsd: 0.0123 });

describe("agent benchmark rendering", () => {
  test("durations read naturally", () => {
    expect(formatDuration(4.25)).toBe("4.3s");
    expect(formatDuration(75.5)).toBe("1m 15.5s");
  });

  test("a passing report shows checks and metrics without the inspect block", () => {
    const report = renderReport(result(passing()));
    expect(report).toContain("PASSED  demo  1m 15.5s");
    expect(report).toContain("device    emulator-5554 (preflight 4.0s, not measured)");
    expect(report).toContain("app       versionName=1.0 versionCode=7");
    expect(report).toContain("model=claude-test-model version=2.1.301");
    expect(report).toContain("✓ mcp server connected   connected");
    expect(report).toMatch(/costUsd\s+0\.0123\s+0\.0100\s+\+0\.0023/);
    expect(report).toMatch(/totalToolCalls\s+2\s+2\s+0/);
    expect(report).toContain("Stumbles: 0");
    expect(report).not.toContain("Inspect");
  });

  test("a failing report lists stumbles, the sequence diff, and where to look", () => {
    const failing = new TranscriptBuilder()
      .init()
      .mcp("tapOn", "Element not found\nstack...", { isError: true })
      .mcp("observe", "WAIT_TIMEOUT")
      .result({ finalText: "nope" });
    const report = renderReport(
      result(failing, { answer: ["COUNT: 3"], sequence: ["observe", "tapOn"] }),
    );
    expect(report).toContain("FAILED  demo");
    expect(report).toContain("✗ final answer");
    expect(report).toContain("Stumbles: 2");
    expect(report).toContain("• tapOn @ line 4: Element not found");
    expect(report).toContain("• pattern WAIT_TIMEOUT in observe @ line 6");
    expect(report).toContain("Tool sequence: 1 missing from baseline, 1 additional");
    expect(report).toContain("transcript /out/demo/20261016T010203Z/claude.jsonl");
  });

  test("sequence output keeps changes with one line of context", () => {
    const lines = diffToolSequence(["a", "b", "c", "d", "e", "f"], ["a", "b", "c", "x", "e", "f"]);
    expect(visibleSequenceLines(lines).map((line) => `${line.kind}:${line.tool}`)).toEqual([
      "same:c",
      "extra:x",
      "missing:d",
      "same:e",
    ]);
  });

  test("the summary counts passing and non-passing runs", () => {
    const summary = renderSummary([
      result(passing()),
      result(passing(), { outcome: { timedOut: true }, sequence: ["observe"] }),
    ]);
    expect(summary).toContain("Agent benchmarks: 2 run · 1 passed · 1 not passed");
    expect(summary).toContain("Measured time: 2m 31.0s");
    expect(summary).toMatch(/incomplete\s+demo\s+1m 15\.5s · 0 stumble\(s\) · sequence 0m\/1a/);
  });

  test("the baseline snippet is valid suite YAML", () => {
    const snippet = renderBaselineSnippet(result(passing()));
    const suite = parseSuiteDefinition(
      {
        name: "demo",
        platform: "android",
        prompt: "p.md",
        app: { packageName: "dev.example" },
        verify: { answerIncludes: ["DONE"] },
        ...(load(snippet) as object),
      },
      "demo.yml",
    );
    expect(suite.baseline).toEqual({
      totalToolCalls: 2,
      mcpToolCalls: 2,
      toolErrors: 0,
      wallClockSeconds: 75.5,
      numTurns: 3,
      costUsd: 0.0123,
      tools: { observe: 1, tapOn: 1 },
    });
    expect(suite.baselineToolSequence).toEqual(["observe", "tapOn"]);
  });
});
