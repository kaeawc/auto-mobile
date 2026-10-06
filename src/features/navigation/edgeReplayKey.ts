import { stripNavigationToolParams } from "../../daemon/constants";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

/**
 * Identity of the action an edge replays, independent of which row recorded it.
 * Every traversal inserts a new `navigation_edges` row, so two rows with the same tool
 * and arguments are the same action and share a replay outcome (#10031). An edge with
 * no tool call (replayed as Back) has the empty action key.
 */
export function edgeActionKey(
  toolName: string | null | undefined,
  args: Record<string, unknown> | undefined,
): string {
  if (!toolName) {
    return "";
  }
  return `${toolName}\u0000${JSON.stringify(stripNavigationToolParams(args ?? {}))}`;
}

/** The action key of a stored edge row, from its raw `tool_args` JSON; never throws. */
export function storedEdgeActionKey(toolName: string | null, toolArgs: string | null): string {
  if (!toolName) {
    return "";
  }
  try {
    const parsed: Record<string, unknown> = toolArgs ? JSON.parse(toolArgs) : {};
    return edgeActionKey(toolName, parsed);
  } catch (error) {
    // A malformed stored payload still identifies its own row's action by its raw text;
    // findPath's path conversion reports the parse failure where it matters.
    logger.debug(
      `[NAVIGATION_GRAPH] Unparseable tool_args for ${toolName}: ${errorMessage(error)}`,
    );
    return `${toolName}\u0000raw:${toolArgs}`;
  }
}

/** Key of a screen pair; failure memory is kept per pair, then per action. */
export function edgePairKey(appId: string, from: string, to: string): string {
  return `${appId}\u0000${from}\u0000${to}`;
}

/** Identity of an edge within one navigation attempt: pair plus action. */
export function edgeReplayKey(edge: {
  from: string;
  to: string;
  interaction?: { toolName: string; args: Record<string, unknown> };
}): string {
  return `${edge.from}\u0000${edge.to}\u0000${edgeActionKey(edge.interaction?.toolName, edge.interaction?.args)}`;
}
