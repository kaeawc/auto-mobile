import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as yaml from "js-yaml";
import { ResetKeychain } from "../../../src/features/action/ResetKeychain";
import {
  MAX_RECORDED_PARAM_BYTES,
  McpCallRecorder,
} from "../../../src/features/record/McpCallRecorder";
import type { BootedDevice, Plan } from "../../../src/models";
import { resetKeychainSchema } from "../../../src/server/appTools";
import {
  getMcpRecorder,
  resetMcpRecordingState,
  startMcpRecording,
  stopMcpRecording,
} from "../../../src/server/mcpRecordingManager";
import { createJSONToolResponse } from "../../../src/utils/toolUtils";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../../src/utils/plan/PlanExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";

const SIMULATOR: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

afterEach(() => {
  ToolRegistry.clearTools();
  resetMcpRecordingState();
});

/**
 * Registers resetKeychain with its real input schema and the same
 * explicit-target rule as the real handler (deviceId, device or sessionUuid),
 * but over a fake simctl so nothing leaves the process. The tool is marked as
 * device-bound so PlanExecutor re-injects the session exactly as it does for the
 * real tool.
 */
function registerResetKeychain(simctl: FakeSimCtlClient): void {
  ToolRegistry.register(
    "resetKeychain",
    "Fake resetKeychain over a fake simctl",
    resetKeychainSchema,
    async (args: { appId: string; confirm: boolean; deviceId?: string; sessionUuid?: string }) => {
      const result = await new ResetKeychain(SIMULATOR, simctl).execute({
        appId: args.appId,
        confirm: args.confirm,
        explicitlyTargeted: Boolean(args.deviceId || args.sessionUuid),
      });
      return createJSONToolResponse({ ...result });
    },
    { defaultEnabled: true },
  );
  const tool = ToolRegistry.getTool("resetKeychain");
  expect(tool).toBeDefined();
  Object.assign(tool!, { requiresDevice: true });
}

function recordResetKeychain(): Plan {
  const timer = new FakeTimer();
  startMcpRecording({ timer });
  getMcpRecorder()!.record("resetKeychain", {
    appId: "com.example.app",
    confirm: true,
    deviceId: SIMULATOR.deviceId,
    sessionUuid: "recording-session",
    platform: "ios",
  });
  return yaml.load(stopMcpRecording({ timer }).planContent) as Plan;
}

describe("resetKeychain replay of a recorded plan (#10052)", () => {
  test("the recorded step stops at the tool's own confirmation refusal and wipes nothing", async () => {
    const simctl = new FakeSimCtlClient();
    registerResetKeychain(simctl);
    const plan = recordResetKeychain();

    expect(plan.steps).toEqual([
      { tool: "resetKeychain", params: { appId: "com.example.app", confirm: false } },
    ]);

    const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
      plan,
      0,
      "ios",
      SIMULATOR.deviceId,
      "replay-session",
    );

    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(0);
    expect(result.failedStep?.tool).toBe("resetKeychain");
    expect(result.failedStep?.error).toContain("Set confirm: true to proceed");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("once the author sets confirm: true by hand the replay runs the reset", async () => {
    const simctl = new FakeSimCtlClient();
    registerResetKeychain(simctl);
    const plan = recordResetKeychain();
    plan.steps[0].params!.confirm = true;

    const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
      plan,
      0,
      "ios",
      SIMULATOR.deviceId,
      "replay-session",
    );

    expect(result.success).toBe(true);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      { args: ["keychain", SIMULATOR.deviceId, "reset"], timeoutMs: undefined },
    ]);
  });

  test("the export tells the user the confirmation was withheld", () => {
    const timer = new FakeTimer();
    startMcpRecording({ timer });
    getMcpRecorder()!.record("resetKeychain", { appId: "com.example.app", confirm: true });
    const result = stopMcpRecording({ timer });

    expect(result.warnings).toEqual([
      "resetKeychain was recorded with its destructive confirmation set to false: a replay stops at this step until you set confirm: true in the plan by hand",
    ]);
  });
});

describe("recording export warnings (#10052)", () => {
  test("a skipped sourcePath call is named with the reason and its position", () => {
    const timer = new FakeTimer();
    startMcpRecording({ timer });
    const recorder = getMcpRecorder()!;
    recorder.record("launchApp", { appId: "com.example.app" });
    recorder.record("putAppFile", {
      target: { domain: "media_library" },
      files: [{ destinationPath: "pic.png", sourcePath: "/Users/dev/pic.png" }],
    });
    const result = stopMcpRecording({ timer });

    expect(result.stepCount).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toStartWith(
      "putAppFile was not recorded (after 1 recorded steps): ",
    );
    expect(result.warnings[0]).toContain("copies a host file (sourcePath)");
  });

  test("a recording with no skipped calls has an empty warnings list", () => {
    const timer = new FakeTimer();
    startMcpRecording({ timer });
    getMcpRecorder()!.record("launchApp", { appId: "com.example.app" });
    expect(stopMcpRecording({ timer }).warnings).toEqual([]);
  });

  test("an all-skipped recording reports the skipped calls instead of the generic error", () => {
    const timer = new FakeTimer();
    startMcpRecording({ timer });
    getMcpRecorder()!.record("stageSessionDownloads", {
      directory: "fixtures",
      files: [{ destinationPath: "a.txt", sourcePath: "/tmp/a.txt" }],
    });

    expect(() => stopMcpRecording({ timer })).toThrow(
      /No MCP tool calls were recorded\. 1 call\(s\) were skipped: stageSessionDownloads was not recorded .*sourcePath/,
    );
  });

  test("an empty recording keeps the generic hint", () => {
    startMcpRecording({ timer: new FakeTimer() });
    expect(() => stopMcpRecording({ timer: new FakeTimer() })).toThrow(
      "Ensure plan-relevant tools were called during the recording.",
    );
  });
});

describe("recorded param size cap (#10052)", () => {
  test("a param over the cap is skipped with a warning that names the param", () => {
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("putAppFile", {
      target: { domain: "app_containers", appId: "com.example", container: "documents" },
      files: [
        { destinationPath: "big.bin", contentBase64: "A".repeat(MAX_RECORDED_PARAM_BYTES + 1) },
      ],
    });
    const { steps, warnings } = recorder.stopWithWarnings();

    expect(steps).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("putAppFile was not recorded");
    expect(warnings[0]).toContain(`param 'files' is larger than ${MAX_RECORDED_PARAM_BYTES} bytes`);
  });

  test("a param just under the cap is still recorded", () => {
    const recorder = new McpCallRecorder();
    recorder.start();
    recorder.record("sendKeys", { text: "A".repeat(MAX_RECORDED_PARAM_BYTES - 10) });
    const { steps, warnings } = recorder.stopWithWarnings();

    expect(steps).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

test.each([
  { x: 2, y: 3 },
  { x: 0.25, y: 0.5, coordinateSpace: "normalized" },
  { x: 20, y: 30, image: "reference.png", action: "longPress", durationMs: 800 },
])("missing tapAt geometry preserves legacy params %p and warns", (params) => {
  const recorder = new McpCallRecorder();
  const warning = spyOn(logger, "warn");
  try {
    recorder.start();
    recorder.record("tapAt", {
      ...params,
      sessionUuid: "recording-session",
      snapshotId: "ephemeral",
      __tapAtRecordingContext: {},
    });
    const { steps, warnings } = recorder.stopWithWarnings();
    expect(steps).toEqual([{ tool: "tapAt", params }]);
    expect(steps[0]).not.toHaveProperty("geometry");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tapAt was recorded without geometry");
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("native geometry provenance is unavailable"),
    );
  } finally {
    warning.mockRestore();
  }
});

// The interaction tools module graph is large; load it once outside the timed test (the 100 ms
// unit budget excludes beforeAll), so a cold import on a loaded runner can't breach the budget.
let interactionTools: typeof import("../../../src/server/interactionTools");
let tapAtCoordinate: typeof import("../../helpers/tapAtCoordinate");
beforeAll(async () => {
  interactionTools = await import("../../../src/server/interactionTools");
  tapAtCoordinate = await import("../../helpers/tapAtCoordinate");
});

test("executor passes step geometry through the real tapAt handler", async () => {
  const { tapAtHandler, tapAtSchema, setTapAtElementFactory, resetTapAtElementFactory } =
    interactionTools;
  const { createTapAt } = tapAtCoordinate;
  const fake = createTapAt(SIMULATOR);
  setTapAtElementFactory(() => fake.tapAt);
  try {
    ToolRegistry.register(
      "tapAt",
      "fake native tap",
      tapAtSchema,
      (args, progress, signal) => tapAtHandler(SIMULATOR, args, progress, signal),
      { defaultEnabled: true },
    );
    const geometry = {
      platform: "ios" as const,
      deviceWidth: 10,
      deviceHeight: 10,
      orientation: 0,
      x: 2.125,
      y: 3.75,
    };
    const executor = new DefaultPlanExecutor(new FakeTimer());
    const step = { tool: "tapAt", params: { x: geometry.x, y: geometry.y }, geometry };
    const compatible = await executor.executePlan(
      { name: "native", steps: [step] },
      0,
      "ios",
      SIMULATOR.deviceId,
      "replay",
    );
    expect(compatible.success).toBe(true);
    expect(fake.iosDispatches).toHaveLength(1);
    const incompatible = await executor.executePlan(
      { name: "native", steps: [{ ...step, geometry: { ...geometry, orientation: 2 } }] },
      0,
      "ios",
      SIMULATOR.deviceId,
      "replay",
    );
    expect(incompatible.success).toBe(false);
    expect(incompatible.failedStep?.error).toContain("orientation mismatch");
    expect(fake.iosDispatches).toHaveLength(1);
  } finally {
    resetTapAtElementFactory();
  }
});
