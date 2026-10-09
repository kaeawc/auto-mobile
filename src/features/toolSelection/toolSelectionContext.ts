import {
  type DeviceExecutionBinding,
  runWithDeviceExecutionBinding,
} from "../../utils/deviceExecutionBinding";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionToolSelectionService } from "./SessionToolSelectionService";
import type { ProgressCallback } from "../../server/toolRegistry";

export type ToolSelectionContext = {
  /**
   * The call runs on the read-only device path: set at MCP ingress when observe's raw arguments
   * explicitly name a device, and by ToolRegistry for a sessionless read-only call on a device
   * another session holds (#10830). Read it through `isSessionlessDeviceRead`.
   */
  explicitObserveDeviceRead?: boolean;
  /** Trusted enclosing plan metadata, reattached after each step's schema parse. */
  planRequest?: {
    deadlineMs?: unknown;
    timeoutMs?: unknown;
    startTime?: unknown;
    liveDeadlineKey?: unknown;
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
  /** Effective connection presentation preference, resolved at MCP ingress. */
  actionsCompactMetadata?: boolean;
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

/** Whether the current device-aware call runs on the read-only device path (#10830). */
export function isSessionlessDeviceRead(): boolean {
  return getToolSelectionContext()?.explicitObserveDeviceRead === true;
}
