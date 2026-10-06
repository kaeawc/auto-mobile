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
import { registerObserveTools } from "../src/server/observeTools";
import { registerInteractionTools } from "../src/server/interactionTools";
import { registerAppTools } from "../src/server/appTools";
import { registerUtilityTools } from "../src/server/utilityTools";
import { registerDeviceTools } from "../src/server/deviceTools";
import { registerToolSelectionTools } from "../src/server/toolSelectionTools";
import { registerDeepLinkTools } from "../src/server/deepLinkTools";
import { registerNavigationTools } from "../src/server/navigationTools";
import { registerNotificationTools } from "../src/server/notificationTools";
import { registerPlanTools } from "../src/server/planTools";
import { registerCriticalSectionTools } from "../src/server/criticalSectionTools";
import { registerBarrierTools } from "../src/server/barrierTools";
import { registerVideoRecordingTools } from "../src/server/videoRecordingTools";
import { registerSnapshotTools } from "../src/server/snapshotTools";
import { registerSnapshotOfTools } from "../src/server/snapshotOfTools";
import { registerBiometricTools } from "../src/server/biometricTools";
import { registerTelephonyTools } from "../src/server/telephonyTools";
import { registerOverlayTools } from "../src/server/overlayTools";
import { registerHighlightTools } from "../src/server/highlightTools";
import { registerDatabaseTools } from "../src/server/databaseTools";
import { registerStorageTools } from "../src/server/storageTools";
import { registerPreferenceTools } from "../src/server/preferenceTools";
import { registerAppFileTools } from "../src/server/appFileTools";
import { registerSessionLogTools } from "../src/server/sessionLogTools";
import { registerDownloadsFixtureTools } from "../src/server/downloadsFixtureTools";
import { registerFormTools } from "../src/server/formTools";
import { registerAccessibilityTools } from "../src/server/accessibilityTools";
import { registerAccessibilityFocusTools } from "../src/server/accessibilityFocusTools";
import { registerNetworkTools } from "../src/server/networkTools";

const OUTPUT_PATH = "schemas/tool-definitions.json";

function registerAllTools(): void {
  registerObserveTools();
  registerInteractionTools();
  registerAppTools();
  registerUtilityTools();
  registerDeviceTools();
  registerToolSelectionTools();
  registerDeepLinkTools();
  registerNavigationTools();
  registerNotificationTools();
  registerPlanTools();
  registerCriticalSectionTools();
  registerBarrierTools();
  registerVideoRecordingTools();
  registerSnapshotTools();
  registerSnapshotOfTools();
  registerBiometricTools();
  registerTelephonyTools();
  registerHighlightTools();
  registerOverlayTools();
  registerDatabaseTools();
  registerStorageTools();
  registerPreferenceTools();
  registerAppFileTools();
  registerSessionLogTools();
  registerDownloadsFixtureTools();
  registerFormTools();
  registerAccessibilityTools();
  registerAccessibilityFocusTools();
  registerNetworkTools();
}

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

registerAllTools();
const definitions = getToolDefinitions();
if (args[0] === "--check") {
  checkToolDefinitions(OUTPUT_PATH, definitions);
} else {
  writeToolDefinitions(OUTPUT_PATH, definitions);
}
