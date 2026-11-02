import {
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_ONE_SHOT_CLI_PARAM,
  INTERNAL_REQUESTER_SESSION_UUID_PARAM,
} from "./constants";

/** Typed readers for in-band call metadata; values of the wrong type read as absent. */
function internalParam(args: object, name: string): unknown {
  return (args as Record<string, unknown>)[name];
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

/** The admitted routing snapshot carried across acquisition schema parsing. */
export function internalRequesterSessionUuid(args: object): string | undefined {
  const value = internalParam(args, INTERNAL_REQUESTER_SESSION_UUID_PARAM);
  return typeof value === "string" ? value : undefined;
}

/** The one-shot marker when callers must distinguish absence from an explicit false. */
export function internalOptionalOneShotCli(args: object): boolean | undefined {
  const value = internalParam(args, INTERNAL_ONE_SHOT_CLI_PARAM);
  return typeof value === "boolean" ? value : undefined;
}
