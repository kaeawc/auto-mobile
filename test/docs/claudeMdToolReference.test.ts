import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

function extractInteractionToolNames(claudeMarkdown: string): string[] {
  const normalized = claudeMarkdown.replace(/\r\n?/g, "\n");
  // Expected Markdown shape: a bulleted line of backtick-quoted, comma-separated tool names
  // between the "## Interaction" heading and the next "## " heading.
  const referenceSection = normalized.match(
    /^# MCP Tools Reference[ \t]*\n([\s\S]*?)(?=^# |(?![\s\S]))/m,
  )?.[1];
  expect(referenceSection, 'Could not find the "## MCP Tools Reference" section').toBeDefined();

  const interactionSection = referenceSection?.match(
    /^## Interaction[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m,
  )?.[1];
  expect(interactionSection, 'Could not find the "## Interaction" section').toBeDefined();

  const interactionLine = interactionSection?.match(/^\s*-\s+[^\n]*`[^`]+`[^\n]*$/m)?.[0];
  expect(
    interactionLine,
    'Could not find a backticked tool list under "## Interaction"',
  ).toBeDefined();

  const listedToolNames =
    interactionLine?.match(/`([^`]+)`/g)?.map((name) => name.slice(1, -1)) ?? [];
  expect(
    listedToolNames.length,
    "Expected at least one backticked tool name in the interaction list",
  ).toBeGreaterThan(0);

  return listedToolNames;
}

describe("CLAUDE.md MCP interaction tool reference", () => {
  test("lists only tools defined in the tool schema", () => {
    const repoRoot = join(import.meta.dir, "../..");
    const definitions = JSON.parse(
      readFileSync(join(repoRoot, "schemas/tool-definitions.json"), "utf8"),
    ) as { name: string }[];
    const validToolNames = new Set(definitions.map(({ name }) => name));
    const claudeMarkdown = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    const listedToolNames = extractInteractionToolNames(claudeMarkdown);

    for (const name of listedToolNames) {
      expect(validToolNames.has(name), `CLAUDE.md lists unknown MCP tool "${name}"`).toBe(true);
    }
  });

  test("parses a CRLF Markdown fixture", () => {
    const fixture = [
      "# MCP Tools Reference",
      "## Interaction",
      "- `tapOn`, `sendKeys`",
      "## App Management",
    ].join("\r\n");

    expect(extractInteractionToolNames(fixture)).toEqual(["tapOn", "sendKeys"]);
  });
});
