import {
  type DeviceExecutionBinding,
  runWithDeviceExecutionBinding,
} from "../../utils/deviceExecutionBinding";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionToolSelectionService } from "./SessionToolSelectionService";
import type { ProgressCallback } from "../../server/toolRegistry";

export type ToolSelectionContext = {
  /** Set only at MCP ingress when observe's raw arguments explicitly name a device. */
  explicitObserveDeviceRead?: boolean;
  /** Trusted enclosing plan metadata, reattached after each step's schema parse. */
  planRequest?: {
    deadlineMs?: unknown;
    timeoutMs?: unknown;
    startTime?: unknown;
    liveDeadlineKey?: unknown;
    /**
     * Nesting level of the plan this context belongs to: 1 for the outermost `executePlan`, +1 for
     * each `executePlan` step it starts. Its mere presence also marks a call as running INSIDE a
     * plan, which is what keeps a nested plan from releasing the enclosing plan's session (#10172).
     */
    planDepth?: number;
    progress?: ProgressCallback;
  };
  routingSessionUuid?: string;
  /** Connection-bound ownership proof for read-only cross-device checks. */
  ownsDeviceSession?: (sessionUuid: string) => boolean;
  execution?: {
    deviceBinding?: DeviceExecutionBinding;
    executionId: string;
    startTime: number;
  };
  /** Connection-scoped selection profile, independent of device routing. */
  toolSelectionProfileUuid?: string;
  /** Derived device-label selection profiles for the current routing base. */
  labelSessionUuids?: readonly string[];
  /** Resolved base profile for the current routing session. */
  routingBaseSessionUuid?: string;
  sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled"> &
    Partial<Pick<SessionToolSelectionService, "setEnabled" | "deleteSession">>;
};

const toolSelectionContext = new AsyncLocalStorage<ToolSelectionContext>();

function resolveLabelSessionUuids(
  context: ToolSelectionContext,
  parent: ToolSelectionContext | undefined,
): readonly string[] | undefined {
  return context.labelSessionUuids ?? parent?.labelSessionUuids;
}

function resolveRoutingBaseSessionUuid(
  context: ToolSelectionContext,
  parent: ToolSelectionContext | undefined,
): string | undefined {
  return context.routingBaseSessionUuid ?? parent?.routingBaseSessionUuid;
}

export const runWithToolSelectionContext = async <T>(
  context: ToolSelectionContext,
  fn: () => Promise<T>,
): Promise<T> => {
  const parent = toolSelectionContext.getStore();
  return toolSelectionContext.run(
    {
      ...parent,
      ...context,
      planRequest: context.planRequest ?? parent?.planRequest,
      routingSessionUuid: context.routingSessionUuid ?? parent?.routingSessionUuid,
      execution: context.execution ?? parent?.execution,
      toolSelectionProfileUuid:
        context.toolSelectionProfileUuid ?? parent?.toolSelectionProfileUuid,
      labelSessionUuids: resolveLabelSessionUuids(context, parent),
      routingBaseSessionUuid: resolveRoutingBaseSessionUuid(context, parent),
      sessionToolSelectionService:
        context.sessionToolSelectionService ?? parent?.sessionToolSelectionService,
    },
    () =>
      runWithDeviceExecutionBinding((context.execution ?? parent?.execution)?.deviceBinding, fn),
  );
};

export const getToolSelectionContext = (): ToolSelectionContext | undefined =>
  toolSelectionContext.getStore();
