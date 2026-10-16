import { describe, expect, test } from "bun:test";
import { countRows, findDirectives } from "../../scripts/lib/oxlintDisableScan";

describe("oxlintDisableScan", () => {
  test("counts one directive per rule and normalises eslint/ prefix", () => {
    const [d] = findDirectives("// eslint-disable-next-line eslint/complexity, max-params -- why");
    expect(d.rules).toEqual(["complexity", "max-params"]);
    expect(d.hasReason).toBe(true);
  });

  test("flags reason-less directives and bare block directives", () => {
    const ds = findDirectives(
      "x(); // oxlint-disable-line max-depth\n/* eslint-disable */\n/* eslint-disable foo -- r */",
    );
    expect(ds.map((d) => [d.rules, d.hasReason])).toEqual([
      [["max-depth"], false],
      [["*"], false],
      [["foo"], true],
    ]);
  });

  test("ignores enable directives and directive text inside strings", () => {
    expect(
      findDirectives('/* eslint-enable foo */\nconst s = "// oxlint-disable-next-line a";'),
    ).toEqual([]);
  });

  test("countRows emits a no-reason row only for reason-less directives", () => {
    const counts = new Map<string, number>();
    countRows(
      "src/a.ts",
      "// oxlint-disable-next-line a\n// oxlint-disable-next-line a -- r",
      counts,
    );
    expect(counts.get("src/a.ts\toxlint-disable(a)")).toBe(2);
    expect(counts.get("src/a.ts\toxlint-disable-no-reason(a)")).toBe(1);
  });
});
