#!/usr/bin/env bun
/**
 * Generate MCP tool definitions for IDE YAML completion.
 *
 * Usage:
 *   bun scripts/generate-tool-definitions.ts
 *   bun scripts/generate-tool-definitions.ts --check
 */

import fs from "node:fs";
import path from "node:path";
import { findToolDefinitionsDrift } from "./lib/toolDefinitionsDrift";
import { ToolRegistry } from "../src/server/toolRegistry";
import { registerAllTools } from "../src/server/registerAllTools";

const OUTPUT_PATH = "schemas/tool-definitions.json";

function getToolDefinitions(): unknown[] {
  const toolDefinitions = ToolRegistry.getToolDefinitions({ includeUnavailable: true })
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

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--check") || args.length > 1) {
  console.error(`error: unknown arguments: ${args.join(" ")}`);
  process.exit(2);
}

registerAllTools({ daemonMode: true });
const definitions = getToolDefinitions();
if (args[0] === "--check") {
  checkToolDefinitions(OUTPUT_PATH, definitions);
} else {
  writeToolDefinitions(OUTPUT_PATH, definitions);
}
