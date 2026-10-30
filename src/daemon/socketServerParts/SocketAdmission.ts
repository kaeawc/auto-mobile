import { STARTUP_PROBE_METHODS } from "../ideRoutes";

import { DISPATCH_HELD_INPUT_METHODS } from "../inputRoutes";

import { Socket } from "node:net";

import { logger } from "../../utils/logger";

import { ProgressExtendableDeadline } from "../mcpRequestTimeout";
import { createRequestContext, type RequestContext } from "../requestContext";
import {
  McpOverloadError,
  McpTimeoutError,
  MCP_QUEUE_TIMEOUT_ERROR_CODE,
} from "../wire/McpTimeoutError";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  DAEMON_SESSION_NOT_FOUND_CODE,
  DaemonRequest,
  DaemonResponse,
  RESOURCE_SUBSCRIBE_METHOD,
  RESOURCE_UNSUBSCRIBE_METHOD,
  SessionContext,
} from "../types";
import {
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  DAEMON_CANCEL_REQUEST_METHOD,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
} from "../wire/constants";
import { resolveSocketAdmissionLane } from "../socketRequestAdmission";
import {
  daemonShuttingDownFailure,
  daemonShuttingDownFrameFields,
  daemonShuttingDownFailureFromToolResult,
  isDaemonShuttingDownToolResult,
} from "../daemonShutdownOutcome";

import { handleDaemonRequest } from "../daemonRequestHandlers";

import { provisionCancellationOutcomes } from "../provisionCancellationOutcomes";
import { PROVISION_DEVICE_SETTLEMENT_WAIT_MS } from "../../features/deviceLifecycle/deviceLifecycleCore";

import { ActionableError } from "../../models/ActionableError";

import { mcpRequestFailureDetails, requestFailureCause } from "../socketServer/errorFrames";

import { isTaskRelayMethod } from "../tasks/taskRelay";
import { taskRelayErrorFrame } from "../socketServer/taskRelayForward";

import { SessionReleasedDuringCallError } from "../sessionReleasedDuringCall";

import { InputTypeTextAppendError } from "../socketServer/inputTypeTextAppendError";
import {
  PROVISION_CANCELLATION_OUTCOME_GRACE_MS,
  MCP_FORWARD_START_HEADROOM_MS,
  MCP_OVERLOAD_RETRY_AFTER_MS,
  isClientForwardCancellation,
  logRequestFailureCause,
} from "./socketServerContracts";
import { ClientRequestCancellation } from "./ClientRequestCancellation";

import { ReleasedBoundSessionError } from "./ReleasedBoundSessionError";
import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations } from "./socketServerOperations";
type State = Pick<
  SocketServerRuntime,
  | "timer"
  | "sessions"
  | "acceptingRequests"
  | "notificationSubscribers"
  | "daemonState"
  | "onFrameTrace"
  | "forwardedCallKeys"
  | "startupCompletion"
  | "startupCompleted"
>;
type Callbacks = Pick<
  SocketServerOperations,
  | "shuttingDownBeforeStartResponse"
  | "rejectOnHandshakeMismatch"
  | "withCanonicalToolCallDeviceIds"
  | "handleResourceSubscription"
  | "unqueuedRequest"
  | "registerRequestCancellation"
  | "socketAdmissionCancellation"
  | "waitForStartup"
  | "runLocalSocketRequest"
  | "restoreSelectorSessions"
  | "beginMcpSessionOwnerCall"
  | "getMcpForwardRoute"
  | "mcpRequestSignal"
  | "runMcpForwardForCurrentRoute"
  | "requireRemainingMcpForwardBudget"
  | "describeMcpForwardRequest"
  | "wasRequestSessionActive"
  | "forwardMcpRequest"
  | "isMcpRequestOwnerCurrent"
  | "recordBoundMcpClientKey"
  | "remainingMcpForwardBudget"
  | "mcpForwardFailureResponse"
  | "frameDeviceId"
  | "traceFrame"
  | "isProvisionDeviceCall"
  | "runProvisionBarrier"
  | "runCancellableInputHandler"
  | "runCancellableQueuedHandler"
  | "provisionCancellationReply"
  | "cancelSocketRequest"
  | "relayTaskRequest"
  | "sharedMcpForwardRoute"
  | "trackRequestHandler"
>;
interface AdmittedSocketRequest {
  request: DaemonRequest;
  sessionId: string;
  ownerSocket: Socket;
  receivedAtMs: number;
  context: RequestContext;
  cancellation: { signal: AbortSignal };
  onInputDispatch: () => void;
}

/** The admission hook and receipt context of one socket request. */
export interface SocketRequestHandling {
  onAdmitted?: (deadline: ProgressExtendableDeadline) => void;
  /** Defaults to a context created from the request at `receivedAtMs`. */
  context?: RequestContext;
}

function requestHandlingContext(
  handling: SocketRequestHandling | undefined,
  request: DaemonRequest,
  sessionId: string,
  receivedAtMs: number,
): RequestContext {
  return handling?.context ?? createRequestContext(request, sessionId, receivedAtMs);
}

/** Socket Admission over shared connection state and explicit callbacks. */
export class SocketAdmission {
  constructor(
    private readonly state: State,
    private readonly resolveCallbacks: () => Callbacks,
  ) {}
  private get callbacks(): Callbacks {
    return this.resolveCallbacks();
  }
  /**
   * Handle a request from a client
   */
  async handleRequest(
    sessionId: string,
    ownerSocket: Socket,
    request: DaemonRequest,
    {
      receivedAtMs = this.state.timer.now(),
      handling,
    }: { receivedAtMs?: number; handling?: SocketRequestHandling } = {},
  ): Promise<DaemonResponse | undefined> {
    const context = requestHandlingContext(handling, request, sessionId, receivedAtMs);
    const session = this.state.sessions.get(sessionId);
    if (!session) {
      return {
        id: request.id,
        type: "mcp_response",
        success: false,
        error: "Session not found",
        code: DAEMON_SESSION_NOT_FOUND_CODE,
      };
    }
    if (!this.state.acceptingRequests) {
      return this.callbacks.shuttingDownBeforeStartResponse(request);
    }
    const handshakeError = this.callbacks.rejectOnHandshakeMismatch(request);
    if (handshakeError) {
      return handshakeError;
    }
    request = this.callbacks.withCanonicalToolCallDeviceIds(request);
    // Notification opt-in is per-socket-session state owned here, not by the
    // daemon request handlers — answer immediately without queueing (issue #3223).
    if (request.method === DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD) {
      this.state.notificationSubscribers.add(sessionId);
      return {
        id: request.id,
        type: "mcp_response",
        success: true,
        result: { subscribed: true },
      };
    }
    // Socket subscriptions must not attach to shared/idle-evicted loopback MCP clients.
    if ([RESOURCE_SUBSCRIBE_METHOD, RESOURCE_UNSUBSCRIBE_METHOD].includes(request.method)) {
      return this.callbacks.handleResourceSubscription(sessionId, request);
    }
    // Bound-session keepalive must never wait behind an in-flight tools/call on the same
    // socket: a queued heartbeat can lose the race with the session's heartbeat-timeout
    // during a long unattributed acquisition (e.g. startDevice for a second device), and the
    // session gets reaped out from under a still-live client (issue #6135). It touches only
    // SessionManager's heartbeat bookkeeping, so answering it out-of-band here does not
    // reorder anything tool calls observe.
    if (request.method === DAEMON_HEARTBEAT_METHOD) {
      const daemonResponse = await handleDaemonRequest(request, this.state.daemonState);
      return {
        id: request.id,
        type: "mcp_response",
        ...daemonResponse,
      };
    }
    const unqueued = this.callbacks.unqueuedRequest(session, ownerSocket, request, context);
    if (unqueued) {
      return unqueued;
    }
    const { totalTimeoutMs, deadline } = context;
    const cancellation = this.callbacks.registerRequestCancellation(session, context);
    const admissionCancellation = this.callbacks.socketAdmissionCancellation(
      request,
      sessionId,
      ownerSocket,
      cancellation.signal,
    );
    let onInputDispatch: (() => void) | undefined;
    const handler = () =>
      this.runAdmittedRequest({
        request,
        sessionId,
        ownerSocket,
        receivedAtMs,
        context,
        cancellation,
        onInputDispatch: () => onInputDispatch?.(),
      });
    // Admit through the socket's queue: same-lane requests keep arrival order, while an
    // explicit-device call does not wait behind another device's call (issue #6387).
    const deviceId = this.state.onFrameTrace ? this.callbacks.frameDeviceId(request) : undefined;
    if (this.state.onFrameTrace) {
      this.callbacks.traceFrame("admission_requested", request.id, { deviceId });
    }
    return session.requestQueue
      .run<DaemonResponse | undefined>(
        resolveSocketAdmissionLane(request),
        () => {
          // Same predicate as the entry check: a request still queued when quiesce() began
          // has not started, so it is refused as provably undispatched rather than admitted
          // mid-shutdown. close() also clears acceptingRequests, so this covers both stages.
          if (!this.state.acceptingRequests) {
            return Promise.resolve(this.callbacks.shuttingDownBeforeStartResponse(request));
          }
          handling?.onAdmitted?.(deadline);
          if (this.state.onFrameTrace) {
            this.callbacks.traceFrame("admission_granted", request.id, { deviceId });
          }
          // A cancelled provisionDevice is answered by its handler (after a bounded wait for the
          // typed cancellation result), not by this race, which would reply at once (#11074).
          // provisionDevice is a barrier, so a cancel must release it at once: its typed
          // cancellation reply is awaited outside the barrier below (#11092).
          // Held input routes release admission immediately if cancelled before their first send;
          // after that synchronous latch its handler answers after the bounded hold.
          return this.callbacks.isProvisionDeviceCall(request)
            ? this.callbacks.runProvisionBarrier(handler, cancellation.signal, () =>
                this.callbacks.mcpForwardFailureResponse({
                  error: cancellation.signal.reason,
                  request,
                  sessionId,
                  ownerSocket,
                  signal: cancellation.signal,
                }),
              )
            : DISPATCH_HELD_INPUT_METHODS.has(request.method)
              ? this.callbacks.runCancellableInputHandler((onDispatch) => {
                  onInputDispatch = onDispatch;
                  return handler();
                }, admissionCancellation.signal)
              : this.callbacks.runCancellableQueuedHandler(handler, cancellation.signal);
        },
        {
          timer: this.state.timer,
          deadlineMs: deadline.value,
          signal: admissionCancellation.signal,
          timeoutError: (sameLaneWait) =>
            new McpTimeoutError({
              toolName:
                request.method === "tools/call"
                  ? (request.params?.name ?? request.method)
                  : request.method,
              timeoutMs: totalTimeoutMs,
              origin: "UnixSocketServer.handleRequest",
              code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
              detail: sameLaneWait
                ? `timed out in queue (waiting in queue for ${resolveSocketAdmissionLane(request)})`
                : "timed out in queue before admission",
            }),
        },
      )
      .then(async (response) =>
        response && !response.success
          ? ((await this.callbacks.provisionCancellationReply(
              request,
              response,
              cancellation.signal.aborted ? cancellation.signal : context.owner.signal,
            )) ?? response)
          : response,
      )
      .finally(() => {
        admissionCancellation.dispose();
        cancellation.dispose();
      });
  }
  /** A request answered without waiting in the socket's admission queue, if this is one. */
  unqueuedRequest(
    session: SessionContext,
    ownerSocket: Socket,
    request: DaemonRequest,
    context: RequestContext,
  ): DaemonResponse | Promise<DaemonResponse | undefined> | undefined {
    // Must bypass the queue: queued, it would wait behind the very request it cancels.
    if (request.method === DAEMON_CANCEL_REQUEST_METHOD) {
      return this.callbacks.cancelSocketRequest(session, request);
    }
    // Task polling touches no device and must not wait behind this socket's other calls (#4668).
    if (isTaskRelayMethod(request.method)) {
      return this.callbacks.relayTaskRequest(session, ownerSocket, request, context);
    }
    return undefined;
  }
  /**
   * Relays a `tasks/*` request (#4668) outside the socket's admission queue: it reads or cancels a
   * stored task and touches no device, so a poll never waits behind a long call on the same
   * socket. The daemon MCP server's JSON-RPC error is carried on the frame unchanged.
   */
  async relayTaskRequest(
    session: SessionContext,
    ownerSocket: Socket,
    request: DaemonRequest,
    context: RequestContext,
  ): Promise<DaemonResponse | undefined> {
    const sessionId = session.sessionId;
    const cancellation = this.callbacks.registerRequestCancellation(session, context);
    const mcpRequest = this.callbacks.mcpRequestSignal(sessionId, ownerSocket, cancellation.signal);
    try {
      await this.callbacks.waitForStartup(request, context.deadline, mcpRequest.signal);
      const result = await this.callbacks.forwardMcpRequest({
        request,
        route: this.callbacks.sharedMcpForwardRoute(`method:${request.method}`),
        socketSessionId: sessionId,
        signal: mcpRequest.signal,
        totalTimeoutMs: context.totalTimeoutMs,
        deadline: context.deadline,
      });
      return { id: request.id, type: "mcp_response", success: true, result };
    } catch (error) {
      return (
        taskRelayErrorFrame(error, request) ??
        this.callbacks.mcpForwardFailureResponse({
          error,
          request,
          sessionId,
          ownerSocket,
          signal: mcpRequest.signal,
        })
      );
    } finally {
      mcpRequest.dispose();
      cancellation.dispose();
    }
  }
  /**
   * Runs the provisionDevice handler inside the admission barrier but gives the barrier back as
   * soon as the caller cancels, answering with [cancelledReply]. The handler keeps rolling back in
   * the background; its typed outcome is awaited by the caller of the barrier, not inside it.
   */
  runProvisionBarrier(
    handler: () => Promise<DaemonResponse | undefined>,
    cancelSignal: AbortSignal,
    cancelledReply: () => DaemonResponse | undefined,
  ): Promise<DaemonResponse | undefined> {
    const operation = handler();
    this.callbacks.trackRequestHandler(
      operation.then(
        () => {},
        () => {},
      ),
    );
    return new Promise((resolve, reject) => {
      const onAbort = () => resolve(cancelledReply());
      if (cancelSignal.aborted) {
        onAbort();
      } else {
        cancelSignal.addEventListener("abort", onAbort, { once: true });
      }
      operation
        .then(resolve, reject)
        .finally(() => cancelSignal.removeEventListener("abort", onAbort));
    });
  }
  /** Retryable refusal for a request that has not started work (no `requestMayHaveDispatched`). */
  shuttingDownBeforeStartResponse(request: DaemonRequest): DaemonResponse {
    return {
      id: request.id,
      type: "mcp_response",
      success: false,
      error: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
      ...daemonShuttingDownFrameFields(daemonShuttingDownFailure()),
    };
  }
  /**
   * `provisionDevice` finishes its rollback after a caller abort and builds a typed
   * `request_cancelled` result with `recovery` evidence. Wait a bounded time for it so the reply to
   * the abandoned request carries it instead of the generic abandonment error (#11074).
   */
  isProvisionDeviceCall(request: DaemonRequest): boolean {
    return request.method === "tools/call" && request.params?.name === "provisionDevice";
  }
  async provisionCancellationReply(
    request: DaemonRequest,
    failure: DaemonResponse | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DaemonResponse | undefined> {
    const requestKey = this.state.forwardedCallKeys.get(request);
    if (
      !failure ||
      !this.callbacks.isProvisionDeviceCall(request) ||
      requestKey === undefined ||
      !(signal?.reason instanceof ClientRequestCancellation)
    ) {
      return undefined;
    }
    const outcome = await provisionCancellationOutcomes.await(
      requestKey,
      PROVISION_DEVICE_SETTLEMENT_WAIT_MS + PROVISION_CANCELLATION_OUTCOME_GRACE_MS,
      this.state.timer,
    );
    return outcome === undefined
      ? undefined
      : { id: request.id, type: "mcp_response", success: true, result: outcome };
  }
  mcpForwardFailureResponse({
    error,
    request,
    sessionId,
    ownerSocket,
    signal,
  }: {
    error: unknown;
    request: DaemonRequest;
    sessionId: string;
    ownerSocket: Socket;
    signal?: AbortSignal;
  }): DaemonResponse | undefined {
    const errorMsg = errorMessage(error);
    const preservedCause = requestFailureCause(error, signal);
    if (isClientForwardCancellation(signal, preservedCause)) {
      logger.debug(`MCP forward abandoned for ${sessionId}: ${preservedCause?.message}`);
      if (ownerSocket.destroyed) {
        return undefined;
      }
    } else {
      const errorStack = error instanceof Error ? error.stack : "no stack";
      logger.error(`Error forwarding request to MCP server: ${errorMsg}`);
      logRequestFailureCause(preservedCause);
      logger.error(`Error stack: ${errorStack}`);
      logger.error(`Full error: ${JSON.stringify(error)}`);
    }
    return {
      id: request.id,
      type: "mcp_response",
      success: false,
      error: errorMsg,
      ...(error instanceof ReleasedBoundSessionError ? { boundSessionLoss: error.failure } : {}),
      ...mcpRequestFailureDetails(error, preservedCause),
      ...((error instanceof InputTypeTextAppendError ||
        error instanceof SessionReleasedDuringCallError) &&
      error.charsSent !== undefined
        ? { charsSent: error.charsSent }
        : {}),
    };
  }
  async waitForStartup(
    request: DaemonRequest,
    deadline: ProgressExtendableDeadline,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.state.startupCompletion || this.state.startupCompleted) {
      return;
    }
    const remainingMs = deadline.value - this.state.timer.now();
    const stillStarting = () =>
      new ActionableError(`Daemon still starting; retry ${request.method} after startup completes`);
    if (remainingMs <= 0) {
      throw stillStarting();
    }
    const startup = this.state.startupCompletion.then(undefined, (error: unknown) => {
      throw new ActionableError(`Daemon startup failed: ${errorMessage(error)}`, { cause: error });
    });
    await raceWithDeadline(startup, {
      timer: this.state.timer,
      timeoutMs: remainingMs,
      signal,
      label: "Daemon startup",
      timeoutError: stillStarting,
    });
  }
  /**
   * Track a socket request so a later `daemon/cancelRequest` frame can abandon
   * it (issue #6384). A duplicate id replaces the older entry; `dispose` only
   * removes its own entry so it cannot drop the newer one.
   */
  registerRequestCancellation(
    session: SessionContext,
    { id: requestId, cancellation: controller }: RequestContext,
  ): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    session.requestCancellations.set(requestId, controller);
    return {
      signal: controller.signal,
      dispose: () => {
        if (session.requestCancellations.get(requestId) === controller) {
          session.requestCancellations.delete(requestId);
        }
      },
    };
  }
  /**
   * Answer a client cancel frame out-of-band (issue #6384). A queued request is
   * skipped when dequeued; an in-flight one has its MCP forward aborted and
   * releases the socket queue immediately. The cancelled request itself is
   * answered with an error response, which the cancelling client ignores.
   */
  cancelSocketRequest(session: SessionContext, request: DaemonRequest): DaemonResponse {
    const targetId: unknown = request.params?.requestId;
    if (typeof targetId !== "string" || targetId.length === 0) {
      return {
        id: request.id,
        type: "mcp_response",
        success: false,
        error: `${DAEMON_CANCEL_REQUEST_METHOD} requires a non-empty string params.requestId`,
      };
    }
    const controller = session.requestCancellations.get(targetId);
    if (!controller) {
      // Already answered (a timeout racing the response) or never seen: nothing to cancel. Leave a
      // trace: a cancel that reaches the daemon after the work finished otherwise looks identical to
      // one that was never sent, which hid a client delivering its cancel late (#10151).
      logger.debug(
        `[SocketCancel] socketSession=${session.sessionId} cancel for request ${targetId} found no in-flight request (already answered or never seen)`,
      );
      return { id: request.id, type: "mcp_response", success: true, result: { cancelled: false } };
    }
    session.requestCancellations.delete(targetId);
    const reason = new ClientRequestCancellation(
      `Request ${targetId} was cancelled by its client (client-side timeout or abort); ` +
        "the daemon abandoned it so the next request on this connection can run.",
    );
    logger.warn(`[SocketCancel] socketSession=${session.sessionId} ${reason.message}`);
    controller.abort(reason);
    return { id: request.id, type: "mcp_response", success: true, result: { cancelled: true } };
  }
  requireRemainingMcpForwardBudget(
    request: DaemonRequest,
    totalTimeoutMs: number,
    deadline: ProgressExtendableDeadline,
    phase: string,
  ): number {
    // Read live: a progress notification received since this request first
    // started may already have pushed `deadline.value` out (issue #6222
    // review, P1) -- caching it earlier would silently ignore that extension.
    const remainingTimeoutMs = this.callbacks.remainingMcpForwardBudget({ deadline });
    const queueWaitMs = Math.max(0, totalTimeoutMs - remainingTimeoutMs);
    if (
      remainingTimeoutMs > 0 &&
      (queueWaitMs === 0 || remainingTimeoutMs > MCP_FORWARD_START_HEADROOM_MS)
    ) {
      return remainingTimeoutMs;
    }
    const toolName =
      request.method === "tools/call" ? (request.params?.name ?? request.method) : request.method;
    if (remainingTimeoutMs <= 0) {
      throw new McpTimeoutError({
        toolName,
        timeoutMs: totalTimeoutMs,
        origin: "UnixSocketServer.handleRequest",
        detail: `spent ${totalTimeoutMs - remainingTimeoutMs}ms ${phase}`,
        // Reconnect preparation may follow a dispatched attempt; only the
        // initial execution-key queue wait proves that work never started.
        ...(phase === "waiting in queue" ? { code: MCP_QUEUE_TIMEOUT_ERROR_CODE } : {}),
      });
    }
    if (queueWaitMs > 0) {
      const failure = {
        code: "daemon_overloaded",
        retryable: true,
        retryAfterMs: MCP_OVERLOAD_RETRY_AFTER_MS,
        reason: "insufficient_forward_budget",
        queueWaitMs,
        remainingTimeoutMs: Math.max(0, remainingTimeoutMs),
      } as const;
      throw new McpOverloadError(
        `Daemon overloaded while handling ${toolName}: spent ${queueWaitMs}ms ${phase}, leaving ` +
          `${failure.remainingTimeoutMs}ms of the ${totalTimeoutMs}ms deadline. ` +
          `Retry after ${failure.retryAfterMs}ms.`,
        failure,
      );
    }
    throw new McpTimeoutError({
      toolName,
      timeoutMs: totalTimeoutMs,
      origin: "UnixSocketServer.handleRequest",
      detail: `spent ${totalTimeoutMs - remainingTimeoutMs}ms ${phase}`,
    });
  }
  /** Held input must observe socket close before its handler enters device resolution. */
  socketAdmissionCancellation(
    request: DaemonRequest,
    sessionId: string,
    ownerSocket: Socket,
    cancelSignal: AbortSignal,
  ): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    if (!DISPATCH_HELD_INPUT_METHODS.has(request.method)) {
      return { signal: cancelSignal, dispose: () => {} };
    }
    return this.callbacks.mcpRequestSignal(sessionId, ownerSocket, cancelSignal);
  }
  /** Race cancellation only until a held frame synchronously latches its first send. */
  async runCancellableInputHandler<T>(
    handler: (onDispatch: () => void) => Promise<T>,
    cancelSignal: AbortSignal | undefined,
  ): Promise<T> {
    const beforeDispatch = new AbortController();
    let dispatched = false;
    const onAbort = () => {
      if (!dispatched) {
        beforeDispatch.abort(cancelSignal?.reason);
      }
    };
    cancelSignal?.addEventListener("abort", onAbort, { once: true });
    if (cancelSignal?.aborted) {
      onAbort();
    }
    try {
      return await this.callbacks.runCancellableQueuedHandler(
        () =>
          handler(() => {
            // The latch chooses which answer wins. The request hold aborts its fence
            // in the same tick before dispatch, preventing a later send.
            beforeDispatch.signal.throwIfAborted();
            dispatched = true;
            cancelSignal?.removeEventListener("abort", onAbort);
          }),
        beforeDispatch.signal,
      );
    } finally {
      cancelSignal?.removeEventListener("abort", onAbort);
    }
  }
  /**
   * Run one admitted handler, releasing its socket admission slot as soon as its
   * client cancels it (issue #6384). A cancelled handler that has not started never
   * runs; a started one keeps winding down on its aborted signal, tracked so
   * shutdown still drains it, while later requests proceed.
   */
  async runCancellableQueuedHandler<T>(
    handler: () => Promise<T>,
    cancelSignal: AbortSignal | undefined,
  ): Promise<T> {
    if (!cancelSignal) {
      return await handler();
    }
    cancelSignal.throwIfAborted();
    const operation = handler();
    this.callbacks.trackRequestHandler(
      operation.then(
        () => {},
        () => {},
      ),
    );
    return await raceWithDeadline(operation, {
      timer: this.state.timer,
      signal: cancelSignal,
      label: "Cancelled socket request",
    });
  }

  private async runAdmittedRequest(
    input: AdmittedSocketRequest,
  ): Promise<DaemonResponse | undefined> {
    const { request, sessionId, ownerSocket, receivedAtMs, context, cancellation } = input;
    const { deadline, owner } = context;

    try {
      if (request.method.startsWith("daemon/")) {
        // The socket's cancellation reaches long daemon methods (broker binding acquisition).
        const daemonResponse = await handleDaemonRequest(request, this.state.daemonState, {
          signal: cancellation.signal,
          context: { socketSessionId: sessionId },
        });
        return {
          id: request.id,
          type: "mcp_response",
          ...daemonResponse,
        };
      }
      // Status and ping are local probes used while the daemon is starting.
      if (!STARTUP_PROBE_METHODS.has(request.method)) {
        owner.adopt(cancellation.signal);
        await this.callbacks.waitForStartup(request, deadline, cancellation.signal);
      }
      const localResult = await this.callbacks.runLocalSocketRequest(
        request,
        sessionId,
        ownerSocket,
        {
          cancelSignal: cancellation.signal,
          receivedAtMs,
          onOwnerSignal: (signal) => owner.adopt(signal),

          onInputDispatch: input.onInputDispatch,
        },
      );
      if (localResult !== undefined) {
        return {
          id: request.id,
          type: "mcp_response",
          success: true,
          result: localResult,
        };
      }
      return await this.runAdmittedMcpForward(input);
    } catch (error) {
      const failure = this.callbacks.mcpForwardFailureResponse({
        error,
        request,
        sessionId,
        ownerSocket,
        signal: owner.signal,
      });
      return failure;
    }
  }
  private async runAdmittedMcpForward(input: AdmittedSocketRequest): Promise<DaemonResponse> {
    const { request, sessionId, ownerSocket, context, cancellation } = input;
    const { totalTimeoutMs, deadline } = context;
    let endOwnerCall: (() => void) | undefined;
    let disposeMcpRequest = () => {};
    try {
      if (request.method === "tools/call") {
        await this.callbacks.restoreSelectorSessions(request.params?.arguments, sessionId);
        endOwnerCall = this.callbacks.beginMcpSessionOwnerCall(
          request.params?.arguments,
          sessionId,
          cancellation.signal,
        );
      }
      const routeOrPending = this.callbacks.getMcpForwardRoute(request, sessionId);
      const initialRoute =
        routeOrPending instanceof Promise ? await routeOrPending : routeOrPending;
      const mcpRequest = this.callbacks.mcpRequestSignal(
        sessionId,
        ownerSocket,
        cancellation.signal,
      );
      disposeMcpRequest = mcpRequest.dispose;
      context.owner.adopt(mcpRequest.signal);
      const result = await this.callbacks.runMcpForwardForCurrentRoute(
        initialRoute,
        request,
        sessionId,
        {
          fn: async (route) => {
            const remainingTimeoutMs = this.callbacks.requireRemainingMcpForwardBudget(
              request,
              totalTimeoutMs,
              deadline,
              "waiting in queue",
            );
            const queueWaitMs = Math.max(0, totalTimeoutMs - remainingTimeoutMs);
            const forwardLabel = this.callbacks.describeMcpForwardRequest(request);
            logger.debug(
              `[McpForward] start executionKey=${route.executionKey} clientKey=${route.clientKey} socketSession=${sessionId} requestId=${request.id} ${forwardLabel} queueWaitMs=${queueWaitMs} remainingTimeoutMs=${remainingTimeoutMs}`,
            );
            const forwardStartMs = this.state.timer.now();
            try {
              const sessionWasActiveBeforeForward = this.callbacks.wasRequestSessionActive(request);
              const response = await this.callbacks.forwardMcpRequest({
                request,
                route,
                socketSessionId: sessionId,
                signal: mcpRequest.signal,
                totalTimeoutMs,
                deadline,
              });
              if (this.callbacks.isMcpRequestOwnerCurrent(sessionId, mcpRequest.signal)) {
                this.callbacks.recordBoundMcpClientKey(request, sessionId, route, {
                  sessionWasActiveBeforeForward,
                  response,
                });
              }
              return response;
            } finally {
              logger.debug(
                `[McpForward] end executionKey=${route.executionKey} clientKey=${route.clientKey} socketSession=${sessionId} requestId=${request.id} ${forwardLabel} forwardMs=${this.state.timer.now() - forwardStartMs}`,
              );
            }
          },
          chainWait: {
            remainingMs: () => this.callbacks.remainingMcpForwardBudget({ deadline }),
            timeoutError: (executionKey) =>
              new McpTimeoutError({
                toolName:
                  request.method === "tools/call"
                    ? (request.params?.name ?? request.method)
                    : request.method,
                timeoutMs: totalTimeoutMs,
                origin: "UnixSocketServer.handleRequest",
                detail: `spent ${totalTimeoutMs - this.callbacks.remainingMcpForwardBudget({ deadline })}ms waiting in queue for ${executionKey}`,
                code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
              }),
          },
        },
      );
      if (isDaemonShuttingDownToolResult(result)) {
        return {
          id: request.id,
          type: "mcp_response",
          success: false,
          error: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
          ...daemonShuttingDownFrameFields(daemonShuttingDownFailureFromToolResult(result)),
        };
      }
      return {
        id: request.id,
        type: "mcp_response",
        success: true,
        result,
      };
    } finally {
      endOwnerCall?.();
      disposeMcpRequest();
    }
  }
}
