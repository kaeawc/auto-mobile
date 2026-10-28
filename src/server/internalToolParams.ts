import {
  deleteInternalToolParams,
  INTERNAL_EXECUTION_ID_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_ONE_SHOT_CLI_PARAM,
  INTERNAL_TOOL_PARAM_NAMES,
} from "../daemon/wire/constants";
import type { SwipeAtRecordingContext } from "../models/SwipeAtOptions";
import type { TapAtPlanContext } from "../models/TapAtGeometry";

export function stripInternalToolParams(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }

  if (!INTERNAL_TOOL_PARAM_NAMES.some((name) => name in params)) {
    return params;
  }

  const rest = { ...(params as Record<string, unknown>) };
  deleteInternalToolParams(rest);
  return rest;
}

/**
 * The typed readers of the call identity a handler's args carry in-band (#15663): written by
 * `buildHandlerParams` for the top-level call, and by nested callers as explicit overrides
 * (`withAmbientDeviceContext`, the acquisition tools' nested `startDevice`). Stages read these
 * instead of the raw `__*` keys; a value of the wrong type reads as absent.
 */
function internalParam(args: object, name: string): unknown {
  return (args as Record<string, unknown>)[name];
}

/** The tracked execution this call runs under (`__executionId`). */
export function internalExecutionId(args: object): string | undefined {
  const value = internalParam(args, INTERNAL_EXECUTION_ID_PARAM);
  return typeof value === "string" ? value : undefined;
}

/** The wall-clock start of that execution (`__executionStartTime`). */
export function internalExecutionStartTime(args: object): number | undefined {
  const value = internalParam(args, INTERNAL_EXECUTION_START_TIME_PARAM);
  return typeof value === "number" ? value : undefined;
}

/** The implicit-autolock MCP connection identity (`__mcpSessionId`). */
export function internalMcpSessionId(args: object): string | undefined {
  const value = internalParam(args, INTERNAL_MCP_SESSION_PARAM);
  return typeof value === "string" ? value : undefined;
}

/** Whether the call is a one-shot `--cli` invocation, which is anonymous (`__oneShotCli`). */
export function internalOneShotCli(args: object): boolean {
  return internalParam(args, INTERNAL_ONE_SHOT_CLI_PARAM) === true;
}

/** The restart-resume reservations a start may bind (`__restartResumeTargets`). */
export function internalRestartResumeTargets<T>(args: {
  readonly __restartResumeTargets?: T;
}): T | undefined {
  return args.__restartResumeTargets;
}

/** The one session a restart-resume start must recover (`__restartResumeSessionUuid`). */
export function internalRestartResumeSessionUuid(args: {
  readonly __restartResumeSessionUuid?: string;
}): string | undefined {
  return args.__restartResumeSessionUuid;
}

/** Record the restart-resume reservations on the start's args unless it already carries some. */
export function adoptRestartResumeTargets<T>(
  args: { __restartResumeTargets?: T },
  targets: T,
): void {
  args.__restartResumeTargets ??= targets;
}

/** The key of the request's live (progress-extended) transport deadline (`__mcpLiveDeadlineKey`). */
export function internalLiveDeadlineKey(args: object): string | undefined {
  const value = internalParam(args, INTERNAL_LIVE_DEADLINE_KEY_PARAM);
  return typeof value === "string" ? value : undefined;
}

/** Record the session a restart-resume start recovers unless the args already name one. */
export function adoptRestartResumeSessionUuid(
  args: { __restartResumeSessionUuid?: string },
  sessionUuid: string | undefined,
): void {
  args.__restartResumeSessionUuid ??= sessionUuid;
}

/**
 * The geometry context a `tapAt` resolves against: a plan step's (`__tapAtPlanContext`), else
 * the recording one dispatch attaches (`__tapAtRecordingContext`). Returned by reference so
 * the handler fills the same object the recorder later reads.
 */
export function internalTapAtContext(args: {
  readonly __tapAtPlanContext?: TapAtPlanContext;
  readonly __tapAtRecordingContext?: TapAtPlanContext;
}): TapAtPlanContext | undefined {
  return args.__tapAtPlanContext ?? args.__tapAtRecordingContext;
}

/** The recording context a `swipeAt` fills with its resolved screen (`__swipeAtRecordingContext`), by reference. */
export function internalSwipeAtRecordingContext(args: {
  readonly __swipeAtRecordingContext?: SwipeAtRecordingContext;
}): SwipeAtRecordingContext | undefined {
  return args.__swipeAtRecordingContext;
}
