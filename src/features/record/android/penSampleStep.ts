import type { PlanStep } from "../../../models";
import type { GestureEvent, PenSample, HoverSample } from "./types";
import { pointerOf } from "./types";
import { hasUnknownAxes } from "./gesturePairing";
import {
  DRAG_PATH_SEGMENT_MIN_MS,
  DRAG_PATH_SEGMENT_MAX_MS,
  DRAG_PATH_MAX_TOTAL_MS,
  DRAG_PATH_MAX_POINTS,
} from "../../action/dragPathPlan";

function sampleDeltaMs(
  sample: Pick<PenSample, "arrivedAt" | "kernelAtMs">,
  previous: Pick<PenSample, "arrivedAt" | "kernelAtMs">,
): number {
  // GetEventReader retains the node's getevent clock through compaction and classification.
  // Host arrival is only a fallback for samples without kernel stamps, not stdout batching.
  return sample.kernelAtMs !== undefined && previous.kernelAtMs !== undefined
    ? sample.kernelAtMs - previous.kernelAtMs
    : sample.arrivedAt - previous.arrivedAt;
}

/** Check elapsed device time before rounding, splitting or enforcing replay's segment bounds. */
export function penStrokeExceedsReplayLimit(gesture: GestureEvent): boolean {
  const samples = gesture.type === "stroke" ? gesture.path : gesture.hover;
  if (
    (gesture.type !== "stroke" && gesture.type !== "hover") ||
    gesture.toolType !== "stylus" ||
    hasUnknownAxes(gesture) ||
    !samples ||
    samples.length < 2
  ) {
    return false;
  }
  const totalMs = samples.reduce(
    (total, sample, index) => total + (index > 0 ? sampleDeltaMs(sample, samples[index - 1]) : 0),
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
  const points = sampledPoints(samples);
  return {
    tool: gesture.type === "stroke" ? "dragPath" : "hoverAt",
    params: {
      points,
      ...(gesture.type === "hover" ? { toolType: "stylus" } : { pointer: pointerOf(gesture) }),
    },
  };
}

interface SamplePoint {
  x: number;
  y: number;
  pressure?: number;
  distance?: number;
  durationMs?: number;
}

/** Split the existing linear replay segment, including its pressure/distance curve. */
function splitSegment(from: SamplePoint, to: SamplePoint, durationMs: number): SamplePoint[] {
  const count = Math.ceil(durationMs / DRAG_PATH_SEGMENT_MAX_MS);
  return Array.from({ length: count }, (_, index) => {
    const fraction = (index + 1) / count;
    const point = {
      ...to,
      x: from.x + (to.x - from.x) * fraction,
      y: from.y + (to.y - from.y) * fraction,
      durationMs: Math.round(durationMs * fraction) - Math.round((durationMs * index) / count),
    };
    for (const field of ["pressure", "distance"] as const) {
      if (from[field] !== undefined && to[field] !== undefined) {
        point[field] = from[field] + (to[field] - from[field]) * fraction;
      }
    }
    // Keep the exact endpoint rather than a floating-point interpolation of it.
    return index === count - 1 ? { ...to, durationMs: point.durationMs } : point;
  });
}

/**
 * Splitting may add up to three vertices to a <=20 s path. If that crosses the point cap,
 * merge the shortest adjacent segments, preserving elapsed time, endpoints and pen extrema.
 * With >100 points in <=20 s, the shortest join is necessarily below the 5 s segment cap.
 */
function fitPointBudget(points: SamplePoint[]): void {
  while (points.length > DRAG_PATH_MAX_POINTS) {
    const value = (point: SamplePoint) => point.pressure ?? point.distance ?? 0;
    const minimum = points.reduce(
      (best, point, i) => (value(point) < value(points[best]) ? i : best),
      0,
    );
    const maximum = points.reduce(
      (best, point, i) => (value(point) > value(points[best]) ? i : best),
      0,
    );
    let shortest = Infinity;
    let remove = 1;
    for (let i = 1; i < points.length - 1; i++) {
      const joined = points[i].durationMs! + points[i + 1].durationMs!;
      if (i !== minimum && i !== maximum && joined < shortest) {
        shortest = joined;
        remove = i;
      }
    }
    points[remove + 1].durationMs = shortest;
    points.splice(remove, 1);
  }
}

function sampledPoints(samples: ReadonlyArray<PenSample | HoverSample>): SamplePoint[] {
  const points: SamplePoint[] = [];
  let elapsedMs = 0;
  let exportedMs = 0;
  for (const [index, sample] of samples.entries()) {
    const { arrivedAt, kernelAtMs, ...point } = sample;
    if (index === 0) {
      points.push(point);
      continue;
    }
    elapsedMs += Math.max(0, sampleDeltaMs({ arrivedAt, kernelAtMs }, samples[index - 1]));
    const offsetMs = Math.round(elapsedMs);
    const durationMs = offsetMs - exportedMs;
    if (durationMs < DRAG_PATH_SEGMENT_MIN_MS) {
      // Coalesce samples that round to the same millisecond; keep the final position.
      if (index !== samples.length - 1) {
        continue;
      }
      if (points.length === 1) {
        points.push({ ...point, durationMs: DRAG_PATH_SEGMENT_MIN_MS });
      } else {
        points[points.length - 1] = { ...point, durationMs: points.at(-1)!.durationMs };
      }
      continue;
    }
    points.push(...splitSegment(points.at(-1)!, point, durationMs));
    exportedMs = offsetMs;
  }
  fitPointBudget(points);
  return points;
}
