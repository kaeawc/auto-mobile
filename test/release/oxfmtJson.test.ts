import { describe, expect, test } from "bun:test";
import {
  formatJsonWithOxfmt,
  type OxfmtRunner,
  stableJson,
} from "../../scripts/release/lib/oxfmt-json";

function recordingRunner(result: ReturnType<OxfmtRunner>): {
  run: OxfmtRunner;
  calls: Array<{ input: string; filepath: string; cwd: string }>;
} {
  const calls: Array<{ input: string; filepath: string; cwd: string }> = [];
  return {
    calls,
    run: (input, filepath, cwd) => {
      calls.push({ input, filepath, cwd });
      return result;
    },
  };
}

describe("formatJsonWithOxfmt (#18333)", () => {
  test("pipes stableJson through the formatter with the repo-relative path", () => {
    const value = { roots: ["a", "b"] };
    const formatted = '{\n  "roots": ["a", "b"]\n}\n';
    const { run, calls } = recordingRunner({ status: 0, stdout: formatted, stderr: "" });
    expect(formatJsonWithOxfmt(value, "scripts/release/runtime-graph.json", "/repo", run)).toBe(
      formatted,
    );
    expect(calls).toEqual([
      { input: stableJson(value), filepath: "scripts/release/runtime-graph.json", cwd: "/repo" },
    ]);
  });

  test("returns the formatter output, not the expanded JSON.stringify layout", () => {
    const { run } = recordingRunner({ status: 0, stdout: '{ "roots": ["a"] }', stderr: "" });
    expect(formatJsonWithOxfmt({ roots: ["a"] }, "x.json", "/repo", run)).toBe(
      '{ "roots": ["a"] }\n',
    );
  });

  test("throws with stderr when the formatter fails", () => {
    const { run } = recordingRunner({ status: 1, stdout: "", stderr: "parse error\n" });
    expect(() => formatJsonWithOxfmt({}, "x.json", "/repo", run)).toThrow(
      "oxfmt failed to format x.json: parse error",
    );
  });

  test("throws when the formatter could not be spawned", () => {
    const { run } = recordingRunner({ status: null, stdout: "", stderr: "" });
    expect(() => formatJsonWithOxfmt({}, "x.json", "/repo", run)).toThrow("exit null");
  });

  test("throws when the formatter prints nothing", () => {
    const { run } = recordingRunner({ status: 0, stdout: "  \n", stderr: "" });
    expect(() => formatJsonWithOxfmt({}, "x.json", "/repo", run)).toThrow("no output");
  });
});
