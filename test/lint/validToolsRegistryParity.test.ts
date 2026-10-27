import { readGuardFile } from "./astGuard";
import { describe, expect, test } from "bun:test";

const validToolsPath =
  "android/test-plan-validation/src/main/kotlin/dev/jasonpearson/automobile/validation/ValidTools.kt";

/** Every string literal in the Kotlin file, with block and line comments removed first. */
export function kotlinStringLiterals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/"([^"\\\n]*)"/g)].map((m) => m[1]);
}

function registryNames(): string[] {
  const defs = JSON.parse(readGuardFile("schemas/tool-definitions.json")) as {
    name: string;
  }[];
  return defs.map((d) => d.name);
}

describe("ValidTools.kt parity with the tool registry", () => {
  test("accepts every tool in schemas/tool-definitions.json", () => {
    const accepted = new Set(kotlinStringLiterals(readGuardFile(validToolsPath)));
    const missing = registryNames().filter((name) => !accepted.has(name));
    // A new tool must be added to ValidTools.TOOLS or ValidToolsTest fails in the Kotlin Code Coverage job.
    expect(missing).toEqual([]);
  });

  test("the extractor ignores comments and finds the setOf entries", () => {
    const literals = kotlinStringLiterals(
      '// "commented"\n/* "block" */\nval a = setOf("x", "y")\n',
    );
    expect(literals).toEqual(["x", "y"]);
  });
});
