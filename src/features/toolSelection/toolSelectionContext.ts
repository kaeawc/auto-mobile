import {
  type DeviceExecutionBinding,
  runWithDeviceExecutionBinding,
} from "../../utils/deviceExecutionBinding";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionToolSelectionService } from "./SessionToolSelectionService";
import type { ProgressCallback } from "../../server/toolRegistry";

export type ToolSelectionContext = {
  /** A device-aware wrapper already owns this execution's session resolution (#11680). */
  deviceAwareDispatch?: true;
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
  /**
   * The connection the enclosing call runs for (#11469). Plan steps and nested internal calls
   * inherit it, so a session they name is judged by the same owner rule as a direct call. Absent
   * for a call with no originating connection.
   */
  callerMcpSessionId?: string;
  /** Connection-bound ownership proof for read-only cross-device checks. */
  ownsDeviceSession?: (sessionUuid: string) => boolean;
  execution?: {
    deviceBinding?: DeviceExecutionBinding;
    executionId: string;
    /** When the call started, on the tracker's wall clock. */
    startTime: number;
    /** The same instant on the session clock, which session expiry is judged on (#11290). */
    sessionClockStartTime?: number;
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

/** A nested call with no identity of its own keeps the enclosing call's (#11469). */
function resolveCallerMcpSessionId(
  context: ToolSelectionContext,
  parent: ToolSelectionContext | undefined,
): string | undefined {
  return context.callerMcpSessionId ?? parent?.callerMcpSessionId;
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
      callerMcpSessionId: resolveCallerMcpSessionId(context, parent),
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
