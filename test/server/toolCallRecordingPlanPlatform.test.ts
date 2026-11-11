import { recordPlanCall } from "../helpers/recordPlanCall";
import { expect, describe, test, beforeEach } from "bun:test";
import * as yaml from "js-yaml";
import {
  startToolCallRecording,
  stopToolCallRecording,
  getToolCallRecorder,
  resetToolCallRecordingState,
  resolveRecordedPlanPlatform,
} from "../../src/daemon/toolCallRecordingManager";
import { withResolvedPlatform } from "../../src/features/record/ToolCallRecorder";
import { FakeTimer } from "../fakes/FakeTimer";

// Verbatim `planContent` from recordToolCalls action=end in #17938 (iOS calls, no platform).
const ISSUE_17938_PLAN = `name: mcp-recorded-plan-2026-11-11T14-37-55-459Z
steps:
  - tool: tapOn
    params:
      selector:
        text: Add
  - tool: tapOn
    params:
      selector:
        text: Title
mcpVersion: 0.0.92
metadata:
  createdAt: '2026-11-11T14:37:55.459Z'
  version: 1.0.0
  generatedFromToolCalls: true
`;

const RECORDED_AT_MS = Date.parse("2026-11-11T14:37:55.459Z");

/** The parsed plan without the fields that depend on the build or the session length. */
function comparable(planContent: string): Record<string, unknown> {
  const plan = { ...(yaml.load(planContent) as Record<string, unknown>) };
  const metadata = { ...(plan.metadata as Record<string, unknown>) };
  delete metadata.recording;
  delete plan.mcpVersion;
  return { ...plan, metadata };
}

function recordIssueCalls(platforms: [string | undefined, string | undefined]) {
  const timer = new FakeTimer();
  timer.setCurrentTime(RECORDED_AT_MS);
  startToolCallRecording({ timer });
  const recorder = getToolCallRecorder()!;
  const [first, second] = platforms;
  recordPlanCall(recorder, "tapOn", {
    selector: { text: "Add" },
    deviceId: "SIM-UDID",
    ...(first && { platform: first }),
  });
  recordPlanCall(recorder, "tapOn", {
    selector: { text: "Title" },
    deviceId: "SIM-UDID",
    ...(second && { platform: second }),
  });
  return stopToolCallRecording({ timer });
}

describe("recorded plan platform (#17938)", () => {
  beforeEach(() => {
    resetToolCallRecordingState();
  });

  test("writes the one platform every call targeted at the top of the issue's plan", () => {
    const result = recordIssueCalls(["ios", "ios"]);

    expect(comparable(result.planContent)).toEqual({
      ...comparable(ISSUE_17938_PLAN),
      platform: "ios",
    });
    expect(result.planContent.startsWith(`name: ${result.planName}\nplatform: ios\nsteps:\n`)).toBe(
      true,
    );
    expect(result.platform).toBe("ios");
    expect(result.platformNote).toBeUndefined();
  });

  test("keeps platform out of every step's params", () => {
    const result = recordIssueCalls(["ios", "ios"]);
    const plan = yaml.load(result.planContent) as { steps: { params: object }[] };

    expect(plan.steps.map((step) => step.params)).toEqual([
      { selector: { text: "Add" } },
      { selector: { text: "Title" } },
    ]);
  });

  test("mixed platforms keep today's plan and say why in the result", () => {
    const result = recordIssueCalls(["ios", "android"]);

    expect(comparable(result.planContent)).toEqual(comparable(ISSUE_17938_PLAN));
    expect(result.platform).toBeUndefined();
    expect(result.platformNote).toContain("more than one platform (ios, android)");
  });

  test("an unknown platform keeps today's plan and says why in the result", () => {
    const result = recordIssueCalls(["ios", undefined]);

    expect(comparable(result.planContent)).toEqual(comparable(ISSUE_17938_PLAN));
    expect(result.platform).toBeUndefined();
    expect(result.platformNote).toContain("1 of 2 recorded call(s) had no known platform");
  });

  test("a platform the plan schema does not accept is left out with the reason", () => {
    expect(resolveRecordedPlanPlatform(["fuchsia"])).toEqual({
      platformNote: expect.stringContaining("fuchsia is not a plan platform"),
    });
    expect(resolveRecordedPlanPlatform(["tvos"])).toEqual({ platform: "tvos" });
  });

  test("preserves watchOS as a recorded plan platform (#18051)", () => {
    expect(resolveRecordedPlanPlatform(["watchos", "watchos"])).toEqual({ platform: "watchos" });
  });

  test("preserves visionOS as a recorded plan platform", () => {
    expect(resolveRecordedPlanPlatform(["visionos", "visionos"])).toEqual({ platform: "visionos" });
  });

  test("the resolved device's platform overrides the call's args", () => {
    expect(withResolvedPlatform({ deviceId: "SIM-UDID" }, { platform: "ios" })).toEqual({
      deviceId: "SIM-UDID",
      platform: "ios",
    });
    const args = { deviceId: "SIM-UDID" };
    expect(withResolvedPlatform(args, undefined)).toBe(args);
  });
});
