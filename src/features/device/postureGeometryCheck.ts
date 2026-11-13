import type { ObserveResult } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { describeTransposedLayout } from "../observe/transposedLayoutGeometry";
import type { PostureOperation } from "./postureCommands";

/** How long a posture change waits for the runner's geometry to agree with `observe`. */
export const POSTURE_GEOMETRY_WAIT_MS = 10_000;

export const POSTURE_GEOMETRY_POLL_MS = 500;

type GeometryObservation = Pick<ObserveResult, "screenSize" | "rotation" | "viewHierarchy">;

const isRotation = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 3;

/**
 * Names a disagreement between the runner's own capture geometry and the observation built from
 * it: the runner's raw rotation is a different orientation from the observed one, or the
 * observation is portrait-reported with a landscape layout (#18245).
 */
export function describePostureGeometryMismatch(
  observation: GeometryObservation,
): string | undefined {
  const runner = observation.viewHierarchy?.rotation;
  const observed = observation.rotation;
  if (isRotation(runner) && isRotation(observed) && runner % 2 !== observed % 2) {
    const { width, height } = observation.screenSize;
    return `the runner reports rotation ${runner} but observe reports rotation ${observed} at ${width}x${height}`;
  }
  return describeTransposedLayout(observation);
}

export interface PostureGeometryCheck {
  timer: Timer;
  operation: PostureOperation;
  /** Ask the runner for a fresh capture so its cached gesture geometry is rebuilt. */
  refreshRunner(): Promise<unknown>;
  observe(): Promise<GeometryObservation>;
}

/**
 * Re-checks geometry after a posture change. Returns undefined when the final observation agrees
 * with the runner (immediately or after refreshes within {@link POSTURE_GEOMETRY_WAIT_MS}), else a
 * warning naming the mismatch. Never fails the posture change itself.
 */
export async function verifyPostureGeometry(
  initial: GeometryObservation | undefined,
  check: PostureGeometryCheck,
): Promise<string | undefined> {
  const { timer, operation } = check;
  let mismatch = initial ? describePostureGeometryMismatch(initial) : undefined;
  if (mismatch === undefined) {
    return undefined;
  }
  const startedAt = timer.now();
  while (true) {
    try {
      mismatch = await recheck(check);
    } catch (error) {
      operation.assertCurrent();
      throwIfAborted(operation.signal);
      logger.warn(`[SetPosture] Geometry re-check failed: ${errorMessage(error)}`, error);
      return `Could not re-check screen geometry after the posture change (${errorMessage(error)}); the last observation was inconsistent: ${mismatch}. Observe again before tapping.`;
    }
    const elapsed = timer.now() - startedAt;
    if (mismatch === undefined || elapsed >= POSTURE_GEOMETRY_WAIT_MS) {
      break;
    }
    await awaitWhileRequestIsLive(
      timer.sleep(Math.min(POSTURE_GEOMETRY_POLL_MS, POSTURE_GEOMETRY_WAIT_MS - elapsed)),
      operation.signal,
    );
    operation.assertCurrent();
  }
  return mismatch === undefined
    ? undefined
    : `Screen geometry is still inconsistent ${POSTURE_GEOMETRY_WAIT_MS} ms after the posture change: ${mismatch}. Taps may land in the wrong place; observe again before tapping.`;
}

async function recheck(check: PostureGeometryCheck): Promise<string | undefined> {
  const { operation } = check;
  operation.assertCurrent();
  try {
    await awaitWhileRequestIsLive(check.refreshRunner(), operation.signal);
  } catch (error) {
    operation.assertCurrent();
    throwIfAborted(operation.signal);
    // The fresh observe below still re-checks; a missed refresh only delays agreement.
    logger.warn(`[SetPosture] Runner geometry refresh failed: ${errorMessage(error)}`, error);
  }
  operation.assertCurrent();
  const observation = await awaitWhileRequestIsLive(check.observe(), operation.signal);
  operation.assertCurrent();
  return describePostureGeometryMismatch(observation);
}
