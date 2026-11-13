#!/usr/bin/env bun
/**
 * Generate MCP tool definitions for IDE YAML completion, and each tool's Requires cell in
 * docs/tools.md and on the tool's own page (its TOOL_EMOJI `page`). `--check` also fails when a
 * tool's `requires` disagrees with a runtime gate (#18141), or a tool page lacks its tool row
 * (#18140).
 *
 * Usage:
 *   bun scripts/generate-tool-definitions.ts
 *   bun scripts/generate-tool-definitions.ts --check
 *   bun scripts/generate-tool-definitions.ts --list-docs   # the docs pages it writes, one per line
 */

import fs from "node:fs";
import path from "node:path";
import { findToolDefinitionsDrift } from "./lib/toolDefinitionsDrift";
import {
  applyRequiresColumn,
  findDocsRequiresDrift,
  findMissingToolRows,
  findToolRequirementsDrift,
  REFUSAL_HELPER,
  requirementsByTool,
  scanFeatureFlagRefusals,
  type SourceFile,
} from "./lib/toolRequirementsDrift";
import { ToolRegistry } from "../src/server/toolRegistry";
import { registerAllTools } from "../src/server/registerAllTools";
import { APPLE_PLATFORM_SUPPORTED_TOOLS } from "../src/server/applePlatformToolSupport";
import { TOOL_EMOJI, TOOLS_PAGE } from "../src/server/toolEmoji";

const OUTPUT_PATH = "schemas/tool-definitions.json";
const DOCS_PATH = TOOLS_PAGE;
const SOURCE_ROOT = "src";

function getToolDefinitions(): unknown[] {
  const toolDefinitions = ToolRegistry.getToolDefinitions({
    includeUnavailable: true,
    includeRequirements: true,
  })
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  return JSON.parse(JSON.stringify(toolDefinitions)) as unknown[];
}

function writeToolDefinitions(outputPath: string, toolDefinitions: unknown[]): void {
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(toolDefinitions, null, 2)}\n`, "utf8");
  console.log(`Wrote ${toolDefinitions.length} tool definitions to ${resolvedPath}`);
}

function checkToolDefinitions(outputPath: string, live: unknown[]): void {
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  let committed: unknown;
  try {
    committed = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
  } catch (error) {
    console.error(
      `error: could not read or parse committed tool definitions at ${resolvedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }

  const drift = findToolDefinitionsDrift(committed, live);
  if (drift.invalidCommittedDefinitions) {
    console.error(`error: committed tool definitions at ${resolvedPath} must be a JSON array.`);
    process.exitCode = 1;
    return;
  }

  if (drift.added.length + drift.removed.length + drift.changed.length > 0) {
    console.error("error: committed tool definitions differ from the live definitions:");
    if (drift.added.length > 0) {
      console.error(`  added: ${drift.added.join(", ")}`);
    }
    if (drift.removed.length > 0) {
      console.error(`  removed: ${drift.removed.join(", ")}`);
    }
    if (drift.changed.length > 0) {
      console.error(`  changed: ${drift.changed.join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Tool definitions match the live schemas.");
}

/** TypeScript sources under src/ that call the feature-flag refusal helper. */
function refusalSources(): SourceFile[] {
  const root = path.resolve(process.cwd(), SOURCE_ROOT);
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((relative) => relative.endsWith(".ts"))
    .map((relative) => path.join(SOURCE_ROOT, relative))
    .map((file) => ({
      path: file,
      text: fs.readFileSync(path.resolve(process.cwd(), file), "utf8"),
    }))
    .filter((file) => file.text.includes(REFUSAL_HELPER));
}

function declaredRequirements(definitions: unknown[]): Map<string, string[]> {
  return new Map(
    [...requirementsByTool(definitions)].filter(
      (entry): entry is [string, string[]] => entry[1] !== undefined,
    ),
  );
}

/** Each tool page other than docs/tools.md, with the tools whose TOOL_EMOJI entry names it. */
function toolPages(): Map<string, string[]> {
  const pages = new Map<string, string[]>();
  for (const [tool, entry] of Object.entries(TOOL_EMOJI)) {
    if (entry.page !== undefined && entry.page !== TOOLS_PAGE) {
      pages.set(entry.page, [...(pages.get(entry.page) ?? []), tool]);
    }
  }
  return pages;
}

/** Requires drift on docs/tools.md and on every tool page, plus tool pages missing their row. */
function docsProblems(definitions: unknown[]): string[] {
  const declared = declaredRequirements(definitions);
  const pageProblems = [...toolPages()].flatMap(([page, tools]) => {
    const markdown = readDocs(page);
    return [
      ...findMissingToolRows(markdown, tools),
      ...findDocsRequiresDrift(markdown, declared),
    ].map((problem) => `${page}: ${problem}`);
  });
  return [
    ...findDocsRequiresDrift(readDocs(DOCS_PATH), declared).map(
      (problem) => `${DOCS_PATH}: ${problem}`,
    ),
    ...pageProblems,
  ];
}

/** Report every requirement that disagrees with a runtime gate or with the tool docs. */
function checkRequirements(definitions: unknown[]): boolean {
  const problems = [
    ...findToolRequirementsDrift(definitions, scanFeatureFlagRefusals(refusalSources()), {
      supportedTools: APPLE_PLATFORM_SUPPORTED_TOOLS,
      hiddenTools: new Set(
        ToolRegistry.getEveryRegisteredTool()
          .filter((tool) => tool.hidden)
          .map((tool) => tool.name),
      ),
    }),
    ...docsProblems(definitions),
  ];
  if (problems.length === 0) {
    console.log("Tool requirements match the runtime gates and the tool docs.");
    return true;
  }
  console.error("error: tool requirements drifted:");
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  console.error("Regenerate with: bash scripts/update-tool-definitions.sh");
  return false;
}

function readDocs(page: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), page), "utf8");
}

function writeDocs(definitions: unknown[]): void {
  const declared = declaredRequirements(definitions);
  for (const page of [DOCS_PATH, ...toolPages().keys()]) {
    const resolvedPath = path.resolve(process.cwd(), page);
    fs.writeFileSync(resolvedPath, applyRequiresColumn(readDocs(page), declared));
    console.log(`Updated tool requirements in ${resolvedPath}`);
  }
}

const args = process.argv.slice(2);
if (
  args.some((argument) => argument !== "--check" && argument !== "--list-docs") ||
  args.length > 1
) {
  console.error(`error: unknown arguments: ${args.join(" ")}`);
  process.exit(2);
}
if (args[0] === "--list-docs") {
  console.log([DOCS_PATH, ...toolPages().keys()].join("\n"));
  process.exit(0);
}

registerAllTools({ daemonMode: true });
const definitions = getToolDefinitions();
if (args[0] === "--check") {
  checkToolDefinitions(OUTPUT_PATH, definitions);
  if (!checkRequirements(definitions)) {
    process.exitCode = 1;
  }
} else {
  writeToolDefinitions(OUTPUT_PATH, definitions);
  writeDocs(definitions);
  if (!checkRequirements(definitions)) {
    process.exitCode = 1;
  }
}
