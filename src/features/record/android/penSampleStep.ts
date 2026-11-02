import type { PlanStep } from "../../../models";
import type { GestureEvent, PenSample } from "./types";
import { pointerOf } from "./types";
import { hasUnknownAxes } from "./gesturePairing";
import {
  DRAG_PATH_SEGMENT_MIN_MS,
  DRAG_PATH_SEGMENT_MAX_MS,
  DRAG_PATH_MAX_TOTAL_MS,
} from "../../action/dragPathPlan";

function segmentDurationMs(
  sample: Pick<PenSample, "arrivedAt" | "kernelAtMs">,
  previous: Pick<PenSample, "arrivedAt" | "kernelAtMs">,
): number {
  const delta =
    sample.kernelAtMs !== undefined && previous.kernelAtMs !== undefined
      ? sample.kernelAtMs - previous.kernelAtMs
      : sample.arrivedAt - previous.arrivedAt;
  return Math.min(DRAG_PATH_SEGMENT_MAX_MS, Math.max(DRAG_PATH_SEGMENT_MIN_MS, Math.round(delta)));
}

/** Whether an otherwise exportable stylus stroke's clamped segments exceed replay's budget. */
export function penStrokeExceedsReplayLimit(gesture: GestureEvent): boolean {
  const samples = gesture.path;
  if (
    gesture.type !== "stroke" ||
    gesture.toolType !== "stylus" ||
    hasUnknownAxes(gesture) ||
    !samples ||
    samples.length < 2
  ) {
    return false;
  }
  const totalMs = samples.reduce(
    (total, sample, index) =>
      total + (index > 0 ? segmentDurationMs(sample, samples[index - 1]) : 0),
    0,
  );
  return totalMs > DRAG_PATH_MAX_TOTAL_MS;
}

export function buildPenSampleStep(gesture: GestureEvent): PlanStep | null {
  const samples = gesture.type === "stroke" ? gesture.path : gesture.hover;
  if (
    gesture.toolType !== "stylus" ||
    hasUnknownAxes(gesture) ||
    !samples?.length ||
    (gesture.type === "stroke" && samples.length < 2) ||
    penStrokeExceedsReplayLimit(gesture)
  ) {
    return null;
  }
  const points = samples.map((sample, index) => {
    const { arrivedAt, kernelAtMs, ...point } = sample;
    return {
      ...point,
      ...(index > 0
        ? { durationMs: segmentDurationMs({ arrivedAt, kernelAtMs }, samples[index - 1]) }
        : {}),
    };
  });
  return {
    tool: gesture.type === "stroke" ? "dragPath" : "hoverAt",
    params: {
      points,
      ...(gesture.type === "hover" ? { toolType: "stylus" } : { pointer: pointerOf(gesture) }),
    },
  };
}
