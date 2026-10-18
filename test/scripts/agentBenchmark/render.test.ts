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
  options: {
    outcome?: Partial<RunOutcome>;
    answer?: string[];
    sequence?: string[];
    baselineAppBuild?: string;
    baselineSuiteDigest?: string;
    baselineModel?: string;
    baselineClaudeVersion?: string;
    baselineDevice?: string;
    baselineServerBuild?: string;
    appBuild?: string;
  } = {},
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
    suiteDigest: "suite0123456789a",
    serverBuild: "sha256=5e5e5e5e5e5e5e5e",
    claude: { requestedModel: "m", observedModel: "claude-test-model", version: "2.1.301" },
    preflight: {
      log: [],
      durationSeconds: 4,
      appBuild: "versionName=1.0 versionCode=7",
      device: "sdk=36 model=pixel locale=en-US size=1080x2400 density=420",
    },
    outcome,
    audit,
    comparison: compareRun(
      audit,
      outcome,
      { answerIncludes: options.answer ?? [], screenIncludes: [] },
      {
        totalToolCalls: 2,
        costUsd: 0.01,
        appBuild: options.baselineAppBuild,
        serverBuild: options.baselineServerBuild,
        suiteDigest: options.baselineSuiteDigest,
        observedModel: options.baselineModel,
        claudeCodeVersion: options.baselineClaudeVersion,
        deviceFingerprint: options.baselineDevice,
      },
      options.sequence,
      {
        appBuild: options.appBuild ?? "versionName=1.0 versionCode=7",
        serverBuild: "sha256=5e5e5e5e5e5e5e5e",
        suiteDigest: "suite0123456789a",
        claudeCodeVersion: "2.1.301",
        deviceFingerprint: "sdk=36 model=pixel locale=en-US size=1080x2400 density=420",
      },
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

  test("baseline cost rounding never overflows a huge finite cost to infinity", () => {
    const huge = new TranscriptBuilder().init().mcp("observe").result({ costUsd: 1e308 });
    const snippet = load(renderBaselineSnippet(result(huge))) as { baseline: { costUsd: number } };
    expect(snippet.baseline.costUsd).toBe(1e308);
    const rounded = new TranscriptBuilder().init().mcp("observe").result({ costUsd: 0.012345 });
    expect(
      (load(renderBaselineSnippet(result(rounded))) as { baseline: { costUsd: number } }).baseline
        .costUsd,
    ).toBe(0.0123);
  });

  test("the baseline snippet is valid suite YAML", () => {
    const snippet = renderBaselineSnippet(result(passing()));
    const suite = parseSuiteDefinition(
      {
        name: "demo",
        platform: "android",
        prompt: "p.txt",
        app: { packageName: "dev.example" },
        verify: { answerIncludes: ["DONE"], screenIncludes: ["Done"] },
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
      appBuild: "versionName=1.0 versionCode=7",
      serverBuild: "sha256=5e5e5e5e5e5e5e5e",
      suiteDigest: "suite0123456789a",
      observedModel: "claude-test-model",
      claudeCodeVersion: "2.1.301",
      deviceFingerprint: "sdk=36 model=pixel locale=en-US size=1080x2400 density=420",
    });
    expect(suite.baselineToolSequence).toEqual(["observe", "tapOn"]);
  });

  test("a baseline from another app build is flagged; a matching one is not", () => {
    const other = result(passing(), { baselineAppBuild: "versionName=0.9 versionCode=6" });
    expect(other.comparison.appBuild).toEqual({
      baseline: "versionName=0.9 versionCode=6",
      current: "versionName=1.0 versionCode=7",
      matches: false,
    });
    expect(renderReport(other)).toContain(
      "! baseline was recorded on versionName=0.9 versionCode=6; deltas compare different app builds",
    );
    const same = result(passing(), { baselineAppBuild: "versionName=1.0 versionCode=7" });
    expect(same.comparison.appBuild?.matches).toBe(true);
    expect(renderReport(same)).not.toContain("baseline was recorded on");
    expect(result(passing()).comparison.appBuild).toBeUndefined();
  });

  test("a baseline from another AutoMobile server bundle is flagged; a matching one is not", () => {
    const stale = result(passing(), { baselineServerBuild: "sha256=0000000000000000" });
    expect(stale.comparison.serverBuild?.matches).toBe(false);
    expect(renderReport(stale)).toContain(
      "! baseline was recorded with AutoMobile server sha256=0000000000000000; this run used sha256=5e5e5e5e5e5e5e5e",
    );
    expect(renderReport(stale)).toContain("server    sha256=5e5e5e5e5e5e5e5e");
    const same = result(passing(), { baselineServerBuild: "sha256=5e5e5e5e5e5e5e5e" });
    expect(same.comparison.serverBuild?.matches).toBe(true);
    expect(renderReport(same)).not.toContain("AutoMobile server sha256");
  });

  test("a baseline from another suite definition is flagged; a matching one is not", () => {
    const changed = result(passing(), { baselineSuiteDigest: "older0123456789a" });
    expect(changed.comparison.suiteDigest).toEqual({
      baseline: "older0123456789a",
      current: "suite0123456789a",
      matches: false,
    });
    expect(renderReport(changed)).toContain(
      "! baseline was recorded with a different prompt or suite settings",
    );
    const same = result(passing(), { baselineSuiteDigest: "suite0123456789a" });
    expect(renderReport(same)).not.toContain("different prompt or suite settings");
  });

  test("a baseline from another device environment is flagged", () => {
    const other = result(passing(), {
      baselineDevice: "sdk=34 model=pixel locale=de-DE size=1x1 density=1",
    });
    expect(renderReport(other)).toContain("! baseline was recorded on a different device (sdk=34");
    expect(renderReport(other)).toContain("env       sdk=36 model=pixel");
  });

  test("a baseline from another Claude Code version is flagged", () => {
    const other = result(passing(), { baselineClaudeVersion: "2.0.1" });
    expect(renderReport(other)).toContain(
      "! baseline was recorded with Claude Code 2.0.1; this run used 2.1.301",
    );
    const same = result(passing(), { baselineClaudeVersion: "2.1.301" });
    expect(renderReport(same)).not.toContain("recorded with Claude Code");
  });

  test("an unknown app build never matches, and is not written into a baseline", () => {
    const unknown = result(passing(), { baselineAppBuild: "unknown", appBuild: "unknown" });
    expect(unknown.comparison.appBuild?.matches).toBe(false);
    const unknownRun = result(passing());
    unknownRun.preflight.appBuild = "unknown";
    expect(load(renderBaselineSnippet(unknownRun))).not.toHaveProperty("baseline.appBuild");
  });

  test("a baseline from another observed model is flagged; the same model is not", () => {
    const other = result(passing(), { baselineModel: "claude-older-model" });
    expect(other.comparison.observedModel).toEqual({
      baseline: "claude-older-model",
      current: "claude-test-model",
      matches: false,
    });
    expect(renderReport(other)).toContain(
      "! baseline was recorded on model claude-older-model; this run used claude-test-model",
    );
    const same = result(passing(), { baselineModel: "claude-test-model" });
    expect(renderReport(same)).not.toContain("recorded on model");
  });
});
