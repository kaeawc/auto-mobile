import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionToolProfileService } from "./SessionToolProfileService";

/**
 * Ambient context threaded through a tool invocation.
 *
 * `routingSessionUuid` is the ROUTING session — the derived/label session a
 * device-aware call resolved to (issue #4611 Gap C). Nested device-aware and
 * internal calls re-inject it so a `${base}:${label}` label session keeps its
 * device/routing identity instead of collapsing back onto the base session.
 * Capability enforcement is computed SEPARATELY at each assert call (union of
 * base + derived, Gap B) and is intentionally NOT carried here, so routing and
 * capability can no longer be re-conflated. A connection-scoped capability
 * profile is carried independently so it can participate in that union without
 * changing nested calls' routing identity.
 */
type ToolCapabilityContext = {
  routingSessionUuid?: string;
  /** Connection-scoped profile used for policy, distinct from device routing. */
  capabilitySessionUuid?: string;
  /** An admitted executePlan may invoke its nested plan steps without per-step opt-ins. */
  planCapabilitiesAuthorized?: boolean;
  sessionToolProfileService?: Pick<SessionToolProfileService, "isEnabled"> &
    Partial<Pick<SessionToolProfileService, "setEnabled" | "deleteSession">>;
};

const toolCapabilityContext = new AsyncLocalStorage<ToolCapabilityContext>();

export const runWithToolCapabilityContext = async <T>(
  context: ToolCapabilityContext,
  fn: () => Promise<T>
): Promise<T> => {
  const parent = toolCapabilityContext.getStore();
  return toolCapabilityContext.run({
    routingSessionUuid: context.routingSessionUuid ?? parent?.routingSessionUuid,
    capabilitySessionUuid: context.capabilitySessionUuid ?? parent?.capabilitySessionUuid,
    planCapabilitiesAuthorized: context.planCapabilitiesAuthorized
      ?? parent?.planCapabilitiesAuthorized,
    sessionToolProfileService: context.sessionToolProfileService ?? parent?.sessionToolProfileService,
  }, fn);
};

export const getToolCapabilityContext = (): ToolCapabilityContext | undefined => {
  return toolCapabilityContext.getStore();
};
