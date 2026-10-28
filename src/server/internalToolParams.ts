import {
  deleteInternalToolParams,
  INTERNAL_EXECUTION_ID_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_ONE_SHOT_CLI_PARAM,
  INTERNAL_TOOL_PARAM_NAMES,
} from "../daemon/wire/constants";

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
