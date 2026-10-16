import { describe, expect, test } from "bun:test";
import {
  compareRun,
  containsBounded,
  diffToolSequence,
  type RunOutcome,
} from "../../../scripts/agent-benchmark/compare";
import { auditTranscript } from "../../../scripts/agent-benchmark/transcript";
import { TranscriptBuilder } from "./transcriptBuilder";

const OK_OUTCOME: RunOutcome = { claudeExitCode: 0, timedOut: false, wallClockSeconds: 60 };
const NO_VERIFY = { answerIncludes: [], screenIncludes: [] };

function audit(builder: TranscriptBuilder) {
  return auditTranscript(builder.build(), { failurePatterns: [], ignoredFailurePatterns: [] });
}

const cleanRun = () =>
  new TranscriptBuilder().init().mcp("observe").mcp("tapOn").result({ finalText: "COUNT: 3" });

describe("diffToolSequence", () => {
  test("identical sequences are all unchanged lines", () => {
    expect(diffToolSequence(["a", "b"], ["a", "b"]).map((line) => line.kind)).toEqual([
      "same",
      "same",
    ]);
  });

  test("reports baseline-only calls as missing and new calls as extra", () => {
    const lines = diffToolSequence(
      ["observe", "tapOn", "tapOn", "observe"],
      ["observe", "tapOn", "swipeOn", "observe"],
    );
    expect(lines.map((line) => `${line.kind}:${line.tool}`)).toEqual([
      "same:observe",
      "same:tapOn",
      "extra:swipeOn",
      "missing:tapOn",
      "same:observe",
    ]);
    expect(lines[2]).toEqual({ kind: "extra", tool: "swipeOn", actualIndex: 2 });
    expect(lines[3]).toEqual({ kind: "missing", tool: "tapOn", baselineIndex: 2 });
  });

  test("handles empty sides", () => {
    expect(diffToolSequence([], ["a"]).map((line) => line.kind)).toEqual(["extra"]);
    expect(diffToolSequence(["a"], []).map((line) => line.kind)).toEqual(["missing"]);
  });
});

describe("compareRun verdict", () => {
  test("a clean run with matching answer passes", () => {
    const result = compareRun(audit(cleanRun()), OK_OUTCOME, {
      answerIncludes: ["count: 3"],
      screenIncludes: [],
    });
    expect(result.verdict).toBe("passed");
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.stumbles).toBe(0);
  });

  test("a run that never called an auto-mobile tool fails even with the right answer", () => {
    const echoed = new TranscriptBuilder().init().result({ finalText: "COUNT: 3" });
    const result = compareRun(audit(echoed), OK_OUTCOME, {
      answerIncludes: ["COUNT: 3"],
      screenIncludes: [],
    });
    expect(result.verdict).toBe("failed");
    expect(result.checks.find((check) => check.name === "used the device")).toEqual({
      name: "used the device",
      passed: false,
      detail: "no successful auto-mobile tool calls",
    });
    const onlyErrors = new TranscriptBuilder()
      .init()
      .mcp("tapOn", "invalid arguments", { isError: true })
      .result({ finalText: "COUNT: 3" });
    const failed = compareRun(audit(onlyErrors), OK_OUTCOME, {
      answerIncludes: ["COUNT: 3"],
      screenIncludes: [],
    });
    expect(failed.verdict).toBe("failed");
    expect(failed.checks.find((check) => check.name === "used the device")?.passed).toBe(false);
    // A call that never returned a result did not finish either.
    const unfinished = new TranscriptBuilder()
      .init()
      .mcp("tapOn", "ok", { noResult: true })
      .result({ finalText: "COUNT: 3" });
    expect(
      compareRun(audit(unfinished), OK_OUTCOME, {
        answerIncludes: ["COUNT: 3"],
        screenIncludes: [],
      }).verdict,
    ).toBe("failed");
  });

  test("a wrong final answer fails without making the run incomplete", () => {
    const result = compareRun(audit(cleanRun()), OK_OUTCOME, {
      answerIncludes: ["COUNT: 4"],
      screenIncludes: [],
    });
    expect(result.verdict).toBe("failed");
    expect(result.checks.find((check) => check.name === "final answer")?.detail).toBe(
      "missing: COUNT: 4",
    );
  });

  test("the screen check needs a dump and every expected string", () => {
    const verify = { answerIncludes: [], screenIncludes: ["Expected count: 3"] };
    const noDump = compareRun(
      audit(cleanRun()),
      { ...OK_OUTCOME, screenError: "adb gone" },
      verify,
    );
    expect(noDump.verdict).toBe("failed");
    expect(noDump.checks.at(-1)?.detail).toBe("no screen dump (adb gone)");
    const wrong = compareRun(
      audit(cleanRun()),
      { ...OK_OUTCOME, screenText: "Expected count: 2" },
      verify,
    );
    expect(wrong.checks.at(-1)?.detail).toBe("missing: Expected count: 3");
    const right = compareRun(
      audit(cleanRun()),
      { ...OK_OUTCOME, screenText: '<node text="Expected count: 3"/>' },
      verify,
    );
    expect(right.verdict).toBe("passed");
  });

  test("timeouts, failed MCP servers, and missing or errored results are incomplete", () => {
    expect(
      compareRun(
        audit(cleanRun()),
        { ...OK_OUTCOME, timedOut: true, claudeExitCode: null },
        NO_VERIFY,
      ).verdict,
    ).toBe("incomplete");
    expect(
      compareRun(audit(cleanRun()), { ...OK_OUTCOME, claudeExitCode: 1 }, NO_VERIFY).verdict,
    ).toBe("incomplete");
    const failedServer = new TranscriptBuilder().init({ mcpStatus: "failed" }).result();
    expect(compareRun(audit(failedServer), OK_OUTCOME, NO_VERIFY).verdict).toBe("incomplete");
    const noResult = new TranscriptBuilder().init().mcp("observe");
    expect(compareRun(audit(noResult), OK_OUTCOME, NO_VERIFY).verdict).toBe("incomplete");
    const budget = new TranscriptBuilder()
      .init()
      .result({ subtype: "error_max_budget_usd", isError: true });
    const checks = compareRun(audit(budget), OK_OUTCOME, NO_VERIFY).checks;
    expect(checks.find((check) => check.name === "result event")?.detail).toBe(
      "error_max_budget_usd (is_error)",
    );
  });

  test("baseline drift is reported but never changes the verdict", () => {
    const result = compareRun(
      audit(cleanRun()),
      OK_OUTCOME,
      NO_VERIFY,
      {
        totalToolCalls: 10,
        wallClockSeconds: 30,
        costUsd: 0.01,
        tools: { observe: 3, swipeOn: 1 },
      },
      ["observe", "swipeOn", "tapOn"],
    );
    expect(result.verdict).toBe("passed");
    expect(result.metrics.find((row) => row.name === "totalToolCalls")).toEqual({
      name: "totalToolCalls",
      actual: 2,
      baseline: 10,
      delta: -8,
    });
    expect(result.metrics.find((row) => row.name === "costUsd")?.delta).toBe(0.0023);
    expect(result.toolRows.map((row) => [row.name, row.actual, row.baseline])).toEqual([
      ["observe", 1, 3],
      ["swipeOn", 0, 1],
      ["tapOn", 1, 0],
    ]);
    expect(result.sequenceDiff).toMatchObject({ missing: 1, extra: 0 });
  });

  test("without a baseline, metrics carry no delta and there is no sequence diff", () => {
    const result = compareRun(audit(cleanRun()), OK_OUTCOME, NO_VERIFY);
    expect(result.metrics.every((row) => row.delta === undefined)).toBe(true);
    expect(result.toolRows.every((row) => row.baseline === undefined)).toBe(true);
    expect(result.sequenceDiff).toBeUndefined();
  });

  test("stumbles sum tool errors, pattern matches, and permission denials", () => {
    const builder = new TranscriptBuilder()
      .init()
      .mcp("tapOn", "boom", { isError: true })
      .mcp("observe", "WAIT_TIMEOUT")
      .result({ permissionDenials: [{ tool_name: "Bash" }] });
    const transcript = auditTranscript(builder.build(), {
      failurePatterns: ["WAIT_TIMEOUT"],
      ignoredFailurePatterns: [],
    });
    expect(compareRun(transcript, OK_OUTCOME, NO_VERIFY).stumbles).toBe(3);
  });

  test("subagent calls are left out of the compared sequence", () => {
    const builder = new TranscriptBuilder()
      .init()
      .mcp("observe")
      .tool("mcp__auto-mobile__tapOn", "ok", { parentToolUseId: "toolu_parent" })
      .result();
    const result = compareRun(audit(builder), OK_OUTCOME, NO_VERIFY, undefined, ["observe"]);
    expect(result.sequenceDiff).toMatchObject({ missing: 0, extra: 0 });
  });
});

describe("verification text matching", () => {
  test("values must end at a boundary, so a prefix of a larger number never matches", () => {
    expect(containsBounded("EXPECTED_COUNT: 3\nDISPLAYED_COUNT: 2", "expected_count: 3")).toBe(
      true,
    );
    expect(containsBounded("EXPECTED_COUNT: 30", "EXPECTED_COUNT: 3")).toBe(false);
    expect(containsBounded("XEXPECTED_COUNT: 3", "EXPECTED_COUNT: 3")).toBe(false);
    expect(containsBounded('<node text="Expected count: 3" />', "Expected count: 3")).toBe(true);
    expect(
      containsBounded("Step 3: Summary and completion.", "Step 3: Summary and completion"),
    ).toBe(true);
    expect(containsBounded("a (b) [c] 1.5", "(b) [c] 1.5")).toBe(true);
    // Unicode letters bound a match too: a negated or longer word never satisfies it.
    expect(containsBounded("未完了", "完了")).toBe(false);
    expect(containsBounded("不成功", "成功")).toBe(false);
    expect(containsBounded("Café", "Caf")).toBe(false);
    expect(containsBounded("状態: 完了。", "完了")).toBe(true);
    // A decimal or grouped continuation is a different number; sentence punctuation is not.
    expect(containsBounded("EXPECTED_COUNT: 3.5", "EXPECTED_COUNT: 3")).toBe(false);
    expect(containsBounded("EXPECTED_COUNT: 3,000", "EXPECTED_COUNT: 3")).toBe(false);
    expect(containsBounded("EXPECTED_COUNT: 3.", "EXPECTED_COUNT: 3")).toBe(true);
    expect(containsBounded("EXPECTED_COUNT: 3, then 4", "EXPECTED_COUNT: 3")).toBe(true);
    expect(containsBounded("RATE: 0.3 items", "3 items")).toBe(false);
    expect(containsBounded("POPULATION: 1,300 users", "300 users")).toBe(false);
    expect(containsBounded("Done. 3 items", "3 items")).toBe(true);
    // Combining marks continue a word, so decomposed text bounds like precomposed text.
    expect(containsBounded("Cafe\u0301", "Cafe")).toBe(false);
    expect(containsBounded("Cafe\u0301 open", "Cafe\u0301")).toBe(true);
    // A sign belongs to a number that the needle starts with; elsewhere a hyphen is text.
    expect(containsBounded("COUNT: -3 items", "3 items")).toBe(false);
    expect(containsBounded("COUNT: +3 items", "3 items")).toBe(false);
    expect(containsBounded("COUNT: \u22123 items", "3 items")).toBe(false);
    expect(containsBounded("COUNT: -3 items", "-3 items")).toBe(true);
    expect(containsBounded("Status -Done", "Done")).toBe(true);
    // Canonically equivalent forms match each other (NFC vs NFD).
    expect(containsBounded("Cafe\u0301", "Caf\u00e9")).toBe(true);
    expect(containsBounded("Caf\u00e9", "Cafe\u0301")).toBe(true);
  });

  test("an over-tapped run fails both the answer and the screen check", () => {
    const run = new TranscriptBuilder()
      .init()
      .mcp("tapOn")
      .result({ finalText: "EXPECTED_COUNT: 30\nDISPLAYED_COUNT: 20" });
    const result = compareRun(
      audit(run),
      { ...OK_OUTCOME, screenText: "Expected count: 30" },
      {
        answerIncludes: ["EXPECTED_COUNT: 3", "DISPLAYED_COUNT: 2"],
        screenIncludes: ["Expected count: 3"],
      },
    );
    expect(result.verdict).toBe("failed");
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "final answer",
      "device screen",
    ]);
  });
});
