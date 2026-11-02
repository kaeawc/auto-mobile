import type { PlanStep } from "../../../models";
import type { GestureEvent } from "./types";
import { hasUnknownAxes } from "./gesturePairing";

export function buildPenSampleStep(gesture: GestureEvent): PlanStep | null {
  const samples = gesture.type === "stroke" ? gesture.path : gesture.hover;
  if (
    gesture.toolType !== "stylus" ||
    hasUnknownAxes(gesture) ||
    !samples?.length ||
    (gesture.type === "stroke" && samples.length < 2)
  ) {
    return null;
  }
  const points = samples.map((sample, index) => {
    const { arrivedAt, ...point } = sample;
    return {
      ...point,
      ...(index > 0
        ? {
            durationMs: Math.min(
              5000,
              Math.max(1, Math.round(arrivedAt - samples[index - 1].arrivedAt)),
            ),
          }
        : {}),
    };
  });
  return {
    tool: gesture.type === "stroke" ? "dragPath" : "hoverAt",
    params: {
      points,
      ...(gesture.type === "hover" ? { toolType: "stylus" } : { pointer: { toolType: "stylus" } }),
    },
  };
}
