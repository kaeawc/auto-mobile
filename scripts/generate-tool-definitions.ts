#!/usr/bin/env bun
/**
 * Generate MCP tool definitions for IDE YAML completion.
 *
 * Usage:
 *   bun scripts/generate-tool-definitions.ts
 */

import fs from "node:fs";
import path from "node:path";
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
import { registerBiometricTools } from "../src/server/biometricTools";
import { registerTelephonyTools } from "../src/server/telephonyTools";
import { registerHighlightTools } from "../src/server/highlightTools";
import { registerDatabaseTools } from "../src/server/databaseTools";
import { registerStorageTools } from "../src/server/storageTools";
import { registerPreferenceTools } from "../src/server/preferenceTools";
import { registerAppFileTools } from "../src/server/appFileTools";
import { registerSharedStorageTools } from "../src/server/sharedStorageTools";
import { registerFormTools } from "../src/server/formTools";
import { registerAccessibilityTools } from "../src/server/accessibilityTools";
import { registerAccessibilityFocusTools } from "../src/server/accessibilityFocusTools";
import { registerNetworkTools } from "../src/server/networkTools";
import { registerDebugTools } from "../src/server/debugTools";

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
  registerBiometricTools();
  registerTelephonyTools();
  registerHighlightTools();
  registerDatabaseTools();
  registerStorageTools();
  registerPreferenceTools();
  registerAppFileTools();
  registerSharedStorageTools();
  registerFormTools();
  registerAccessibilityTools();
  registerAccessibilityFocusTools();
  registerNetworkTools();
  registerDebugTools();
}

function writeToolDefinitions(outputPath: string): void {
  const toolDefinitions = ToolRegistry.getToolDefinitions({ includeUnavailable: true })
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(toolDefinitions, null, 2)}\n`, "utf8");
  console.log(`Wrote ${toolDefinitions.length} tool definitions to ${resolvedPath}`);
}

registerAllTools();
writeToolDefinitions(OUTPUT_PATH);
