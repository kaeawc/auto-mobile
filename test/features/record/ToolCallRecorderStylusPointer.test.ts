import { recordPlanCall } from "../../helpers/recordPlanCall";
import type { ToolCallRecordingContext } from "../../../src/features/toolSelection/toolSelectionContext";
import { describe, expect, test } from "bun:test";
import { ToolCallRecorder } from "../../../src/features/record/ToolCallRecorder";

function record(tool: string, args: Record<string, unknown>, recording?: ToolCallRecordingContext) {
  const recorder = new ToolCallRecorder();
  recorder.start();
  recordPlanCall(recorder, tool, args, {}, recording);
  return recorder.stopWithWarnings();
}

describe("recorded stylus pointer (#13081)", () => {
  test("a tapAt step keeps its pointer so a replay is never silently a finger", () => {
    const { steps } = record("tapAt", {
      x: 12,
      y: 34,
      pointer: { toolType: "stylus", pressure: 1 },
    });

    expect(steps).toEqual([
      { tool: "tapAt", params: { x: 12, y: 34, pointer: { toolType: "stylus", pressure: 1 } } },
    ]);
  });

  test("a swipeAt step keeps its pointer", () => {
    const { steps } = record(
      "swipeAt",
      {
        from: { x: 0.1, y: 0.2 },
        to: { x: 0.3, y: 0.4 },
        coordinateSpace: "normalized",
        pointer: { toolType: "stylus" },
      },
      { swipeAt: { screenSize: { width: 1080, height: 2400 } } },
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]?.params).toMatchObject({ pointer: { toolType: "stylus" } });
  });
});
