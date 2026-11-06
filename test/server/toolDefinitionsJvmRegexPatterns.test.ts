import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The JUnit runner validates tool calls against schemas/tool-definitions.json with a JVM JSON
// Schema validator, which compiles every `pattern` with java.util.regex. JavaScript treats an
// unescaped `[` inside a character class as a literal; Java reads it as a nested class and fails
// to compile the whole schema (#17247). Escape it as `\[`.

/** Indexes of unescaped `[` characters that appear inside a character class. */
function unescapedBracketsInClass(pattern: string): number[] {
  const offsets: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (!inClass) {
      if (ch === "[") {
        inClass = true;
        // A `]` right after `[` or `[^` is a literal in Java, so it does not close the class.
        if (pattern[i + 1] === "^") {
          i++;
        }
        if (pattern[i + 1] === "]") {
          i++;
        }
      }
      continue;
    }
    if (ch === "[") {
      offsets.push(i);
    } else if (ch === "]") {
      inClass = false;
    }
  }
  return offsets;
}

function collectPatterns(
  node: unknown,
  path: string,
  out: Array<{ path: string; pattern: string }>,
) {
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectPatterns(child, `${path}[${index}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" && typeof value === "string") {
      out.push({ path: `${path}.pattern`, pattern: value });
    } else {
      collectPatterns(value, `${path}.${key}`, out);
    }
  }
}

describe("tool-definitions.json regex patterns", () => {
  test("the bracket scanner flags only an unescaped `[` inside a character class", () => {
    expect(unescapedBracketsInClass("^[A-Za-z0-9.\\-:[\\]]+$")).toEqual([15]);
    expect(unescapedBracketsInClass("^[A-Za-z0-9.\\-:\\[\\]]+$")).toEqual([]);
    expect(unescapedBracketsInClass("^[a-z][0-9]$")).toEqual([]);
    expect(unescapedBracketsInClass("^[^[]$")).toEqual([3]);
    expect(unescapedBracketsInClass("^[]a]$")).toEqual([]);
    expect(unescapedBracketsInClass("^\\[x\\]$")).toEqual([]);
  });

  test("no pattern contains an unescaped `[` inside a character class (java.util.regex rejects it)", () => {
    const definitions: unknown = JSON.parse(
      readFileSync(new URL("../../schemas/tool-definitions.json", import.meta.url), "utf8"),
    );
    const patterns: Array<{ path: string; pattern: string }> = [];
    collectPatterns(definitions, "$", patterns);
    expect(patterns.length).toBeGreaterThan(0);
    const offenders = patterns.filter(
      ({ pattern }) => unescapedBracketsInClass(pattern).length > 0,
    );
    expect(offenders).toEqual([]);
  });
});
