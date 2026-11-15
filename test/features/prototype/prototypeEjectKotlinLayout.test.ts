import { describe, expect, test } from "bun:test";
import { ktfmtLayout } from "../../../src/features/prototype/prototypeEjectKotlinLayout";

describe("ktfmtLayout", () => {
  test("maps the four-space emitter indent to ktfmt's two-space indent", () => {
    expect(ktfmtLayout(["fun A() {", "    Box {", "        Text()", "    }", "}"])).toEqual([
      "fun A() {",
      "  Box {",
      "    Text()",
      "  }",
      "}",
    ]);
  });

  test("collapses an empty lambda argument", () => {
    expect(ktfmtLayout(["Button(", "    onClick = {", "    },", ")"])).toEqual([
      "Button(",
      "  onClick = {},",
      ")",
    ]);
  });

  test("refills a comment wider than 100 columns at its indent", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const lines = ktfmtLayout([`    // ${words}`]);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.startsWith("  // ") && line.length <= 100)).toBe(true);
    expect(lines.map((line) => line.slice(5)).join(" ")).toBe(words);
  });

  test("puts each argument of an over-long call on its own line with a trailing comma", () => {
    const text = `"${"x".repeat(80)}, still the same string"`;
    expect(
      ktfmtLayout([`    Row(modifier = Modifier.testTag("a, b"), label = ${text}) {`]),
    ).toEqual([
      "  Row(",
      '    modifier = Modifier.testTag("a, b"),',
      `    label = ${text},`,
      "  ) {",
    ]);
  });

  test("leaves lines within the limit untouched", () => {
    expect(ktfmtLayout(['Text(text = "a, b", modifier = Modifier)'])).toEqual([
      'Text(text = "a, b", modifier = Modifier)',
    ]);
  });
});
