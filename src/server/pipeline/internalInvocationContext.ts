import {
  getToolSelectionContext,
  type ToolSelectionContext,
} from "../../features/toolSelection/toolSelectionContext";
import { nonBlankSessionUuid } from "../planCallerIdentity";
import type { InternalToolCallOptions, InternalToolInvocationContext } from "../toolRegistryTypes";
import { withoutPlanSuppliedDeadlineParams } from "./advertisedSchema";

/**
 * A plan's nested calls inherit its run start and request deadline. Outside a plan, deadlines
 * are explicit (#15663); the run anchor is absent.
 */
function internalCallExecutionContext(
  context: ToolSelectionContext | undefined,
  options: InternalToolCallOptions,
): Pick<InternalToolInvocationContext, "requestDeadline" | "planStartMs"> {
  return {
    requestDeadline: context?.planRequest ? context.requestDeadline : options.requestDeadline,
    planStartMs: options.planStartMs ?? context?.planStartMs,
  };
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
  if (context?.planRequest) {
    args = withoutPlanSuppliedDeadlineParams(args);
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
    planLockNamespace: options.planLockNamespace,
    ...internalCallExecutionContext(context, options),
    autolockMcpSessionId: undefined,
    oneShotCli: undefined,
    acceptanceDiscoveryOrder: undefined,
    routingSessionUuid: sessionUuid,
    toolSelectionProfileUuid: context?.toolSelectionProfileUuid,
    sessionToolSelectionService:
      options.sessionToolSelectionService ?? context?.sessionToolSelectionService,
  };
}
