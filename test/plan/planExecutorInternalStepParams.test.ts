import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { INTERNAL_TOOL_PARAM_NAMES } from "../../src/daemon/constants";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";

const toolName = "testInternalStepParams";

describe("PlanExecutor saved internal step params", () => {
  afterEach(() => ToolRegistry.unregister(toolName));

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "cleans old exports before injection (requiresDevice=%p, injectSession=%p)",
    async (requiresDevice, injectSession) => {
      const captured: Record<string, unknown>[] = [];
      ToolRegistry.register(
        toolName,
        "Capture clean replay params",
        z
          .object({
            appId: z.string(),
            _oneUnderscore: z.string(),
            platform: z.string(),
            deviceId: z.string(),
            device: z.string(),
            sessionUuid: z.string(),
            __lockNamespace: z.string().optional(),
          })
          .strict(),
        async (args) => {
          captured.push(args);
          return createStructuredToolResponse({ success: true });
        },
        { acceptsPlanLockNamespace: requiresDevice },
      );
      ToolRegistry.getTool(toolName)!.requiresDevice = requiresDevice;
      const params = {
        ...Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, "internal"])),
        appId: "com.android.settings",
        _oneUnderscore: "keep",
        platform: "ios",
        deviceId: "explicit-device",
        device: "A",
        sessionUuid: "saved-session",
        __mcpRequestTimeoutMs: 120000,
        __mcpRequestDeadlineMs: 1790948577851,
        __lockNamespace: "stale-namespace",
        __internalNoDiff: false,
        __foo: "reserved",
      };
      const plan: Plan = { name: "old-export", steps: [{ tool: toolName, params }] };
      const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
        plan,
        0,
        "android",
        "fallback-device",
        injectSession ? "current-session" : undefined,
      );
      expect(result.success).toBe(true);
      expect(captured).toEqual([
        {
          appId: "com.android.settings",
          _oneUnderscore: "keep",
          platform: "ios",
          deviceId: "explicit-device",
          device: "A",
          sessionUuid: injectSession ? "current-session" : "saved-session",
          ...(requiresDevice && injectSession ? { __lockNamespace: "current-session" } : {}),
          __internalNoDiff: true,
        },
      ]);
      expect(params.__lockNamespace).toBe("stale-namespace");
      expect(params.__mcpRequestDeadlineMs).toBe(1790948577851);
    },
  );
});
