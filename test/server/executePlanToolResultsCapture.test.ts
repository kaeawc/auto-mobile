import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BootedDevice } from "../../src/models";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import {
  PlanExecutionOrchestrator,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import {
  registerInteractionTools,
  resetSetPostureFactory,
  resetTapOnElementFactory,
  setSetPostureFactory,
  setTapOnElementFactory,
} from "../../src/server/interactionTools";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../../src/utils/toolUtils";
import { z } from "zod/v4";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

// #10090: the JUnit runner's getSelection/getToolResult/getTypedResponse read per-step results out
// of the `executePlan` response. This drives the real PlanExecutionOrchestrator and PlanExecutor
// with the real tapOn tool handler and finalizer (only the device-bound TapOnElement is faked) and
// pins the exact MCP envelope the runner receives to a checked-in capture, which the Kotlin
// AutoMobilePlanExecutorTest parses. Regenerate with UPDATE_CAPTURED_FIXTURES=1.

const CAPTURED_DIR = path.join(
  import.meta.dir,
  "../../android/junit-runner/src/test/resources/captured",
);
const FIXTURE = path.join(CAPTURED_DIR, "execute-plan-tool-results.json");
// A plan whose third step fails, so the runner's recovery context is built from a real failure.
const FAILED_FIXTURE = path.join(CAPTURED_DIR, "execute-plan-failed-step.json");
// A plan whose second step is a nested `executePlan` that fails (#10172), and one whose second step
// is a `setPosture` that answers `status: "unsupported"` (#10175). The JUnit runner's
// PlanFailureShapesCaptureTest parses both.
const NESTED_FAILED_FIXTURE = path.join(CAPTURED_DIR, "execute-plan-nested-failed-step.json");
const UNSUPPORTED_FIXTURE = path.join(CAPTURED_DIR, "execute-plan-unsupported-step.json");
const UNSUPPORTED_MESSAGE =
  "Setting a hinge angle needs the Android emulator console; physical Android devices are unsupported. Nothing was changed.";

const device: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "Fake" };

const PLAN = `name: pick-random-item
steps:
  - tool: tapOn
    params:
      action: tap
      selector:
        text: Item
      selectionStrategy: random
  - tool: tapOn
    optional: true
    params:
      action: tap
      selector:
        text: Dismiss
  - tool: tapOn
    params:
      action: tap
      selector:
        text: Confirm
`;

const FAILING_PLAN = `name: tap-missing-item
steps:
  - tool: tapOn
    params:
      action: tap
      selector:
        text: Item
  - tool: tapOn
    optional: true
    params:
      action: tap
      selector:
        text: Dismiss
  - tool: tapOn
    params:
      action: tap
      selector:
        text: Missing
`;

const TAP_THEN_UNSUPPORTED_POSTURE_PLAN = `name: tap-then-fold
steps:
  - tool: tapOn
    params:
      action: tap
      selector:
        text: Item
  - tool: setPosture
    params:
      hingeAngle: 90
  - tool: tapOn
    params:
      action: tap
      selector:
        text: Confirm
`;

// The nested plan is carried as a YAML block scalar by the outer step.
const OUTER_PLAN_WITH_NESTED_PLAN = `name: outer-with-shared-login
steps:
  - tool: tapOn
    params:
      action: tap
      selector:
        text: Item
  - tool: executePlan
    params:
      platform: android
      planContent: |
        name: shared-login
        steps:
          - tool: tapOn
            params:
              action: tap
              selector:
                text: Missing
  - tool: tapOn
    params:
      action: tap
      selector:
        text: Confirm
`;

function selectedElement(text: string, totalMatches: number, strategy: string) {
  return {
    text,
    resourceId: "com.example:id/item",
    bounds: { left: 0, top: 200, right: 1080, bottom: 320, centerX: 540, centerY: 260 },
    indexInMatches: 6,
    totalMatches,
    selectionStrategy: strategy,
  };
}

describe("executePlan toolResults capture (#10090)", () => {
  let restoreSuiteTools: () => void;
  let restoreTools: () => void;
  let restoreHandler: () => void;

  beforeAll(() => {
    restoreSuiteTools = preserveToolRegistry();
    registerInteractionTools();
  });
  afterAll(() => restoreSuiteTools());

  beforeEach(() => {
    restoreTools = preserveToolRegistry();
    setTapOnElementFactory(() => ({
      execute: async (params) => {
        const label = params.selector?.text ?? params.text;
        if (label === "Dismiss" || label === "Missing") {
          return {
            success: false,
            action: "tap",
            element: { text: "" },
            error: "Element not found",
          };
        }
        const strategy = params.selectionStrategy ?? "first";
        return {
          success: true,
          action: "tap",
          element: { text: label, bounds: { left: 0, top: 200, right: 1080, bottom: 320 } },
          selectedElement: selectedElement(label === "Item" ? "Row 7" : "Confirm", 12, strategy),
        };
      },
    }));
    const tap = ToolRegistry.getToolForPlan("tapOn")!;
    const handler = spyOn(tap, "handler").mockImplementation(async (params, progress, signal) =>
      finalizeToolResponse(await tap.deviceAwareHandler!(device, params, progress, signal), {
        name: tap.name,
        internal: true,
      }),
    );
    // The real setPosture wrapper over a fake action that refuses, as on a physical device.
    setSetPostureFactory(() => ({
      execute: async () => ({ status: "unsupported" as const, message: UNSUPPORTED_MESSAGE }),
      executeHingeAngle: async () => ({
        status: "unsupported" as const,
        message: UNSUPPORTED_MESSAGE,
      }),
    }));
    const posture = ToolRegistry.getToolForPlan("setPosture")!;
    const postureHandler = spyOn(posture, "handler").mockImplementation(
      async (params, progress, signal) =>
        finalizeToolResponse(await posture.deviceAwareHandler!(device, params, progress, signal), {
          name: posture.name,
          internal: true,
        }),
    );
    // The plan declares no video, but the auto-video session would otherwise resolve the real DB.
    const start = spyOn(
      AndroidSegmentedPlanVideoSession.prototype,
      "startFirstSegment",
    ).mockResolvedValue(undefined);
    const finalize = spyOn(
      AndroidSegmentedPlanVideoSession.prototype,
      "finalize",
    ).mockResolvedValue({ filePaths: [], recordingIds: [], metadata: [] });
    restoreHandler = () => {
      handler.mockRestore();
      postureHandler.mockRestore();
      start.mockRestore();
      finalize.mockRestore();
    };
  });

  afterEach(() => {
    restoreHandler();
    resetSetPostureFactory();
    resetTapOnElementFactory();
    restoreTools();
  });

  async function runOrchestrator(planContent: string = PLAN) {
    const videoRecorder: VideoRecorder = {
      startVideoRecording: async () => {
        throw new Error("unexpected video start");
      },
      stopVideoRecording: async () => {
        throw new Error("unexpected video stop");
      },
    };
    return new PlanExecutionOrchestrator(
      {
        device,
        request: {
          platform: "android",
          planContent,
          startStep: 0,
          deviceAllocationTimeoutMs: 5000,
        },
      },
      {
        timer: new FakeTimer(),
        videoRecorder,
        createSchemaValidator: () => ({
          loadSchema: async () => undefined,
          validateYaml: () => ({ valid: true }),
        }),
      },
    ).execute();
  }

  test("the response carries each executed step's payload and matches the checked-in capture", async () => {
    const result = await runOrchestrator();

    expect(result.success).toBe(true);
    expect(result.skippedSteps?.map((step) => step.stepIndex)).toEqual([1]);
    expect(result.toolResults?.map((entry) => entry.stepIndex)).toEqual([0, 2]);
    expect(result.toolResults?.[0]).toMatchObject({
      tool: "tapOn",
      result: { selectedElement: { text: "Row 7", selectionStrategy: "random" } },
    });

    const envelope = withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    const captured = `${JSON.stringify(envelope, null, 2)}\n`;
    if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
      writeFileSync(FIXTURE, captured);
    }
    expect(captured).toBe(readFileSync(FIXTURE, "utf8"));
  });

  test("a failed plan reports the device it ran on, the failed step and the earlier steps by index (recovery context)", async () => {
    const result = await runOrchestrator(FAILING_PLAN);

    expect(result.success).toBe(false);
    expect(result.failedStep).toMatchObject({ stepIndex: 2, tool: "tapOn" });
    expect(result.failedStep?.device).toBeUndefined();
    expect(result.deviceId).toBe("emulator-5554");
    expect(result.toolResults?.map((entry) => entry.stepIndex)).toEqual([0]);
    expect(result.skippedSteps?.map((step) => step.stepIndex)).toEqual([1]);

    const envelope = withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    const captured = `${JSON.stringify(envelope, null, 2)}\n`;
    if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
      writeFileSync(FAILED_FIXTURE, captured);
    }
    expect(captured).toBe(readFileSync(FAILED_FIXTURE, "utf8"));
  });

  test("a setPosture step that answers unsupported fails the plan with the tool's own text (#10175)", async () => {
    const result = await runOrchestrator(TAP_THEN_UNSUPPORTED_POSTURE_PLAN);

    expect(result.success).toBe(false);
    expect(result.failedStep).toEqual({
      stepIndex: 1,
      tool: "setPosture",
      error: UNSUPPORTED_MESSAGE,
    });
    expect(result.toolResults?.map((entry) => entry.stepIndex)).toEqual([0]);

    const envelope = withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    const captured = `${JSON.stringify(envelope, null, 2)}\n`;
    if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
      writeFileSync(UNSUPPORTED_FIXTURE, captured);
    }
    expect(captured).toBe(readFileSync(UNSUPPORTED_FIXTURE, "utf8"));
  });

  test("a failing nested executePlan step is the outer plan's failed step, in the same envelope (#10172)", async () => {
    // Stand-in for the executePlan tool body: the real orchestrator and executor over the nested
    // plan, wrapped exactly as executePlanTool wraps its result.
    ToolRegistry.register(
      "executePlan",
      "executePlan stand-in running the real orchestrator for the nested plan",
      z.object({}).passthrough(),
      async (args) => {
        const inner = await runOrchestrator(String(args.planContent));
        return withIsErrorOnFailure(createStructuredToolResponse(inner), inner.success);
      },
    );

    const result = await runOrchestrator(OUTER_PLAN_WITH_NESTED_PLAN);

    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(1);
    expect(result.failedStep).toMatchObject({ stepIndex: 1, tool: "executePlan" });
    expect(result.failedStep?.error).toContain("Element not found");
    // Only the completed step is reported; the failed nested step carries its failure in failedStep.
    expect(result.toolResults?.map((entry) => entry.stepIndex)).toEqual([0]);

    const envelope = withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    const captured = `${JSON.stringify(envelope, null, 2)}\n`;
    if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
      writeFileSync(NESTED_FAILED_FIXTURE, captured);
    }
    expect(captured).toBe(readFileSync(NESTED_FAILED_FIXTURE, "utf8"));
  });
});
