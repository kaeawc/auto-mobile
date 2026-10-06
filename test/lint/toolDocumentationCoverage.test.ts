import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ToolDefinition {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
  _meta?: { "automobile/hidden"?: boolean };
}

// Injected plan state is not a user-facing tool option.
const undocumentedParameters = [
  {
    name: "__lockNamespace",
    tools: ["barrier", "criticalSection"],
    reason: "Internal plan-scoped lock namespace injected by plan execution, not caller input.",
  },
];

const root = resolve(import.meta.dir, "../..");
let tools: ToolDefinition[];
let documentedTools: Set<string>;
let documentedWordsByTool: Map<string, Set<string>>;

// Headings end the preceding section regardless of level. Fenced examples stay
// in their surrounding section. Extract tools.md rows from the category body
// so neighboring tools cannot inherit each other's row parameters.
function documentationSections(markdown: string, toolTable = false): string[] {
  const sections: string[] = [];
  let lines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of markdown.split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      lines.push(line);
      if (
        delimiter &&
        delimiter[1][0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        !delimiter[2].trim()
      ) {
        fence = undefined;
      }
      continue;
    }
    if (delimiter && (delimiter[1][0] !== "`" || !delimiter[2].includes("`"))) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      lines.push(line);
    } else if (toolTable && /^\s*\|/.test(line) && /<code>\w+<\/code>/.test(line)) {
      sections.push(line);
    } else {
      if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) {
        sections.push(lines.join("\n"));
        lines = [];
      }
      lines.push(line);
    }
  }
  sections.push(lines.join("\n"));
  return sections;
}

function wordsByTool(sections: string[], toolNames: string[]): Map<string, Set<string>> {
  const names = new Set(toolNames);
  const result = new Map<string, Set<string>>();
  for (const section of sections) {
    // Schema names are word characters, so this preserves the original \b semantics.
    const words = new Set(section.match(/\b\w+\b/g) ?? []);
    for (const word of words) {
      if (!names.has(word)) {
        continue;
      }
      let documented = result.get(word);
      if (!documented) {
        documented = new Set();
        result.set(word, documented);
      }
      for (const parameter of words) {
        documented.add(parameter);
      }
    }
  }
  return result;
}

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
  // Hidden tools (`startDevice`) are in the catalog only so plan validators accept them as
  // steps; they are deliberately not part of the documented, discoverable tool surface.
  tools = (
    JSON.parse(
      readFileSync(join(root, "schemas/tool-definitions.json"), "utf8"),
    ) as ToolDefinition[]
  ).filter((tool) => tool._meta?.["automobile/hidden"] !== true);
  const docs = readDocumentation(join(root, "docs"));
  documentedWordsByTool = wordsByTool(
    docs.flatMap((doc) =>
      documentationSections(doc.content, doc.path === join(root, "docs/tools.md")),
    ),
    tools.map((tool) => tool.name),
  );
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
        if (!exception && !documentedWordsByTool.get(tool.name)?.has(parameter)) {
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
      expect(applicable.map((tool) => tool.name)).toEqual(entry.tools);
      for (const tool of applicable) {
        expect(entry.name in (tool.inputSchema.properties ?? {})).toBe(true);
      }
    }
  });
});

describe("per-tool Markdown sections", () => {
  test("parameters belong only to tools named in the same section", () => {
    const words = wordsByTool(
      documentationSections("# toolA\nfilter\n## toolB\nother\n### Unowned\nisolated"),
      ["toolA", "toolB"],
    );
    expect(words.get("toolA")?.has("filter")).toBe(true);
    expect(words.get("toolB")?.has("filter")).toBe(false);
    expect(words.get("toolB")?.has("isolated")).toBe(false);
  });

  test("fenced headings do not split sections", () => {
    for (const fence of ["```", "~~~~"]) {
      const sections = documentationSections(
        `# toolA\n${fence}md\n## Example\n${fence}\nfilter\n## toolB\nother`,
      );
      expect(sections).toHaveLength(3);
      const words = wordsByTool(sections, ["toolA", "toolB"]);
      expect(words.get("toolA")?.has("filter")).toBe(true);
      expect(words.get("toolB")?.has("filter")).toBe(false);
    }
  });

  test("tools table rows count independently", () => {
    const words = wordsByTool(
      documentationSections(
        "## Tools\ncategoryOnly\n| <code>toolA</code> | filter |\n| <code>toolB</code> | other |\ntrailingOnly",
        true,
      ),
      ["toolA", "toolB"],
    );
    expect(words.get("toolA")?.has("filter")).toBe(true);
    expect(words.get("toolB")?.has("filter")).toBe(false);
    expect(words.get("toolA")?.has("categoryOnly")).toBe(false);
    expect(words.get("toolB")?.has("trailingOnly")).toBe(false);
  });

  test("fenced table examples stay in their heading section", () => {
    const sections = documentationSections(
      "# toolA\n```md\n| <code>toolB</code> | filter |\n```\nother",
      true,
    );
    expect(sections).toHaveLength(2);
    expect(wordsByTool(sections, ["toolA"]).get("toolA")?.has("filter")).toBe(true);
  });

  test("inline code and whole-word boundaries are preserved", () => {
    const words = wordsByTool(
      documentationSections(
        "# Options\n`toolA` uses `filter`.\n## More\ntoolBExtra uses filterExtra.",
      ),
      ["toolA", "toolB"],
    );
    expect(words.get("toolA")?.has("filter")).toBe(true);
    expect(words.has("toolB")).toBe(false);
    expect(words.get("toolA")?.has("fil")).toBe(false);
  });
});
