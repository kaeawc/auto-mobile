import { readGuardFile } from "./astGuard";
import { describe, expect, test } from "bun:test";

import { join, resolve } from "node:path";

interface ToolDefinition {
  name: string;
}

const root = resolve(import.meta.dir, "../..");

// docs/tools.md is a short index: one table row per tool. Full parameters live
// in the registered schema (schemas/tool-definitions.json), not in prose.
function documentedToolNames(markdown: string): Set<string> {
  return new Set(
    markdown
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|")[1])
      .flatMap((cell) => [...cell.matchAll(/<code>(\w+)<\/code>/g)].map((match) => match[1])),
  );
}

describe("registered tool documentation", () => {
  test("every registered tool has a tools.md table entry", () => {
    const tools: ToolDefinition[] = JSON.parse(
      readGuardFile(join(root, "schemas/tool-definitions.json")),
    );
    const documented = documentedToolNames(readGuardFile(join(root, "docs/tools.md")));
    expect(tools.filter((tool) => !documented.has(tool.name)).map((tool) => tool.name)).toEqual([]);
  });

  test("table rows are read from the first cell only", () => {
    expect([
      ...documentedToolNames("| <code>toolA</code> | mentions <code>toolB</code> |\ntoolC"),
    ]).toEqual(["toolA"]);
  });
});
