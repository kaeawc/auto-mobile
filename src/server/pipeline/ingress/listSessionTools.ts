import { defaultDaemonContext, type DaemonContext } from "../../../daemon/daemonContext";
import { isAlwaysOnTool } from "../../../features/toolSelection/toolSelectionControl";
import { resolveToolSelectionBaseSessionUuid } from "../../../features/toolSelection/selectionSessionResolver";
import {
  buildToolSelectionCandidateRoutes,
  isToolEnabledForAnyRoute,
} from "../../../features/toolSelection/toolSelectionPolicy";
import type { McpServerOptions } from "../../index";
import type { SessionToolBinding } from "../../SessionToolBinding";
import { ToolRegistry } from "../../toolRegistry";
import type { ToolSelectionProfileRegistry } from "../../../daemon/toolSelectionProfileRegistry";
import { resolveToolResultsNoStructuredContent } from "./connectionPresentation";

export interface ListSessionToolsDeps {
  readonly options: McpServerOptions;
  /** The request's session key, else the stateful transport's id (#4678). */
  readonly bindingKey: string | undefined;
  readonly sessionToolBinding: SessionToolBinding;
  readonly toolSelectionProfileRegistry: ToolSelectionProfileRegistry;
  /** Daemon state reads; defaults to the DaemonState bridge. */
  readonly daemon?: DaemonContext;
}

/**
 * Build the `tools/list` producer for one MCP server. Also reused after a
 * device acquisition, to report the session's gated and enabled tool names.
 */
export function createListSessionTools(deps: ListSessionToolsDeps) {
  const { options, bindingKey, sessionToolBinding, toolSelectionProfileRegistry } = deps;
  const daemon = deps.daemon ?? defaultDaemonContext;
  return async (routingSessionUuid = sessionToolBinding.effectiveSessionUuid(bindingKey)) => {
    const connectionProfileUuid = sessionToolBinding.connectionToolSelectionProfileUuid(bindingKey);
    const selectionSessionManager = options.toolSelectionSessionManager ?? daemon.sessionManager();
    const routingBaseSessionUuid = resolveToolSelectionBaseSessionUuid(
      routingSessionUuid,
      selectionSessionManager,
    );
    const definitions = ToolRegistry.getToolDefinitions({
      suppressOutputSchema: resolveToolResultsNoStructuredContent(
        toolSelectionProfileRegistry,
        connectionProfileUuid,
      ),
    });
    // Advertise a tool when EITHER the bound base session OR any of its derived
    // `${base}:${label}` device-label sessions enables it — the same UNION the
    // `tools/call` gate applies (issue #4611). The call-gate accepts a
    // `{ sessionUuid: base, device: label }` call whenever a label re-enables a
    // tool the base narrowed away; filtering discovery on the base alone would
    // then leave that tool callable but never discovered. Each label remains an
    // independent `[base, label]` route before those route results are unioned;
    // flattening every label into one override set would let one label's explicit
    // disable hide a tool that is still callable through a sibling. The base's
    // label map is a read-only lookup (no device allocation); a session with no
    // labels collapses to the base, preserving prior single-session filtering.
    //
    // The union is per-tool and DEVICE-AWARE only, mirroring the call gate: a
    // plain (non-`requiresDevice`) tool ignores any `device` argument, so its
    // discovery only evaluates the bound routing session. Advertising a plain
    // tool that only a sibling label enables would leave it listed but rejected
    // by the call gate — a label-only grant must not surface a plain tool.
    const labelSessionUuids = routingBaseSessionUuid
      ? Array.from(
          new Set(
            Object.values(selectionSessionManager?.getDeviceLabels(routingBaseSessionUuid) ?? {}),
          ),
        )
      : [];
    return {
      tools: (
        await Promise.all(
          definitions.map(async (definition) => {
            const registeredTool = ToolRegistry.getTool(definition.name);
            const deviceAware = registeredTool?.requiresDevice ?? false;
            const candidateRoutes = buildToolSelectionCandidateRoutes(
              deviceAware,
              routingBaseSessionUuid,
              labelSessionUuids,
              [routingBaseSessionUuid, routingSessionUuid],
            );
            return isAlwaysOnTool(definition.name) ||
              (await isToolEnabledForAnyRoute(
                definition.name,
                registeredTool?.defaultEnabled ?? true,
                candidateRoutes,
                options.sessionToolSelectionService,
                connectionProfileUuid,
              ))
              ? definition
              : undefined;
          }),
        )
      ).filter(
        (definition): definition is (typeof definitions)[number] => definition !== undefined,
      ),
    };
  };
}
