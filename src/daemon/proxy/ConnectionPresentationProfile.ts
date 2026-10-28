import type { DaemonClientLike } from "../client/client";
import { DaemonUnavailableError } from "../client/client";
import {
  INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
  INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM,
} from "../wire/constants";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../../features/toolSelection/toolSelectionControl";
import { runPreflightTransport } from "./DaemonLifecycleReconciler";

/** The frontend presentation options materialized on the daemon-issued connection profile. */
export interface ConnectionPresentationOptions {
  enabledTools?: string[];
  disabledTools?: string[];
  toolResultsNoStructuredContent?: boolean;
  actionsCompactMetadata?: boolean;
}

/**
 * Proxy state the presentation profile reads and updates:
 * - withToolSelectionProfile attaches the current connection profile uuid to outgoing args.
 * - rememberToolSelectionProfile captures the profile uuid minted by a successful write.
 * - hasToolSelectionProfile reports whether a profile uuid is held.
 */
export interface ConnectionPresentationProfilePort {
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown>;
  rememberToolSelectionProfile(
    name: string,
    requestedArgs: Record<string, unknown>,
    result: unknown,
  ): void;
  hasToolSelectionProfile(): boolean;
}

export interface PresentationUpdate {
  toolNames: string[];
  enabled: boolean;
}

export function connectionPresentationUpdates(
  enabledTools: string[],
  disabledTools: string[],
  toolResultsNoStructuredContent: boolean | undefined,
  actionsCompactMetadata: boolean | undefined,
): PresentationUpdate[] {
  if (
    enabledTools.length === 0 &&
    disabledTools.length === 0 &&
    toolResultsNoStructuredContent === undefined &&
    actionsCompactMetadata === undefined
  ) {
    return [];
  }

  const updates: PresentationUpdate[] = [];
  if (enabledTools.length > 0) {
    updates.push({ toolNames: [...enabledTools], enabled: true });
  }
  if (disabledTools.length > 0) {
    updates.push({ toolNames: [...disabledTools], enabled: false });
  }
  if (updates.length === 0) {
    // setToolEnabled is always-on; reaffirming it is a no-op that mints the
    // connection profile needed to carry a presentation-only policy.
    updates.push({ toolNames: [SET_TOOL_ENABLED_TOOL_NAME], enabled: true });
  }

  return updates;
}

/**
 * Materialize this frontend's presentation options on its daemon-issued
 * connection profile. The profile survives socket reconnects in this proxy,
 * while reapplying the writes makes daemon replacement safe without promoting
 * any of these options back to process-global startup state.
 * Moved verbatim from DaemonMcpProxy; behaviour is unchanged.
 */
export async function applyConnectionPresentationProfile(
  client: DaemonClientLike,
  options: ConnectionPresentationOptions | undefined,
  port: ConnectionPresentationProfilePort,
): Promise<void> {
  const {
    enabledTools = [],
    disabledTools = [],
    toolResultsNoStructuredContent,
    actionsCompactMetadata,
  } = options ?? {};
  const updates = connectionPresentationUpdates(
    enabledTools,
    disabledTools,
    toolResultsNoStructuredContent,
    actionsCompactMetadata,
  );

  for (const update of updates) {
    const requestedArgs = {
      ...update,
      ...(toolResultsNoStructuredContent !== undefined
        ? {
            [INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM]: toolResultsNoStructuredContent,
          }
        : {}),
      ...(actionsCompactMetadata !== undefined
        ? { [INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]: actionsCompactMetadata }
        : {}),
    };
    const forwardedArgs = port.withToolSelectionProfile(requestedArgs);
    const result = await runPreflightTransport(() =>
      client.callTool(SET_TOOL_ENABLED_TOOL_NAME, forwardedArgs),
    );
    if (result?.isError) {
      throw new DaemonUnavailableError(
        `Failed to apply connection presentation profile: ${JSON.stringify(result)}`,
      );
    }
    port.rememberToolSelectionProfile(SET_TOOL_ENABLED_TOOL_NAME, requestedArgs, result);
    if (!port.hasToolSelectionProfile()) {
      throw new DaemonUnavailableError(
        "Daemon did not return a connection profile while applying presentation options",
      );
    }
  }
}
