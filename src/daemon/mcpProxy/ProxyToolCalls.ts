import { ActionableError } from "../../models";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { getRemovedToolHint } from "../../utils/removedTools";
import {
  type BuildIdentity,
  buildIdentitiesMatch,
  buildIdentityFromStatus,
} from "../wire/buildIdentity";
import { type DaemonClientLike } from "../client/client";
import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_ONE_SHOT_CLI_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
  INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
  INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM,
} from "../wire/constants";
import {
  type DeviceSessionSuspectRefusal,
  declaresDeviceSessionSuspect,
  isDeviceBindingTool,
  isDeviceSessionAcquisitionTool,
  readDeviceCleanupInProgressRefusal,
  readDeviceSessionSuspectRefusal,
} from "../deviceSessionResult";
import { DeviceCleanupWait } from "../proxy/DeviceCleanupWait";
import { type ForwardedToolCall, type ToolCallForwardMode } from "../proxy/ToolCallForwarder";
import { DaemonBoundSessionExpiredError, DaemonToolUnavailableError } from "../proxy/daemonErrors";
import { DAEMON_STALLED_CODE, livenessResumedNotice } from "../proxyLivenessRecovery";
import { isCreateTaskResult } from "../tasks/mcpTasksExtension";
import type { TaskRelayFrame, TaskRelayMethod } from "../tasks/taskRelay";
import { DAEMON_TOOL_UNAVAILABLE_CODE } from "../types";
import {
  DaemonProxyProgressCallback,
  DaemonProxyToolCallOptions,
  isSuspectRefusalRetryable,
  isUnprovenSessionAdmissionError,
  withResumedNotice,
} from "./ProxyContracts";
import type { ProxyRuntime } from "./ProxyRuntime";
/** Operations supplied by the proxy's composition root. */
export interface ProxyToolCallsPort {
  untilClosed(signal: AbortSignal | undefined): AbortSignal;
  requireClient(): DaemonClientLike;
  boundSessionExpiredError(namedSessionUuid?: string): DaemonBoundSessionExpiredError;
  heartbeatRequestTimeoutMs(): number;
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown>;
  trackToolCallInFlight<T>(client: DaemonClientLike, send: () => Promise<T>): Promise<T>;
  sessionUuidFromArgs(args: Record<string, unknown>): string | undefined;
  shouldSkipLeaseRefreshForDeviceControlTransportError(error: unknown): boolean;
}

type Runtime = Pick<
  ProxyRuntime,
  | "brokerSessions"
  | "buildIdentity"
  | "closing"
  | "config"
  | "connectionRecovery"
  | "daemonManager"
  | "discovery"
  | "errorClassifier"
  | "finalizedRecordingOwners"
  | "forwardedResultApplier"
  | "initialSessionAwaitingFirstCall"
  | "latestBindingKeeper"
  | "livenessRecovery"
  | "mintedTaskOwnerKey"
  | "resumedStallNotices"
  | "staticToolDefinitionsProvider"
  | "terminalBoundSession"
  | "timer"
  | "toolCallForwarder"
>;

/** ToolCalls operations on a single proxy runtime. */
export class ProxyToolCalls {
  constructor(
    private readonly runtime: Runtime,
    private readonly port: ProxyToolCallsPort,
  ) {}

  /** Test-only seam for building a tool-unavailable error. */
  buildToolUnavailableErrorForTesting(
    name: string,
    daemonRejection?: string,
    daemonGated = false,
  ): Promise<Error> {
    return this.toolUnavailableError(name, daemonRejection, daemonGated);
  }

  /**
   * Call a tool on the daemon. `progressToken` echoes the external MCP
   * client's own `params._meta.progressToken` (issue #6205); when present it
   * is forwarded to the daemon so `notifications/progress` ticks relayed back
   * over the socket can be routed to `onProgress`, tagged with that SAME
   * token. Omit both to request no progress relay — nothing is fabricated.
   *
   * A call the daemon refuses because a session this proxy holds is suspect is forwarded once
   * more after the liveness recovery the refusal starts has settled, so the client gets that
   * call's result, or the handover/loss error recovery left behind, instead of the refusal.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    progressToken?: string | number,
    onProgress?: DaemonProxyProgressCallback,
    options: DaemonProxyToolCallOptions = {},
  ): Promise<any> {
    this.refuseBrokerGenericAcquisition(name);
    const signal = this.port.untilClosed(options.signal);
    const tasks = this.taskRelayForToolCall(name, options.declaresTasks === true);
    let first = await this.forwardToolCall(name, args, progressToken, onProgress, {
      allowSuspectRetry: true,
      tasks,
      signal,
    });
    if (isDeviceBindingTool(name)) {
      first = await new DeviceCleanupWait({
        timer: this.runtime.timer,
        budgetMs: this.runtime.config.cleanupWaitBudgetMs,
        backoff: this.runtime.config.cleanupWaitBackoff,
      }).waitOut(
        first,
        name,
        {
          readCleanupRefusal: readDeviceCleanupInProgressRefusal,
          isClosing: () => this.runtime.closing,
          reforward: () =>
            this.forwardToolCall(name, args, progressToken, onProgress, {
              allowSuspectRetry: false,
              signal,
            }),
        },
        signal,
      );
    }
    const refusal = first.retryableSuspectRefusal;
    if (!refusal || !(await this.awaitSuspectSessionRecovery(refusal, signal))) {
      return this.withPendingResumedNotice(first.forwardedSessionUuid, first.result);
    }
    // Exactly one retry: the refused call never reached its handler (isSuspectRefusalRetryable).
    // The retry's own pre-forward checks surface a handover or loss recovery recorded.
    logger.info(`[DaemonMcpProxy] Session ${refusal.sessionUuid} restored; retrying ${name} once`);
    const retried = await this.forwardToolCall(name, args, progressToken, onProgress, {
      allowSuspectRetry: false,
      tasks,
      signal,
    });
    return this.withPendingResumedNotice(retried.forwardedSessionUuid, retried.result);
  }

  /** The task owner key this proxy's MCP tasks are created and looked up under (#4668). */
  taskOwnerKey(): string {
    this.runtime.mintedTaskOwnerKey ??= `proxy-tasks:${(this.runtime.config.idGenerator ?? defaultIdGenerator).next()}`;
    return this.runtime.mintedTaskOwnerKey;
  }

  /**
   * The Tasks relay for a `tools/call` whose client declared the extension (#4668). A
   * device-binding call is relayed too: when the daemon answers it with a task, the session it
   * binds is bound from the completed task's result (`ForwardedResultApplier.taskBindings`).
   */
  taskRelayForToolCall(name: string, declared: boolean): TaskRelayFrame | undefined {
    return declared ? { ownerKey: this.taskOwnerKey(), declared: true } : undefined;
  }

  /**
   * Relay `tasks/get`, `tasks/update` or `tasks/cancel` (#4668) to the daemon under this proxy's
   * task owner key. The daemon answers from its task store, so a task survives a daemon restart
   * (a restarted daemon reports one it was running as failed); a lost connection is reconnected
   * and the request asked once more. A task touches no session of this proxy, so neither a
   * liveness recovery nor a fenced binding holds the request back. The daemon's JSON-RPC error
   * rejects carrying it as `jsonRpcError`.
   */
  async relayTaskMethod(
    method: TaskRelayMethod,
    params: Record<string, unknown>,
    declared: boolean,
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const signal = this.port.untilClosed(callerSignal);
    signal.throwIfAborted();
    const tasks: TaskRelayFrame = { ownerKey: this.taskOwnerKey(), declared };
    const forwarding = this.runtime.connectionRecovery.withRecoverableReconnect(
      () => {
        const client = this.port.requireClient();
        if (!client.relayTaskMethod) {
          throw new ActionableError(`The daemon client cannot relay ${method}`);
        }
        return client.relayTaskMethod(method, params, tasks, { signal });
      },
      undefined,
      true,
      true,
      { signal },
    );
    const answer = raceWithDeadline(forwarding, {
      timer: this.runtime.timer,
      signal,
      label: `Daemon ${method}`,
    });
    return this.runtime.forwardedResultApplier.deviceBindingTasks
      ? this.runtime.forwardedResultApplier.deviceBindingTasks.relayed(method, params, answer)
      : answer;
  }

  refuseBrokerGenericAcquisition(name: string): void {
    if (!this.runtime.brokerSessions.result || !isDeviceSessionAcquisitionTool(name)) {
      return;
    }
    const terminal = this.runtime.terminalBoundSession;
    if (terminal && this.runtime.brokerSessions.sessions.has(terminal.sessionUuid)) {
      throw this.port.boundSessionExpiredError();
    }
    throw new ActionableError(
      `Tool ${name} cannot acquire a generic device on a session-broker connection. ` +
        `Use the exact bound session ${this.runtime.brokerSessions.result.sessionUuid ?? "reported by initialize"}.`,
    );
  }

  /**
   * The first call to reach a session resumed after a `daemon_stalled` handover carries the
   * warning that it resumed, so the harness can disregard the handover it was told about (#10989).
   */
  withPendingResumedNotice(sessionUuid: string | undefined, result: unknown): unknown {
    const pending = sessionUuid ? this.runtime.resumedStallNotices.get(sessionUuid) : undefined;
    // A task handle carries no content to warn in; the next ordinary result does (#4668).
    if (!sessionUuid || !pending || isCreateTaskResult(result)) {
      return result;
    }
    this.runtime.resumedStallNotices.delete(sessionUuid);
    return withResumedNotice(
      result,
      livenessResumedNotice(pending.handover, sessionUuid, pending.restart),
    );
  }

  /**
   * Wait for the recovery a suspect refusal started, bounded by the time the daemon keeps the
   * session reserved plus one heartbeat request. True when the session is held and no longer
   * recovering, so the refused call may be forwarded once more; an abort rejects.
   */
  async awaitSuspectSessionRecovery(
    refusal: DeviceSessionSuspectRefusal,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const timeoutMs = Math.max(0, refusal.remainingMs) + this.port.heartbeatRequestTimeoutMs();
    try {
      await raceWithDeadline(this.runtime.livenessRecovery.settled(), {
        timer: this.runtime.timer,
        timeoutMs,
        signal,
        label: "Suspect session recovery",
      });
    } catch (error) {
      signal?.throwIfAborted();
      // Another session's recovery can outlast the bound; this session's own state decides below.
      logger.warn(
        `[DaemonMcpProxy] Liveness recovery did not settle within ${timeoutMs}ms after session ${refusal.sessionUuid} was refused as suspect`,
        error,
      );
    }
    return (
      !this.runtime.closing && !this.runtime.livenessRecovery.isRecovering(refusal.sessionUuid)
    );
  }

  async forwardToolCall(
    name: string,
    args: Record<string, unknown>,
    progressToken: string | number | undefined,
    onProgress: DaemonProxyProgressCallback | undefined,
    mode: ToolCallForwardMode,
  ): Promise<ForwardedToolCall> {
    const { signal } = mode;
    signal?.throwIfAborted();
    // From the first tool call on, a refused claim of the initial binding is leashed as usual.
    this.runtime.initialSessionAwaitingFirstCall = false;
    // These are daemon-internal routing markers. Never accept caller-controlled
    // values: only this proxy may add them after selecting its active binding.
    const callerArgs = { ...args };
    delete callerArgs[DAEMON_BOUND_SESSION_PARAM];
    delete callerArgs[DAEMON_OWNED_SESSIONS_PARAM];
    delete callerArgs[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM];
    delete callerArgs[DAEMON_RELEASED_SESSION_PARAM];
    delete callerArgs[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    delete callerArgs[DAEMON_ONE_SHOT_CLI_PARAM];
    delete callerArgs[INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM];
    delete callerArgs[INTERNAL_ACTIONS_COMPACT_METADATA_PARAM];
    // The acceptance controls are configuration of the dedicated harness proxy,
    // never client-provided tool arguments. Remove both before routing so a
    // caller cannot forge or override that configuration.
    delete callerArgs[INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM];
    delete callerArgs[INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM];
    const retrievalOwner = this.runtime.finalizedRecordingOwners.retrievalOwner(name, callerArgs);
    if (retrievalOwner !== undefined) {
      return this.forwardFinalizedRecordingRetrieval(
        name,
        callerArgs,
        retrievalOwner,
        progressToken,
        signal,
      );
    }
    return this.runtime.toolCallForwarder.forward(
      name,
      callerArgs,
      progressToken,
      onProgress,
      mode,
    );
  }

  /**
   * Forward a finalized-recording retrieval. It names the starting session only so the daemon can
   * scope the lookup: like every read it never binds, holds, heartbeats or extends that session.
   */
  async forwardFinalizedRecordingRetrieval(
    name: string,
    callerArgs: Record<string, unknown>,
    ownerSessionUuid: string,
    progressToken: string | number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ForwardedToolCall> {
    // Artifact lookup only reaches a resumed session when its owner is still held.
    const forwardedSessionUuid = this.runtime.latestBindingKeeper.isHeldSession(ownerSessionUuid)
      ? ownerSessionUuid
      : undefined;
    const forwardedArgs = this.withOneShotCliMarker(
      this.withAcceptanceConfiguration(
        this.port.withToolSelectionProfile({ ...callerArgs, sessionUuid: ownerSessionUuid }),
      ),
    );
    const result = await raceWithDeadline(
      this.runtime.connectionRecovery.withRecoverableReconnect(
        () => {
          signal?.throwIfAborted();
          const client = this.port.requireClient();
          return this.port.trackToolCallInFlight(client, () =>
            client.callTool(name, forwardedArgs, progressToken, undefined, { signal }),
          );
        },
        undefined,
        true,
        false,
        { signal },
      ),
      { timer: this.runtime.timer, signal, label: `Daemon tool ${name}` },
    );
    return { result, forwardedSessionUuid };
  }

  withOneShotCliMarker(args: Record<string, unknown>): Record<string, unknown> {
    return this.runtime.config.oneShotCli ? { ...args, [DAEMON_ONE_SHOT_CLI_PARAM]: true } : args;
  }

  withAcceptanceConfiguration(args: Record<string, unknown>): Record<string, unknown> {
    const acceptanceDiscovery = this.runtime.config.acceptanceDiscovery;
    if (!acceptanceDiscovery) {
      return args;
    }
    return {
      ...args,
      [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: acceptanceDiscovery.order,
      [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: acceptanceDiscovery.capability,
    };
  }

  /**
   * The daemon refused a tool call because the session is suspect: its owner can still restore it.
   * Returns the refusal when the call may be forwarded once more after that recovery.
   */
  noteSuspectSessionResult(
    name: string,
    result: unknown,
    forwardedArgs: Record<string, unknown>,
    allowRetry: boolean,
  ): DeviceSessionSuspectRefusal | undefined {
    const sessionUuid = this.port.sessionUuidFromArgs(forwardedArgs);
    if (
      !sessionUuid ||
      !this.runtime.latestBindingKeeper.isHeldSession(sessionUuid) ||
      !declaresDeviceSessionSuspect(result)
    ) {
      return undefined;
    }
    logger.warn(`[DaemonMcpProxy] Session ${sessionUuid} is suspect; re-heartbeating it now`);
    this.runtime.livenessRecovery.begin(sessionUuid, DAEMON_STALLED_CODE);
    const refusal = readDeviceSessionSuspectRefusal(result);
    return allowRetry &&
      refusal &&
      isSuspectRefusalRetryable(name, sessionUuid, refusal) &&
      this.runtime.livenessRecovery.isRecovering(sessionUuid)
      ? refusal
      : undefined;
  }

  /** A rejection proving the call never reached the handler with a live session. */
  failureNeverReachedLiveSession(error: unknown): boolean {
    return (
      isUnprovenSessionAdmissionError(error) ||
      this.runtime.errorClassifier.isRecoverableDaemonSessionError(error) ||
      this.runtime.errorClassifier.isPreDispatchDaemonSessionError(error) ||
      this.port.shouldSkipLeaseRefreshForDeviceControlTransportError(error)
    );
  }

  async toolUnavailableError(
    name: string,
    daemonRejection?: string,
    daemonGated = false,
  ): Promise<Error> {
    let daemonIdentity: BuildIdentity = { entryScript: "", buildId: "unknown" };
    try {
      const status = await this.runtime.daemonManager.status();
      daemonIdentity = buildIdentityFromStatus(status);
    } catch (error) {
      logger.warn(
        `[DaemonMcpProxy] Failed to read daemon status for tool-unavailable error: ${error}`,
      );
    }
    if (!this.frontendRegistersTool(name)) {
      if (daemonGated && daemonRejection !== undefined) {
        // The daemon registers a tool this frontend has never heard of (a newer
        // daemon); its rejection already carries the gate reason.
        return Object.assign(new Error(daemonRejection), { code: DAEMON_TOOL_UNAVAILABLE_CODE });
      }
      const hint = getRemovedToolHint(name);
      return new Error(`Unknown tool "${name}".${hint ? ` ${hint}` : ""}`);
    }
    return new DaemonToolUnavailableError({
      toolName: name,
      client: this.runtime.buildIdentity,
      daemon: daemonIdentity,
      // A gate is daemon configuration, not skew: whatever the build identities say,
      // never tell the caller to restart the daemon for it.
      buildMismatch: daemonGated
        ? false
        : !buildIdentitiesMatch(this.runtime.buildIdentity, daemonIdentity),
      daemonRejection,
      gated: daemonGated,
    });
  }

  frontendRegistersTool(name: string): boolean {
    const found =
      this.runtime.discovery.tools?.find((definition) => definition.name === name) ??
      this.runtime.staticToolDefinitionsProvider().find((definition) => definition.name === name);
    return !!found;
  }
}
