import { afterEach, describe, expect, test } from "bun:test";
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
