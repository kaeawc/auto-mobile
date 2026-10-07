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
  resetTapOnElementFactory,
  setTapOnElementFactory,
} from "../../src/server/interactionTools";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../../src/utils/toolUtils";
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
      start.mockRestore();
      finalize.mockRestore();
    };
  });

  afterEach(() => {
    restoreHandler();
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
});
