import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { FeatureFlagKey } from "../../../src/features/featureFlags/FeatureFlagDefinitions";
import { featureFlagDisabledMessage } from "../../../src/features/featureFlags/featureFlagDisabledMessage";
import type { BootedDevice } from "../../../src/models";
import { handleDeviceConditionCall } from "../../../src/server/deviceConditionTool";
import { registerPlanTools } from "../../../src/server/planTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../../src/utils/debug";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { toolField } from "../../helpers/toolResponse";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import { featureFlagDisabledMessageKeys } from "../../lint/featureFlagDisabledMessageSource";

/**
 * Every feature flag whose "off" state refuses a tool call (#16906). Each entry drives the
 * production refusal path with the flag off and returns the text the caller sees. A new gate
 * must add a row here: the first test fails while a `featureFlagDisabledMessage` key in `src/`
 * has no row, and `test/lint/featureFlagDisabledMessageSource.test.ts` refuses a hand-written
 * flag-disabled message anywhere else.
 */
const GATED_REFUSALS: Record<
  string,
  { toolName: string; field?: string; refusal: () => Promise<string> }
> = {
  debug: {
    toolName: "__flag_gate_debug__",
    refusal: async () => {
      const tool = ToolRegistry.getRegisteredTool("__flag_gate_debug__")!;
      return ToolRegistry.getToolAvailabilityGateReasons(tool).join("; ");
    },
  },
  "device-condition": {
    toolName: "setDeviceState",
    field: "deviceCondition",
    refusal: async () => {
      const device: BootedDevice = { name: "e", platform: "android", deviceId: "e" };
      const response = await handleDeviceConditionCall(
        device,
        { deviceCondition: { rootState: "unset" }, sessionUuid: "s" },
        { featureFlags: { isEnabled: () => false } },
      );
      return String(toolField(response, "error"));
    },
  },
  "tool-call-recording": {
    toolName: "recordToolCalls",
    refusal: async () => {
      const response = await ToolRegistry.getTool("recordToolCalls")!.handler({ action: "begin" });
      return String(toolField(response, "error"));
    },
  },
} satisfies Partial<Record<FeatureFlagKey, unknown>>;

// Scan src/ once, outside the timed test bodies.
const helperKeys = [...featureFlagDisabledMessageKeys()].sort();

isolateToolRegistry();

describe("every flag-gated refusal uses featureFlagDisabledMessage (#16906)", () => {
  const originalDebug = isDebugModeEnabled();
  const originalRecording = serverConfig.isToolCallRecordingEnabled();

  beforeAll(() => {
    registerPlanTools();
    ToolRegistry.register("__flag_gate_debug__", "debug gate probe", z.object({}), {
      handler: async () => ({ content: [] }),
      debugOnly: true,
    });
    setDebugModeEnabled(false);
    serverConfig.setToolCallRecordingEnabled(false);
  });

  afterAll(() => {
    setDebugModeEnabled(originalDebug);
    serverConfig.setToolCallRecordingEnabled(originalRecording);
  });

  test("every featureFlagDisabledMessage key in src/ has a gate row here", () => {
    expect(helperKeys).toEqual(Object.keys(GATED_REFUSALS).sort());
  });

  for (const [key, gate] of Object.entries(GATED_REFUSALS)) {
    test(`${key} refuses with the shared message`, async () => {
      expect(await gate.refusal()).toBe(
        featureFlagDisabledMessage(key as FeatureFlagKey, gate.toolName, gate.field),
      );
    });
  }
});
