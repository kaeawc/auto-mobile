import type { ObserveResult } from "../../models";
import type { CtrlProxyRefreshGeometryResult } from "../observe/ios/types";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { resolveIosObserveRotation } from "../observe/iosObserveRotation";
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
 * it: the runner's rotation, normalized as observe normalizes it (a fixed portrait display
 * reports 0), is a different orientation from the observed one, or the observation is
 * portrait-reported with a landscape layout (#18245).
 */
export function describePostureGeometryMismatch(
  observation: GeometryObservation,
): string | undefined {
  const runner = observation.viewHierarchy?.rotation;
  const normalizedRunner = isRotation(runner)
    ? resolveIosObserveRotation(runner, observation.screenSize)
    : undefined;
  const observed = observation.rotation;
  if (
    isRotation(normalizedRunner) &&
    isRotation(observed) &&
    normalizedRunner % 2 !== observed % 2
  ) {
    const { width, height } = observation.screenSize;
    return `the runner reports rotation ${runner} but observe reports rotation ${observed} at ${width}x${height}`;
  }
  return describeTransposedLayout(observation);
}

/** The part of a `refresh_geometry` reply the post-condition compares with observe. */
export type RunnerGeometryReply = Pick<
  CtrlProxyRefreshGeometryResult,
  "success" | "refreshed" | "rotation" | "unsupported" | "error"
>;

export interface PostureGeometryCheck {
  timer: Timer;
  operation: PostureOperation;
  /** Drop the runner's cached gesture geometry and read back the rotation its taps will use. */
  refreshGeometry(): Promise<RunnerGeometryReply>;
  /** Older runners without `refresh_geometry`: a hierarchy sync that rebuilds the cached geometry. */
  refreshRunner(): Promise<unknown>;
  observe(): Promise<GeometryObservation>;
}

/**
 * Names a disagreement between the runner's refreshed rotation and observe, normalized as observe
 * normalizes the runner's capture rotation.
 */
export function describeRunnerGeometryMismatch(
  reply: RunnerGeometryReply,
  observation: GeometryObservation,
): string | undefined {
  const runner = reply.rotation;
  const observed = observation.rotation;
  if (!isRotation(runner) || !isRotation(observed)) {
    return undefined;
  }
  const normalizedRunner = resolveIosObserveRotation(runner, observation.screenSize);
  if (!isRotation(normalizedRunner) || normalizedRunner % 2 === observed % 2) {
    return undefined;
  }
  const { width, height } = observation.screenSize;
  return `the runner's refreshed geometry reports rotation ${runner} but observe reports rotation ${observed} at ${width}x${height}`;
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
  const state: RecheckState = { refreshGeometrySupported: true };
  while (true) {
    try {
      mismatch = await recheck(check, state);
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

interface RecheckState {
  /** Cleared once the runner reports it has no `refresh_geometry` command. */
  refreshGeometrySupported: boolean;
}

async function recheck(
  check: PostureGeometryCheck,
  state: RecheckState,
): Promise<string | undefined> {
  const { operation } = check;
  operation.assertCurrent();
  const reply = state.refreshGeometrySupported ? await refreshRunnerGeometry(check) : undefined;
  if (reply?.unsupported === true) {
    state.refreshGeometrySupported = false;
  }
  if (reply === undefined || reply.success !== true) {
    await syncRunnerHierarchy(check);
  }
  operation.assertCurrent();
  const observation = await awaitWhileRequestIsLive(check.observe(), operation.signal);
  operation.assertCurrent();
  const runnerMismatch =
    reply?.success === true && reply.refreshed
      ? describeRunnerGeometryMismatch(reply, observation)
      : undefined;
  return runnerMismatch ?? describePostureGeometryMismatch(observation);
}

/** Calls `refresh_geometry`, once more when a rotation landed mid-capture (`refreshed: false`). */
async function refreshRunnerGeometry(
  check: PostureGeometryCheck,
): Promise<RunnerGeometryReply | undefined> {
  let reply = await requestRunnerGeometry(check);
  if (reply?.success === true && !reply.refreshed) {
    reply = await requestRunnerGeometry(check);
  }
  if (reply !== undefined && reply.success !== true && reply.unsupported !== true) {
    logger.warn(`[SetPosture] Runner refresh_geometry failed: ${reply.error ?? "unknown error"}`);
  }
  return reply;
}

async function requestRunnerGeometry(
  check: PostureGeometryCheck,
): Promise<RunnerGeometryReply | undefined> {
  const { operation } = check;
  operation.assertCurrent();
  try {
    return await awaitWhileRequestIsLive(check.refreshGeometry(), operation.signal);
  } catch (error) {
    operation.assertCurrent();
    throwIfAborted(operation.signal);
    // The hierarchy-sync fallback and fresh observe below still re-check.
    logger.warn(`[SetPosture] Runner refresh_geometry failed: ${errorMessage(error)}`, error);
    return undefined;
  }
}

async function syncRunnerHierarchy(check: PostureGeometryCheck): Promise<void> {
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
}
