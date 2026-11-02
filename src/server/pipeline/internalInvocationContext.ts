import {
  getToolSelectionContext,
  type RequestDeadline,
  type ToolSelectionContext,
} from "../../features/toolSelection/toolSelectionContext";
import { nonBlankSessionUuid } from "../planCallerIdentity";
import type { InternalToolCallOptions, InternalToolInvocationContext } from "../toolRegistryTypes";
import { applyInheritedPlanRequestParams } from "./advertisedSchema";

/**
 * Inside a plan every internal call runs under the request's deadline, as plan steps always have;
 * anything else gets only the deadline its caller passes (#15663).
 */
function internalCallRequestDeadline(
  context: ToolSelectionContext | undefined,
  options: InternalToolCallOptions,
): RequestDeadline | undefined {
  return context?.planRequest ? context.requestDeadline : options.requestDeadline;
}

/**
 * What an internal call (`callInternal`: a plan step, a nested tool) runs under: its arguments with
 * the inherited plan request and routing session applied, and the ambient overrides it sets.
 */
export function internalToolInvocationContext(
  args: Record<string, unknown>,
  options: InternalToolCallOptions,
): InternalToolInvocationContext {
  const context = getToolSelectionContext();
  const request = context?.planRequest;
  if (request) {
    args = applyInheritedPlanRequestParams(args, request);
  }
  // An internal call inherits the ambient ROUTING session (issue #4611 Gap C)
  // so a plan step or navigation replay routes to the same derived/label
  // session the outer call resolved to, not the base session.
  // A blank session names none (#11469), so it never replaces the one below it.
  const sessionUuid =
    nonBlankSessionUuid(options.sessionUuid) ??
    nonBlankSessionUuid(context?.routingSessionUuid) ??
    nonBlankSessionUuid(args.sessionUuid);
  return {
    args: sessionUuid && args.sessionUuid !== sessionUuid ? { ...args, sessionUuid } : args,
    tapAtPlanContext: options.tapAtPlanContext,
    requestDeadline: internalCallRequestDeadline(context, options),
    routingSessionUuid: sessionUuid,
    toolSelectionProfileUuid: context?.toolSelectionProfileUuid,
    sessionToolSelectionService:
      options.sessionToolSelectionService ?? context?.sessionToolSelectionService,
  };
}
