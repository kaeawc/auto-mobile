import {
  type DeviceExecutionBinding,
  runWithDeviceExecutionBinding,
} from "../../utils/deviceExecutionBinding";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionToolSelectionService } from "./SessionToolSelectionService";
import type { ProgressCallback } from "../action/BaseVisualChange";
import type { TapAtPlanContext } from "../../models/TapAtGeometry";
import type { SwipeAtRecordingContext } from "../../models/SwipeAtOptions";

/**
 * What a device-aware call's handler resolved for the call recorder (#15663): a tapAt's geometry
 * and a swipeAt's screen. Mutable: the handler fills it and the recorder reads it after the call.
 */
export interface ToolCallRecordingContext {
  tapAt?: TapAtPlanContext;
  swipeAt?: SwipeAtRecordingContext;
}

/**
 * The transport deadline of the request a call runs for (#15663, #6222), in the units the daemon
 * forwards: an absolute deadline, the remaining budget, the execution start it is measured from,
 * and the key of the live (progress-extended) deadline. Set at MCP ingress; a plan step and
 * anything nested inside a plan inherit it, as does a nested call made without `callInternal`.
 * Another `callInternal` call runs without one unless its caller passes one (`requestDeadline`).
 */
export interface RequestDeadline {
  readonly deadlineMs?: number;
  readonly timeoutMs?: number;
  readonly startTime?: number;
  readonly liveDeadlineKey?: string;
}

export type ToolSelectionContext = {
  /** A device-aware wrapper already owns this execution's session resolution (#11680). */
  deviceAwareDispatch?: true;
  /**
   * The call runs on the read-only device path: set at MCP ingress when observe's raw arguments
   * explicitly name a device, and by ToolRegistry for a sessionless read-only call on a device
   * another session holds (#10830). Read it through `isSessionlessDeviceRead`.
   */
  explicitObserveDeviceRead?: boolean;
  /** The request's transport deadline; an explicit `undefined` clears an inherited one. */
  requestDeadline?: RequestDeadline;
  /**
   * Trusted enclosing plan metadata, reattached after each step's schema parse. Its deadline fields
   * now reach only provisioning's in-band reads; every other step reads `requestDeadline` (#15663).
   */
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
  /** The connection key the call's per-connection device pin is stored under (#14385). */
  deviceConnectionKey?: string;
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
  /**
   * The geometry a plan step replays a tapAt against (#15663). Set by `callInternal` for that one
   * call, so a nested call never inherits a step's geometry.
   */
  tapAtPlanContext?: TapAtPlanContext;
  /** This device-aware call's recording context, set by its wrapper (#15663); never inherited. */
  toolCallRecording?: ToolCallRecordingContext;
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

/** A nested call without its own device-pin key keeps the enclosing call's (#14385). */
function resolveDeviceConnectionKey(
  context: ToolSelectionContext,
  parent: ToolSelectionContext | undefined,
): string | undefined {
  return context.deviceConnectionKey ?? parent?.deviceConnectionKey;
}

/** An explicit `requestDeadline` (even `undefined`) replaces the parent's (#15663). */
function resolveRequestDeadline(
  context: ToolSelectionContext,
  parent: ToolSelectionContext | undefined,
): RequestDeadline | undefined {
  return Object.hasOwn(context, "requestDeadline")
    ? context.requestDeadline
    : parent?.requestDeadline;
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
      deviceConnectionKey: resolveDeviceConnectionKey(context, parent),
      execution: context.execution ?? parent?.execution,
      requestDeadline: resolveRequestDeadline(context, parent),
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

/**
 * The tracked execution the current call runs under (#15663): set at MCP ingress and inherited by
 * every nested call and plan step. Absent outside a tool call.
 */
export function currentExecution(): ToolSelectionContext["execution"] {
  return getToolSelectionContext()?.execution;
}

/** The transport deadline of the request the current call runs for, if it has one (#15663). */
export function currentRequestDeadline(): RequestDeadline | undefined {
  return getToolSelectionContext()?.requestDeadline;
}

/** Whether the current device-aware call runs on the read-only device path (#10830). */
export function isSessionlessDeviceRead(): boolean {
  return getToolSelectionContext()?.explicitObserveDeviceRead === true;
}
