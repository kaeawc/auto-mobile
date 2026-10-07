import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { Plan } from "../../src/models/Plan";
import { getPreferenceSchema } from "../../src/server/preferenceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

// #10023: executePlan takes a single `platform`, but a plan may declare devices on both
// platforms. Each label's steps must be parsed and run with that label's own platform.

const recordTool = "mixedPlatformRecord";
const prefTool = "mixedPlatformGetPreference";

interface Seen {
  device: string | undefined;
  platform: string | undefined;
}

const markDevice = (name: string) => {
  (ToolRegistry.getTool(name) as { requiresDevice: boolean }).requiresDevice = true;
};

const mixedDevices: Plan["devices"] = [
  { label: "A", platform: "android" },
  { label: "B", platform: "ios" },
];

describe("PlanExecutor per-label platform injection (#10023)", () => {
  let executor: DefaultPlanExecutor;
  let seen: Seen[];

  beforeEach(() => {
    executor = new DefaultPlanExecutor(new FakeTimer());
    seen = [];
    ToolRegistry.register(
      recordTool,
      "Record the parsed device and platform",
      z.object({ device: z.string().optional(), platform: z.string().optional() }),
      async (params) => {
        seen.push({ device: params.device, platform: params.platform });
        return { success: true };
      },
    );
    markDevice(recordTool);
    ToolRegistry.register(
      prefTool,
      "getPreference schema without a device",
      getPreferenceSchema,
      async (params) => {
        seen.push({ device: params.device, platform: params.platform });
        return { success: true };
      },
    );
    markDevice(prefTool);
  });

  afterEach(() => {
    ToolRegistry.unregister(recordTool);
    ToolRegistry.unregister(prefTool);
  });

  const platformOf = (device: string) => seen.find((entry) => entry.device === device)?.platform;

  test("each label's step gets that label's declared platform, not the request platform", async () => {
    const plan: Plan = {
      name: "mixed",
      devices: mixedDevices,
      steps: [
        { tool: recordTool, params: { device: "A" } },
        { tool: recordTool, params: { device: "B" } },
      ],
    };

    const result = await executor.executePlan(plan, 0, "android");

    expect(result.success).toBe(true);
    expect(platformOf("A")).toBe("android");
    expect(platformOf("B")).toBe("ios");
  });

  test("the iOS label's userDefaults getPreference parses under an android request platform", async () => {
    const plan: Plan = {
      name: "mixed-pref",
      devices: mixedDevices,
      steps: [
        {
          tool: prefTool,
          params: { device: "B", scope: "userDefaults", appId: "com.example.app", key: "seen" },
        },
        {
          tool: prefTool,
          params: { device: "A", scope: "sharedPreferences", appId: "com.example.app", key: "k" },
        },
      ],
    };

    const result = await executor.executePlan(plan, 0, "android");

    expect(result.success).toBe(true);
    expect(platformOf("B")).toBe("ios");
    expect(platformOf("A")).toBe("android");
  });

  test("the android label's sharedPreferences step parses under an ios request platform", async () => {
    const plan: Plan = {
      name: "mixed-pref-ios-request",
      devices: mixedDevices,
      steps: [
        {
          tool: prefTool,
          params: { device: "A", scope: "sharedPreferences", appId: "com.example.app", key: "k" },
        },
      ],
    };

    const result = await executor.executePlan(plan, 0, "ios");

    expect(result.success).toBe(true);
    expect(platformOf("A")).toBe("android");
  });

  test("an explicit platform in a step's own params wins over the label's platform", async () => {
    const plan: Plan = {
      name: "explicit",
      devices: mixedDevices,
      steps: [{ tool: recordTool, params: { device: "B", platform: "android" } }],
    };

    const result = await executor.executePlan(plan, 0, "android");

    expect(result.success).toBe(true);
    expect(platformOf("B")).toBe("android");
  });

  test("label-only devices fall back to the request platform", async () => {
    const plan: Plan = {
      name: "labels-only",
      devices: ["A", "B"],
      steps: [
        { tool: recordTool, params: { device: "A" } },
        { tool: recordTool, params: { device: "B" } },
      ],
    };

    const result = await executor.executePlan(plan, 0, "ios");

    expect(result.success).toBe(true);
    expect(platformOf("A")).toBe("ios");
    expect(platformOf("B")).toBe("ios");
  });

  test("a single-device plan keeps injecting the request platform", async () => {
    const plan: Plan = { name: "single", steps: [{ tool: recordTool, params: {} }] };

    const result = await executor.executePlan(plan, 0, "ios");

    expect(result.success).toBe(true);
    expect(seen[0]?.platform).toBe("ios");
  });
});
