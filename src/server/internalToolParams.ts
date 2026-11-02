import { deleteInternalToolParams, INTERNAL_TOOL_PARAM_NAMES } from "../daemon/wire/constants";
export {
  internalMcpSessionId,
  internalOneShotCli,
  internalLiveDeadlineKey,
} from "../daemon/wire/internalToolParams";

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

// The typed readers of the restart-resume context a nested `startDevice` carries in-band (#15663),
// written by the acquisition tools as explicit overrides. The call's execution identity is not
// in-band: read it from the ambient call context (`currentExecution`).

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

/** Record the session a restart-resume start recovers unless the args already name one. */
export function adoptRestartResumeSessionUuid(
  args: { __restartResumeSessionUuid?: string },
  sessionUuid: string | undefined,
): void {
  args.__restartResumeSessionUuid ??= sessionUuid;
}
