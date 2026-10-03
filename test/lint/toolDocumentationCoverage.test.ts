import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ToolDefinition {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
}

// Wrapper metadata and injected plan state are not user-facing tool options.
const undocumentedParameters = [
  {
    name: "keepScreenAwake",
    reason: "Shared device/session wrapper option, intentionally omitted from user tool docs.",
  },
  {
    name: "__lockNamespace",
    tools: ["barrier", "criticalSection"],
    reason: "Internal plan-scoped lock namespace injected by plan execution, not caller input.",
  },
];

const root = resolve(import.meta.dir, "../..");
let tools: ToolDefinition[];
let documentedTools: Set<string>;
let documentedWords: Set<string>;

function readDocumentation(directory: string): { path: string; content: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return readDocumentation(path);
    }
    // Markdown is the documentation source; exclude binary images and bundled assets.
    return entry.isFile() && entry.name.endsWith(".md")
      ? [{ path, content: readFileSync(path, "utf8") }]
      : [];
  });
}

beforeAll(() => {
  tools = JSON.parse(readFileSync(join(root, "schemas/tool-definitions.json"), "utf8"));
  const docs = readDocumentation(join(root, "docs"));
  // Tokenizing once implements word-boundary matching without rescanning all docs per parameter.
  documentedWords = new Set(docs.flatMap((doc) => doc.content.match(/\b\w+\b/g) ?? []));
  // Reuse the already-read tools.md content rather than reading it a second time.
  const toolsPage = docs.find((doc) => doc.path === join(root, "docs/tools.md"))?.content;
  expect(toolsPage).toBeDefined();
  documentedTools = new Set(
    (toolsPage ?? "")
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|")[1])
      .flatMap((line) => [...line.matchAll(/<code>(\w+)<\/code>/g)].map((match) => match[1])),
  );
});

describe("registered tool documentation", () => {
  test("every registered tool has a tools.md table entry", () => {
    expect(
      tools.filter((tool) => !documentedTools.has(tool.name)).map((tool) => tool.name),
    ).toEqual([]);
  });

  test("every top-level input parameter is documented or explicitly internal", () => {
    const missing: string[] = [];
    for (const tool of tools) {
      for (const parameter of Object.keys(tool.inputSchema.properties ?? {})) {
        const exception = undocumentedParameters.find(
          (entry) => entry.name === parameter && (!entry.tools || entry.tools.includes(tool.name)),
        );
        if (!exception && !documentedWords.has(parameter)) {
          missing.push(`${tool.name}.${parameter}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("internal exceptions have reasons and refer to registered parameters", () => {
    for (const entry of undocumentedParameters) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      const applicable = entry.tools
        ? tools.filter((tool) => entry.tools.includes(tool.name))
        : tools;
      expect(applicable.some((tool) => entry.name in (tool.inputSchema.properties ?? {}))).toBe(
        true,
      );
    }
  });
});
