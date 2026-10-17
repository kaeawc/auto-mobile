import type { FeatureFlagKey } from "../../features/featureFlags/FeatureFlagDefinitions";
import type { FeatureFlagService } from "../../features/featureFlags/FeatureFlagService";
import type { SessionToolSelectionService } from "../../features/toolSelection/SessionToolSelectionService";
import { IDE_ROUTE_PARSERS } from "../ideRoutes";
import type { DaemonRequest } from "../types";

/**
 * The `ide/*` routes that need little of the server (#11815): feature flags, per-session tool
 * enablement and ping. The route module names exactly what it reads from the socket server in
 * {@link IdeFeatureRouteDeps}; the server supplies it and mounts the handlers in its route map.
 */

export type IdeRouteHandler = (
  request: DaemonRequest,
  socketSessionId: string | undefined,
) => Promise<unknown>;

export interface IdeFeatureRouteDeps {
  /** The feature-flag service; throws when the daemon runs without one. */
  requireFeatureFlagService: () => Pick<FeatureFlagService, "listFlags" | "setFlag">;
  sessionToolSelection: () => Pick<SessionToolSelectionService, "setEnabled">;
  /** A broker-bound connection may not change host-wide state. */
  assertBrokerHostMutation: (socketSessionId: string | undefined, action: string) => void;
  /** A broker-bound connection controls only its own sessions. */
  assertBrokerControl: (
    socketSessionId: string | undefined,
    action: string,
    target: { requesterSessionUuid: string },
  ) => void;
  emitToolsListChanged: () => void;
  now: () => number;
}

export function ideFeatureRoutes(deps: IdeFeatureRouteDeps): ReadonlyMap<string, IdeRouteHandler> {
  return new Map<string, IdeRouteHandler>([
    [
      "ide/listFeatureFlags",
      async () => {
        const flags = await deps.requireFeatureFlagService().listFlags();
        return { flags };
      },
    ],
    [
      "ide/setFeatureFlag",
      async (request, socketSessionId) => {
        const featureFlagService = deps.requireFeatureFlagService();
        const args = IDE_ROUTE_PARSERS["ide/setFeatureFlag"](request.params);
        deps.assertBrokerHostMutation(socketSessionId, "ide/setFeatureFlag");
        return await featureFlagService.setFlag(
          args.key as FeatureFlagKey,
          args.enabled,
          args.config,
        );
      },
    ],
    [
      "ide/setSessionToolEnabled",
      async (request, socketSessionId) => {
        const args = IDE_ROUTE_PARSERS["ide/setSessionToolEnabled"](request.params);
        deps.assertBrokerControl(socketSessionId, "ide/setSessionToolEnabled", {
          requesterSessionUuid: args.sessionUuid,
        });
        await deps.sessionToolSelection().setEnabled(args.sessionUuid, args.toolName, args.enabled);
        deps.emitToolsListChanged();
        return {
          sessionUuid: args.sessionUuid,
          toolName: args.toolName,
          enabled: args.enabled,
        };
      },
    ],
    ["ide/ping", async () => ({ ok: true, timestamp: deps.now() })],
  ]);
}
