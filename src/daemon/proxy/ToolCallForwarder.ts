import type { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { TaskRelayFrame } from "../tasks/taskRelay";
import {
  DEVICE_SESSION_ACQUISITION_TOOLS,
  isDeviceSessionAcquisitionTool,
  type DeviceSessionSuspectRefusal,
} from "../deviceSessionResult";
import type { DaemonClientLike } from "../client/client";
import { isDeviceInventoryTool, type DaemonProxyProgressCallback } from "../daemonMcpProxy";
import { isReplaySafeToolName } from "../deviceControlTransportFailure";
import type { DaemonErrorClassifier } from "./DaemonErrorClassifier";
import type { HandoverResolution } from "./HandoverResolution";
import type { HeldSessionLosses } from "./HeldSessionLosses";
import type { ReleaseEpochLedger } from "./ReleaseEpochLedger";
import type { SessionBinding } from "./SessionBinding";

/** How one forward of a tool call behaves. */
export interface ToolCallForwardMode {
  /** Whether a suspect-session refusal may be retried once after recovery. */
  readonly allowSuspectRetry: boolean;
  /** The Tasks relay (#4668), only for a call whose client declared the extension. */
  readonly tasks?: TaskRelayFrame;
}

/**
 * What one forwarded tool call needs to apply its result to this proxy's session state: the same
 * whether the result arrives as the call's answer or, for a call the daemon ran as an MCP task
 * (#4668), through a later `tasks/get`.
 */
export interface ForwardedResultContext {
  readonly name: string;
  readonly callerArgs: Record<string, unknown>;
  readonly forwardedArgs: Record<string, unknown>;
  readonly forwardedSessionUuid: string | undefined;
  readonly callReleaseEpoch: number;
  readonly isSessionAcquisition: boolean;
  readonly learnsResultSession: boolean;
  readonly allowSuspectRetry: boolean;
}

/** A forwarded tool call's result, with the suspect refusal the proxy may retry it after. */
export interface ForwardedToolCall {
  result: any;
  forwardedSessionUuid?: string;
  retryableSuspectRefusal?: DeviceSessionSuspectRefusal;
}

/**
 * Forward one tool call. The Tasks relay (#4668) is passed only when the client declared the
 * extension, so every other call reaches the client exactly as before.
 */
function callDaemonTool(
  client: DaemonClientLike,
  call: {
    name: string;
    args: Record<string, unknown>;
    progressToken: string | number | undefined;
    onRequestId: (requestId: string) => void;
    signal: AbortSignal | undefined;
    tasks: TaskRelayFrame | undefined;
  },
): Promise<any> {
  const { name, args, progressToken, onRequestId, signal, tasks } = call;
  return tasks
    ? client.callTool(name, args, progressToken, onRequestId, signal, { tasks })
    : client.callTool(name, args, progressToken, onRequestId, signal);
}

/** The tool name when replaying it could repeat a device action, else undefined. */
function nonIdempotentToolName(name: string): string | undefined {
  return isReplaySafeToolName(name) || isDeviceInventoryTool(name) ? undefined : name;
}

/**
 * Proxy operations a tool-call forward shares with routing, liveness, connection and session-call
 * policy that other proxy paths use too:
 * - hasLivenessLifecycleFence, waitForLivenessRecovery and hasStallHandovers share liveness state.
 * - withFencedControlDeviceSession, ownSessionForPlatformSelector, refuseAmbiguousSessionSelector,
 *   reportToolSessionLoss, prepareToolRoutingArgs and sessionUuidFromArgs share routing policy.
 * - withOneShotCliMarker, withAcceptanceConfiguration and withToolSelectionProfile add the
 *   proxy-owned markers.
 * - beginSessionCall, sessionsUsedByCall and endSessionCall share in-flight session accounting.
 * - requireClient, trackToolCallInFlight and withRecoverableReconnect share the connection.
 * - throwIfForwardedSessionReleasedSince, noteReleaseSurfacedBy and toolUnavailableError share
 *   release and error policy.
 * - deferredToTask and applyForwardedResult share result handling with the Tasks relay.
 * - removeProgressListener shares the progress listener registry.
 */
export interface ToolCallForwarderPort {
  hasLivenessLifecycleFence(): boolean;
  waitForLivenessRecovery(signal?: AbortSignal): Promise<void>;
  hasStallHandovers(): boolean;
  withFencedControlDeviceSession(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown>;
  ownSessionForPlatformSelector(
    name: string,
    args: Record<string, unknown>,
    siblingOnly?: boolean,
  ): string | undefined;
  refuseAmbiguousSessionSelector(name: string, args: Record<string, unknown>): void;
  reportToolSessionLoss(name: string, args: Record<string, unknown>): void;
  prepareToolRoutingArgs(
    name: string,
    callerArgs: Record<string, unknown>,
    isSessionAcquisition: boolean,
  ): { forwardedArgs: Record<string, unknown>; allowReleasedSession: boolean };
  sessionUuidFromArgs(args: Record<string, unknown>): string | undefined;
  withOneShotCliMarker(args: Record<string, unknown>): Record<string, unknown>;
  withAcceptanceConfiguration(args: Record<string, unknown>): Record<string, unknown>;
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown>;
  beginSessionCall(name: string, sessionUuids: readonly string[]): readonly string[];
  sessionsUsedByCall(forwardedSessionUuid: string | undefined): string[];
  endSessionCall(sessionUuids: readonly string[]): void;
  throwIfForwardedSessionReleasedSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): void;
  requireClient(): DaemonClientLike;
  trackToolCallInFlight<T>(client: DaemonClientLike, send: () => Promise<T>): Promise<T>;
  withRecoverableReconnect<T>(
    operation: () => Promise<T>,
    attemptedSessionUuid?: string,
    allowReleasedSession?: boolean,
    fenceSessionNotFoundOnRetry?: boolean,
    nonIdempotentToolName?: string,
    signal?: AbortSignal,
  ): Promise<T>;
  deferredToTask(
    tasks: TaskRelayFrame | undefined,
    result: unknown,
    context: ForwardedResultContext,
  ): boolean;
  applyForwardedResult(
    context: ForwardedResultContext,
    result: any,
  ): ForwardedToolCall | Promise<ForwardedToolCall>;
  noteReleaseSurfacedBy(answer: unknown): void;
  removeProgressListener(client: DaemonClientLike | undefined, requestId: string | undefined): void;
  toolUnavailableError(
    name: string,
    daemonRejection?: string,
    daemonGated?: boolean,
  ): Promise<Error>;
}

export interface ToolCallForwarderDependencies {
  timer: Timer;
  progressListeners: Map<
    DaemonClientLike,
    Map<string, { progressToken: string | number; listener: DaemonProxyProgressCallback }>
  >;
  releaseLedger: Pick<
    ReleaseEpochLedger,
    | "epoch"
    | "retainReleaseEpochReference"
    | "releaseReleaseEpochReference"
    | "retainAcquisitionReleaseEpoch"
    | "releaseAcquisitionReleaseEpoch"
  >;
  heldSessionLosses: Pick<HeldSessionLosses, "reportPlatformLoss">;
  handoverResolution: Pick<HandoverResolution, "resumeStalledSessionNamedBy">;
  sessionBinding: Pick<SessionBinding, "refreshReplayLeaseAfterAdmittedFailure">;
  errorClassifier: Pick<DaemonErrorClassifier, "isUnknownToolError" | "isGatedToolError">;
  port: ToolCallForwarderPort;
}

/**
 * Forwards one routed tool call to the daemon: fences and routes its arguments, sends it with
 * reconnect recovery, applies the result to the proxy's session state and releases what the call
 * held. Moved verbatim from DaemonMcpProxy; behaviour is unchanged.
 */
export class ToolCallForwarder {
  private readonly timer: Timer;
  private readonly progressListeners: ToolCallForwarderDependencies["progressListeners"];
  private readonly releaseLedger: ToolCallForwarderDependencies["releaseLedger"];
  private readonly heldSessionLosses: ToolCallForwarderDependencies["heldSessionLosses"];
  private readonly handoverResolution: ToolCallForwarderDependencies["handoverResolution"];
  private readonly sessionBinding: ToolCallForwarderDependencies["sessionBinding"];
  private readonly errorClassifier: ToolCallForwarderDependencies["errorClassifier"];
  private readonly port: ToolCallForwarderPort;

  constructor(deps: ToolCallForwarderDependencies) {
    this.timer = deps.timer;
    this.progressListeners = deps.progressListeners;
    this.releaseLedger = deps.releaseLedger;
    this.heldSessionLosses = deps.heldSessionLosses;
    this.handoverResolution = deps.handoverResolution;
    this.sessionBinding = deps.sessionBinding;
    this.errorClassifier = deps.errorClassifier;
    this.port = deps.port;
  }

  async forward(
    name: string,
    callerArgs: Record<string, unknown>,
    progressToken: string | number | undefined,
    onProgress: DaemonProxyProgressCallback | undefined,
    signal: AbortSignal | undefined,
    { allowSuspectRetry, tasks }: ToolCallForwardMode,
  ): Promise<ForwardedToolCall> {
    if (this.port.hasLivenessLifecycleFence()) {
      await this.port.waitForLivenessRecovery(signal);
    }
    callerArgs = this.port.withFencedControlDeviceSession(name, callerArgs);
    const platformSelectorArgs = callerArgs;
    const ownSession = this.port.ownSessionForPlatformSelector(name, callerArgs, true);
    if (ownSession !== undefined) {
      callerArgs = { ...callerArgs, sessionUuid: ownSession };
    }
    this.port.refuseAmbiguousSessionSelector(name, callerArgs);
    this.heldSessionLosses.reportPlatformLoss(name, platformSelectorArgs);
    this.port.reportToolSessionLoss(name, callerArgs);
    if (this.port.hasStallHandovers()) {
      await this.handoverResolution.resumeStalledSessionNamedBy(callerArgs);
    }
    // Device-session acquisition (including booted provisionDevice) mints a NEW
    // session in its RESULT and is never routed to — or fenced by — the connection's
    // bound session: it must be admitted even on a terminally fenced connection so
    // the client can recover in-band (issue #5689). Forward its raw args and bind
    // the minted session from the result afterwards.
    const isSessionAcquisition = isDeviceSessionAcquisitionTool(name);
    // An omitted `sessionUuid` on the control tool means the connection profile,
    // not the proxy's retained device-routing session. Preserve that distinction
    // after a device has been bound.
    const { forwardedArgs: routedArgs, allowReleasedSession } = this.port.prepareToolRoutingArgs(
      name,
      callerArgs,
      isSessionAcquisition,
    );
    const forwardedArgs = this.port.withOneShotCliMarker(
      this.port.withAcceptanceConfiguration(routedArgs),
    );
    const forwardedSessionUuid = this.port.sessionUuidFromArgs(forwardedArgs);
    this.releaseLedger.retainReleaseEpochReference(forwardedSessionUuid);
    // Snapshot the release epoch at forward time. If a session-released signal for
    // the SPECIFIC forwarded UUID lands WHILE this call is in flight, that UUID's
    // recorded epoch advances past this snapshot and the completion path below
    // declines to resurrect the released UUID (issue #4611/#4655). A release of an
    // UNRELATED session bumps the global epoch but not the forwarded UUID's entry,
    // so it does not block remembering the session this call forwarded.
    const callReleaseEpoch = this.releaseLedger.epoch;
    const learnsResultSession = ["setActiveDevice", ...DEVICE_SESSION_ACQUISITION_TOOLS].includes(
      name,
    );
    this.releaseLedger.retainAcquisitionReleaseEpoch(learnsResultSession, callReleaseEpoch);
    let registeredRequestId: string | undefined;
    let registeredClient: DaemonClientLike | undefined;
    const trackedSessionUuids = this.port.beginSessionCall(
      name,
      this.port.sessionsUsedByCall(forwardedSessionUuid),
    );
    try {
      const forwarding = this.port.withRecoverableReconnect(
        () => {
          signal?.throwIfAborted();
          this.port.throwIfForwardedSessionReleasedSince(forwardedArgs, callReleaseEpoch);
          const client = this.port.requireClient();
          return this.port.trackToolCallInFlight(client, () =>
            callDaemonTool(client, {
              name,
              args: this.port.withToolSelectionProfile(forwardedArgs),
              progressToken,
              onRequestId: (requestId) => {
                this.port.removeProgressListener(registeredClient, registeredRequestId);
                registeredClient = client;
                registeredRequestId = requestId;
                if (progressToken !== undefined && onProgress) {
                  let listeners = this.progressListeners.get(client);
                  if (!listeners) {
                    listeners = new Map();
                    this.progressListeners.set(client, listeners);
                  }
                  listeners.set(requestId, { progressToken, listener: onProgress });
                }
              },
              signal,
              tasks,
            }),
          );
        },
        forwardedSessionUuid,
        // Acquisition is admitted while fenced; the terminal fence is cleared once
        // the result-minted session establishes a fresh binding.
        allowReleasedSession,
        true,
        nonIdempotentToolName(name),
        signal,
      );
      // Connection recovery is shared with siblings; cancel this wait and fence
      // replay without aborting the shared connection attempt.
      const result = await raceWithDeadline(forwarding, {
        timer: this.timer,
        signal,
        label: `Daemon tool ${name}`,
      });
      const context: ForwardedResultContext = {
        name,
        callerArgs,
        forwardedArgs,
        forwardedSessionUuid,
        callReleaseEpoch,
        isSessionAcquisition,
        learnsResultSession,
        allowSuspectRetry,
      };
      if (this.port.deferredToTask(tasks, result, context)) {
        return { result, forwardedSessionUuid };
      }
      // A result that binds nothing is applied synchronously, as the call always has been.
      const applied = this.port.applyForwardedResult(context, result);
      return applied instanceof Promise ? await applied : applied;
    } catch (error) {
      signal?.throwIfAborted();
      // A fence raised while this call was in flight names the session it lost: the caller is told.
      this.port.noteReleaseSurfacedBy(error);
      // The success-only rememberSessionUuid above never runs when the handler
      // rejects, but an admitted-then-rejected call still reached
      // getOrCreateSession() and refreshed the LIVE daemon session. Without
      // refreshing the replay lease here too, repeated admitted-but-failed calls
      // let the proxy lease silently expire while the daemon session stays alive,
      // so a later reconnect can no longer replay it (issue #4610).
      this.sessionBinding.refreshReplayLeaseAfterAdmittedFailure(
        name,
        forwardedArgs,
        error,
        callReleaseEpoch,
      );
      // Do NOT clear the binding on a rejected executePlan. A plan can reject
      // *before* the handler runs — tool-selection enforcement or schema parsing in
      // src/server/index.ts — in which case DefaultPlanLifecycleManager
      // .afterExecution() never runs and the daemon session stays LIVE. Forgetting
      // it here would strand a still-live session after a reconnect. The binding is
      // now cleared authoritatively by the daemon's session-released signal
      // (handleDaemonNotification) whenever the session is *actually* released —
      // whether the plan succeeded or failed inside the handler (issue #4610).
      // withRecoverableReconnect already reconciled build identity and retried once.
      // A still-"Unknown tool" failure means the daemon genuinely cannot provide a
      // tool this frontend advertises — surface an actionable error naming both
      // builds instead of the opaque -32603.
      if (this.errorClassifier.isUnknownToolError(error)) {
        throw await this.port.toolUnavailableError(
          name,
          errorMessage(error),
          this.errorClassifier.isGatedToolError(error),
        );
      }
      throw error;
    } finally {
      this.port.endSessionCall(trackedSessionUuids);
      this.releaseLedger.releaseReleaseEpochReference(forwardedSessionUuid);
      this.releaseLedger.releaseAcquisitionReleaseEpoch(learnsResultSession, callReleaseEpoch);
      this.port.removeProgressListener(registeredClient, registeredRequestId);
    }
  }
}
