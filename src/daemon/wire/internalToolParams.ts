import { INTERNAL_REQUESTER_SESSION_UUID_PARAM } from "./constants";

/** Typed readers for in-band call metadata; values of the wrong type read as absent. */
function internalParam(args: object, name: string): unknown {
  return (args as Record<string, unknown>)[name];
}

/** The admitted routing snapshot carried across acquisition schema parsing. */
export function internalRequesterSessionUuid(args: object): string | undefined {
  const value = internalParam(args, INTERNAL_REQUESTER_SESSION_UUID_PARAM);
  return typeof value === "string" ? value : undefined;
}
