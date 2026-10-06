import { INTERNAL_TOOL_PARAM_NAMES } from "../../daemon/constants";
import { INTERNAL_NO_DIFF_PARAM } from "../../server/internalToolCall";
import { PlanStep } from "../../models/Plan";
import { logger } from "../../utils/logger";
import { isInternalStepParam } from "../../constants/internalStepParams";

/**
 * MCP tool names whose successful calls are recorded as plan steps.
 *
 * The registry carries no per-tool "mutates the device" flag (`planExecutable`
 * only widens which gated tools a plan may run), so this list is hand-kept.
 * Infrastructure tools (device management, recording meta-tools, read-only
 * queries) are excluded. `test/features/record/McpCallRecorderCoverage.test.ts`
 * requires every tool in `schemas/tool-definitions.json` to be listed here or
 * excluded there with a reason, so a new action tool cannot be silently left
 * out of the exported plan (#9928).
 */
export const PLAN_RELEVANT_TOOLS = new Set([
  // App lifecycle
  "launchApp",
  "terminateApp",
  "crashApp",
  "appLifecycle",
  // Observation
  "observe",
  // Interaction
  "tapOn",
  "tapAny",
  "tapAt",
  "swipeOn",
  "sendKeys",
  "pressButton",
  "dragAndDrop",
  "pinchOn",
  "selectAllText",
  "clipboard",
  "keyboard",
  // Navigation and system UI
  "homeScreen",
  "recentApps",
  "openLink",
  "systemTray",
  "wakeAndUnlock",
  // Device state and orientation
  "rotate",
  "shake",
  "setPosture",
  "setDeviceState",
  "displayConfig",
  "changeLocalization",
  "setAppPermissions",
  "postNotification",
  // Form filling
  "setUIState",
]);

/**
 * Internal routing params injected by ToolRegistry.registerDeviceAware() that
 * should not appear in recorded PlanStep params.
 *
 * Keep in sync with the params injected in src/server/toolRegistry.ts
 * (search for "args.deviceId", "args.sessionUuid", "args.platform", etc.)
 */
export const INTERNAL_PARAMS = new Set([
  "platform",
  "deviceId",
  "sessionUuid",
  "device",
  "devices",
  "keepScreenAwake",
  ...INTERNAL_TOOL_PARAM_NAMES,
  "__lockNamespace",
  INTERNAL_NO_DIFF_PARAM,
]);

export function stripInternalParams(args: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!INTERNAL_PARAMS.has(key) && !isInternalStepParam(key)) {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Records successful MCP tool calls as PlanStep entries.
 * Designed to be wired into ToolRegistry's wrappedHandler success path.
 */
export class McpCallRecorder {
  private steps: PlanStep[] = [];
  private recording = false;

  start(): void {
    this.steps = [];
    this.recording = true;
    logger.info("[McpCallRecorder] Recording started");
  }

  stop(): PlanStep[] {
    this.recording = false;
    const result = [...this.steps];
    this.steps = [];
    logger.info(`[McpCallRecorder] Recording stopped with ${result.length} steps`);
    return result;
  }

  isRecording(): boolean {
    return this.recording;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  record(toolName: string, args: Record<string, unknown>): void {
    if (!this.recording) {
      return;
    }
    if (!PLAN_RELEVANT_TOOLS.has(toolName)) {
      return;
    }

    const params = stripInternalParams(args);
    this.steps.push({ tool: toolName, params });
    logger.info(`[McpCallRecorder] Recorded step ${this.steps.length}: ${toolName}`);
  }
}
