import type { SessionDeviceRebound } from "../sessionDeviceReboundBroadcast";
import { serializeControlFrame } from "../socketServer/controlRoutes";
import {
  applyResourceSubscription,
  broadcastListChanged as fanOutListChanged,
  broadcastResourceUpdated as fanOutResourceUpdated,
  broadcastSessionReleased as fanOutSessionReleased,
  broadcastSessionDeviceRebound as fanOutSessionDeviceRebound,
  pushProgressNotification as fanOutProgress,
  type NotificationTransport,
  type ProgressTick,
} from "../socketServer/notificationFanOut";

import { Socket } from "node:net";

import { logger } from "../../utils/logger";

import { createRequestContext } from "../requestContext";

import { errorMessage } from "../../utils/describeUnknownError";

import {
  DaemonNotification,
  DaemonRequest,
  DaemonResponse,
  REQUEST_BUDGET_NOTIFICATION_METHOD,
  SessionContext,
} from "../types";
import {
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  DAEMON_CANCEL_REQUEST_METHOD,
  DAEMON_HEARTBEAT_METHOD,
} from "../wire/constants";
import { SocketRequestAdmissionQueue } from "../socketRequestAdmission";

import { type ResourceUpdateTargets, type ListChangedKind } from "../listChangedBroadcast";

import { canonicalizeToolCallDeviceIds, toolCallNamesDeviceId } from "../toolCallDeviceIdentity";

import { isDaemonRequestEnvelope } from "../daemonRequestEnvelope";

import { DAEMON_RPC_SOCKET_MAX_QUEUED_BYTES } from "../outboundWriteGuard";
import { ControlConnection } from "../socketServer/ControlConnection";

import { ActionableError, toActionableError } from "../../models/ActionableError";

import { executionTracker } from "../executionTracker";

import { mcpRequestFailureDetails } from "../socketServer/errorFrames";

import { type PendingSocketRequest } from "../socketServer/PendingRequestTracker";

import {
  socketRequestId,
  LATE_BINDING_FORGET_WINDOW_MS,
  isExpectedSocketFrameAbort,
  SocketFrameTraceEvent,
} from "./socketServerContracts";

import { DaemonSocketQueueOverflowError } from "./DaemonSocketQueueOverflowError";

import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations } from "./socketServerOperations";
type State = Pick<
  SocketServerRuntime,
  | "acceptingRequests"
  | "idGenerator"
  | "timer"
  | "requestTimeoutEnv"
  | "sessions"
  | "clientSockets"
  | "acceptedClientConnections"
  | "onFrameTrace"
  | "controlConnections"
  | "pendingSocketRequests"
  | "maxInboundFrameBytes"
  | "daemonState"
  | "restartAdmission"
  | "notificationSubscribers"
  | "resourceSubscriptions"
  | "releaseToolCallRecording"
  | "forgetSessionToolBindings"
  | "ownedGestures"
  | "activeRequestHandlers"
  | "mcpRequestAbortControllers"
  | "pendingSessionReleaseWrites"
>;
type Callbacks = Pick<
  SocketServerOperations,
  | "connectionFor"
  | "trackRequestHandler"
  | "processSocketRequestLine"
  | "rejectOversizedFrame"
  | "hasLiveSocketRequest"
  | "traceFrame"
  | "releaseSocketSession"
  | "writeFrame"
  | "writeTerminalSocketResponse"
  | "frameDeviceId"
  | "handleRequest"
  | "abortMcpRequests"
  | "forgetSocketDiscovery"
  | "clearBoundMcpClientKey"
  | "releaseDevicePoolMcpSessionBindings"
  | "clearConnectionDevicePin"
  | "forgetLateSessionToolBindings"
  | "abortRequestControllers"
  | "writeFrameData"
  | "holdsSession"
>;
/** Socket Transport over shared connection state and explicit callbacks. */
export class SocketTransport {
  constructor(
    private readonly state: State,
    private readonly resolveCallbacks: () => Callbacks,
  ) {}
  private get callbacks(): Callbacks {
    return this.resolveCallbacks();
  }
  /**
   * Handle a new client connection
   */
  handleConnection(socket: Socket): void {
    if (!this.state.acceptingRequests) {
      // An accept callback can already be queued when quiesce closes the
      // listener. End that late connection before it can bind or issue work.
      socket.end();
      return;
    }
    const sessionId = this.state.idGenerator.next();
    const session: SessionContext = {
      sessionId,
      createdAt: this.state.timer.now(),
      requestQueue: new SocketRequestAdmissionQueue(),
      requestCancellations: new Map(),
    };
    this.state.sessions.set(sessionId, session);
    this.state.clientSockets.set(sessionId, socket);
    this.state.acceptedClientConnections++;
    logger.info(`New client connection: ${sessionId}`);
    this.callbacks.connectionFor(socket, sessionId).start({
      // Parse each frame synchronously and track it on its own. A held device
      // call must not keep another frame attached to its chunk's completion
      // promise (issue #6387).
      onLine: (line, receivedAtMs) => {
        if (line.trim()) {
          this.callbacks.trackRequestHandler(
            this.callbacks.processSocketRequestLine(sessionId, socket, line, receivedAtMs),
          );
        }
      },
      onOverflow: () => this.callbacks.rejectOversizedFrame(sessionId, socket),
      hasLiveRequest: () => this.callbacks.hasLiveSocketRequest(socket),
      trace: this.state.onFrameTrace
        ? (event, extra) => this.callbacks.traceFrame(event, "*", { details: extra })
        : undefined,
      onClose: () => {
        this.state.controlConnections.delete(socket);
        logger.info(`Client disconnected: ${sessionId}`);
        this.state.pendingSocketRequests.deleteForSocket(socket);
        this.callbacks.releaseSocketSession(sessionId, socket);
      },
      onError: () => this.callbacks.releaseSocketSession(sessionId, socket),
    });
  }
  /** The socket's connection transport, created on first use (writers may precede `start`). */
  connectionFor(socket: Socket, sessionId: string): ControlConnection {
    let connection = this.state.controlConnections.get(socket);
    if (!connection) {
      connection = new ControlConnection(
        socket,
        sessionId,
        this.state.timer,
        this.state.maxInboundFrameBytes,
      );
      this.state.controlConnections.set(socket, connection);
    }
    return connection;
  }
  /**
   * A peer sent a frame larger than the control socket accepts. Answer with a
   * structured error (the request id is unknowable because the frame was never
   * completed), then drop the connection once the reply is flushed. Other
   * sockets are unaffected.
   */
  rejectOversizedFrame(sessionId: string, socket: Socket): void {
    logger.warn(
      `Daemon RPC socket ${sessionId} sent a frame over ${this.state.maxInboundFrameBytes} bytes; rejecting`,
    );
    const errorResponse: DaemonResponse = {
      id: null,
      type: "mcp_response",
      success: false,
      error: "Invalid request: frame too large",
      code: -32600,
    };
    this.callbacks.writeFrame(socket, sessionId, errorResponse, {
      onFlushed: () => {
        if (!socket.destroyed) {
          socket.destroy();
        }
      },
    });
  }
  hasLiveSocketRequest(socket: Socket): boolean {
    return this.state.pendingSocketRequests.hasLiveRequest(socket, this.state.timer.now());
  }
  async processSocketRequestLine(
    sessionId: string,
    socket: Socket,
    line: string,
    receivedAtMs: number,
  ): Promise<void> {
    let requestId: string | null = null;
    let deviceId: string | undefined;
    let pending: PendingSocketRequest | undefined;
    let errorCode: number | undefined;
    let endToolCall = (_delivered?: boolean): void => {};
    let answerWritten = false;
    const answerDelivered = (): boolean =>
      answerWritten && this.state.clientSockets.get(sessionId) === socket && !socket.destroyed;
    const writeAnswer = (response: DaemonResponse): void => {
      if (pending?.terminal) {
        return;
      }
      if (pending) {
        this.callbacks.writeTerminalSocketResponse(pending, response, deviceId);
      } else {
        this.callbacks.writeFrame(socket, sessionId, response, { deviceId });
      }
      answerWritten = true;
    };
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        errorCode = -32700;
        throw toActionableError(error, "Parse error in daemon socket request");
      }
      requestId = socketRequestId(parsed);
      if (!isDaemonRequestEnvelope(parsed)) {
        errorCode = -32600;
        throw new ActionableError("Invalid daemon socket request");
      }
      const request = parsed;
      const controlFrame = [
        DAEMON_HEARTBEAT_METHOD,
        DAEMON_CANCEL_REQUEST_METHOD,
        DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
      ].includes(request.method);
      const context = createRequestContext(
        request,
        sessionId,
        receivedAtMs,
        this.state.requestTimeoutEnv,
      );
      const tracked: PendingSocketRequest = {
        id: request.id,
        sessionId,
        socket,
        admitted: controlFrame,
        terminal: false,
        idleDeadline: controlFrame ? undefined : context.deadline,
      };
      pending = tracked;
      this.state.pendingSocketRequests.add(tracked);
      this.announceResolvedBudget(socket, sessionId, request, {
        resolvedMs: context.totalTimeoutMs,
        controlFrame,
      });
      deviceId = this.state.onFrameTrace ? this.callbacks.frameDeviceId(request) : undefined;
      if (this.state.onFrameTrace) {
        this.callbacks.traceFrame("frame_parsed", request.id, { deviceId });
      }
      const beginToolCall = (): void => {
        try {
          if (request.method === "tools/call" && this.state.daemonState.isInitialized()) {
            endToolCall =
              this.state.daemonState.getDevicePool().beginMcpToolCall?.(sessionId) ?? endToolCall;
          }
        } catch (error) {
          // #11999: optional tracking may fall back to the existing owner-disconnect grace.
          logger.warn(
            `Could not begin MCP tool-call ownership claim: ${errorMessage(error)}`,
            error,
          );
        }
      };
      beginToolCall();
      const response = await this.callbacks.handleRequest(sessionId, socket, request, {
        receivedAtMs,
        handling: {
          onAdmitted: (deadline) => {
            tracked.admitted = true;
            tracked.idleDeadline = controlFrame ? undefined : deadline;
          },
          context,
        },
      });
      if (response) {
        writeAnswer(response);
      } else {
        this.state.pendingSocketRequests.delete(tracked);
        this.state.controlConnections.get(socket)?.responseFlushed();
      }
    } catch (error) {
      if (isExpectedSocketFrameAbort(error, socket.destroyed)) {
        // Client cancellation and owner-socket close are expected request termination.
        logger.debug(`Client cancelled request ${requestId} from ${sessionId}`);
      } else {
        logger.error(`Error processing request ${requestId} from ${sessionId}:`, error);
      }
      const errorResponse: DaemonResponse = {
        id: requestId,
        type: "mcp_response",
        success: false,
        error: errorMessage(error),
        ...(errorCode === undefined ? {} : { code: errorCode }),
        ...mcpRequestFailureDetails(error, undefined),
      };
      writeAnswer(errorResponse);
    } finally {
      endToolCall(answerDelivered());
    }
  }
  writeTerminalSocketResponse(
    pending: PendingSocketRequest,
    response: DaemonResponse,
    deviceId?: string,
  ): void {
    if (pending.terminal) {
      return;
    }
    pending.terminal = true;
    this.callbacks.writeFrame(pending.socket, pending.sessionId, response, {
      onFlushed: () => {
        this.state.pendingSocketRequests.delete(pending);
        this.state.controlConnections.get(pending.socket)?.responseFlushed();
      },
      deviceId,
    });
  }
  /**
   * A `tools/call` with the device ids it names as the pool's canonical ids (#11618), before the
   * admission lane, the forward key, the read lane, recovery pinning or the forward itself reads
   * them: a handset named by its other transport id must serialize, route and be judged as the one
   * pooled device it is. Cached fold only; the same request when nothing changes. Older socket-state
   * fakes carry no pool, or none with a fold: their ids pass through as sent.
   */
  withCanonicalToolCallDeviceIds(request: DaemonRequest): DaemonRequest {
    const args: unknown = request.params?.arguments;
    if (
      request.method !== "tools/call" ||
      !toolCallNamesDeviceId(args) ||
      !this.state.daemonState.isInitialized?.()
    ) {
      return request;
    }
    const canonical = canonicalizeToolCallDeviceIds(this.state.daemonState.getDevicePool?.(), args);
    return canonical === args
      ? request
      : { ...request, params: { ...request.params, arguments: canonical } };
  }
  frameDeviceId(request: DaemonRequest): string | undefined {
    const deviceId: unknown = request.params?.arguments?.deviceId;
    return typeof deviceId === "string" ? deviceId : undefined;
  }
  traceFrame(
    event: SocketFrameTraceEvent["event"],
    requestId: string,
    {
      deviceId,
      error,
      details,
    }: { deviceId?: string; error?: string; details?: Partial<SocketFrameTraceEvent> } = {},
  ): void {
    if (this.state.onFrameTrace) {
      this.state.onFrameTrace({
        event,
        atMs: this.state.timer.now(),
        wallMs: performance.now(),
        requestId,
        deviceId,
        error,
        ...details,
      });
    }
  }
  releaseSocketSession(sessionId: string, socket: Socket): void {
    // Session IDs are expected to be unique, but teardown must still be
    // incarnation-safe: a delayed close/error from an older socket must not
    // remove or abort work registered by a newer socket with the same ID.
    if (this.state.clientSockets.get(sessionId) !== socket) {
      return;
    }
    this.callbacks.abortMcpRequests(sessionId);
    this.callbacks.forgetSocketDiscovery(sessionId);
    this.callbacks.trackRequestHandler(
      executionTracker
        .cancelSessionExecutions(sessionId, "socket_disconnect")
        .then(() => undefined)
        .catch((error) => {
          logger.warn(
            `Cancelling executions of socket ${sessionId} failed: ${errorMessage(error)}`,
          );
        }),
    );
    this.state.restartAdmission.releaseAcceptanceRestartAdmissionForOwner(sessionId);
    this.state.sessions.delete(sessionId);
    this.state.clientSockets.delete(sessionId);
    this.state.notificationSubscribers.delete(sessionId);
    this.state.resourceSubscriptions.delete(sessionId);
    this.callbacks.clearBoundMcpClientKey(sessionId);
    this.callbacks.releaseDevicePoolMcpSessionBindings(sessionId);
    this.callbacks.clearConnectionDevicePin(sessionId);
    this.state.daemonState.getBrokerConnectionScopes?.().unbind(sessionId);
    this.state.releaseToolCallRecording(sessionId);
    this.state.forgetSessionToolBindings(sessionId);
    this.callbacks.forgetLateSessionToolBindings(sessionId);
    // Lift any streamed gesture this socket left open on the device (issue: streaming gesture
    // input). Tracked so daemon shutdown drains it rather than a fire-and-forget floating promise.
    this.callbacks.trackRequestHandler(this.state.ownedGestures.cancelAllFor(sessionId));
  }
  /**
   * A handler that ignores its abort can still finish after its socket is gone and write a
   * session-tool binding under the gone socket's key (#13053): forget the key again once the
   * executions it ran have ended. Not tracked as a request handler, so shutdown never waits on it.
   */
  forgetLateSessionToolBindings(socketSessionId: string): void {
    if (!executionTracker.hasActiveSessionExecutions(socketSessionId)) {
      return;
    }
    void executionTracker
      .waitForSessionExecutionsToEnd(socketSessionId, LATE_BINDING_FORGET_WINDOW_MS)
      .then((drained) => {
        this.state.forgetSessionToolBindings(socketSessionId);
        if (!drained) {
          logger.warn(
            `Socket ${socketSessionId} still had executions ${LATE_BINDING_FORGET_WINDOW_MS}ms after it closed; forgot its bindings anyway`,
          );
        }
      });
  }
  trackRequestHandler(handler: Promise<void>): void {
    this.state.activeRequestHandlers.add(handler);
    void handler.then(
      () => this.state.activeRequestHandlers.delete(handler),
      () => this.state.activeRequestHandlers.delete(handler),
    );
  }
  abortMcpRequests(sessionId: string): void {
    this.callbacks.abortRequestControllers(
      sessionId,
      this.state.mcpRequestAbortControllers,
      "Daemon MCP client disconnected",
    );
  }
  abortRequestControllers(
    sessionId: string,
    controllerMap: Map<string, Set<AbortController>>,
    reason: string,
  ): void {
    const controllers = controllerMap.get(sessionId);
    if (!controllers) {
      return;
    }
    controllerMap.delete(sessionId);
    for (const controller of controllers) {
      controller.abort(new Error(reason));
    }
  }
  mcpRequestSignal(
    sessionId: string,
    ownerSocket: Socket | undefined = this.state.clientSockets.get(sessionId),
    cancelSignal?: AbortSignal,
  ): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    const controller = new AbortController();
    // A client cancel frame (issue #6384) aborts this one forward, not its siblings.
    const onCancel = () => controller.abort(cancelSignal?.reason);
    if (cancelSignal?.aborted) {
      onCancel();
    } else {
      cancelSignal?.addEventListener("abort", onCancel, { once: true });
    }
    const controllers =
      this.state.mcpRequestAbortControllers.get(sessionId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.state.mcpRequestAbortControllers.set(sessionId, controllers);
    const socket = this.state.clientSockets.get(sessionId);
    if (!ownerSocket || socket !== ownerSocket || ownerSocket.destroyed) {
      controller.abort(new Error("Daemon MCP client disconnected"));
    }
    return {
      signal: controller.signal,
      dispose: () => {
        cancelSignal?.removeEventListener("abort", onCancel);
        controllers.delete(controller);
        if (
          controllers.size === 0 &&
          this.state.mcpRequestAbortControllers.get(sessionId) === controllers
        ) {
          this.state.mcpRequestAbortControllers.delete(sessionId);
        }
      },
    };
  }
  /**
   * An abort-ignoring MCP transport can return after its owning Unix socket has
   * disconnected. Its result is no longer allowed to publish a session/profile
   * binding that a later socket request could reuse.
   */
  isMcpRequestOwnerCurrent(sessionId: string, signal: AbortSignal): boolean {
    const socket = this.state.clientSockets.get(sessionId);
    return !signal.aborted && socket !== undefined && !socket.destroyed;
  }
  /** The fan-out's view of the live client sockets (#11815). */
  private get notificationTransport(): NotificationTransport {
    return {
      hasSocket: (sessionId) => this.state.clientSockets.has(sessionId),
      write: (sessionId, frame, onFlushed) => {
        const socket = this.state.clientSockets.get(sessionId);
        if (socket) {
          this.callbacks.writeFrame(socket, sessionId, frame, { onFlushed });
        }
      },
    };
  }
  broadcastListChanged(kind: ListChangedKind): void {
    fanOutListChanged(this.state.notificationSubscribers, this.notificationTransport, kind);
  }
  broadcastResourceUpdated(resolveTargets: ResourceUpdateTargets): void {
    fanOutResourceUpdated(
      this.state.resourceSubscriptions,
      this.notificationTransport,
      resolveTargets,
    );
  }
  handleResourceSubscription(sessionId: string, request: DaemonRequest): DaemonResponse {
    return applyResourceSubscription(this.state.resourceSubscriptions, sessionId, request);
  }
  /**
   * Push a session-released notification frame to every subscribed client socket
   * (issue #4610). `releasedSessionId` is the daemon session key that was just
   * released (base or derived `${base}:${label}`); the proxy matches it against
   * its bound UUID by exact equality. Best-effort per socket, like
   * {@link broadcastListChanged}. Note `sessionId` here is the socket-client id,
   * distinct from the released daemon session carried in the frame.
   */
  broadcastSessionDeviceRebound(event: SessionDeviceRebound): void {
    // Only sockets that hold the session learn its serial and AVD name (#15456).
    const holders = Array.from(this.state.notificationSubscribers).filter((socketSessionId) =>
      this.callbacks.holdsSession(socketSessionId, event.sessionId),
    );
    fanOutSessionDeviceRebound(
      holders,
      this.notificationTransport,
      this.state.pendingSessionReleaseWrites,
      event,
    );
  }

  broadcastSessionReleased(
    releasedSessionId: string,
    reason?: string,
    release?: DaemonNotification["release"],
    recordingIds?: string[],
  ): void {
    fanOutSessionReleased(
      this.state.notificationSubscribers,
      this.notificationTransport,
      this.state.pendingSessionReleaseWrites,
      { releasedSessionId, reason, release, recordingIds },
    );
  }
  /** Pushes one progress tick to the single socket that requested it (#6205); see the fan-out. */
  pushProgressNotification(sessionId: string, tick: ProgressTick): void {
    fanOutProgress(this.notificationTransport, sessionId, tick);
  }
  /**
   * The client sized its backstop from its own environment (#13797); an opted-in client is told how
   * long this daemon will really wait so it does not cancel a call still inside that budget.
   */
  private announceResolvedBudget(
    socket: Socket,
    sessionId: string,
    request: DaemonRequest,
    { resolvedMs, controlFrame }: { resolvedMs: number; controlFrame: boolean },
  ): void {
    if (
      controlFrame ||
      request.type !== "mcp_request" ||
      request.acceptsRequestBudget !== true ||
      resolvedMs === request.timeoutMs
    ) {
      return;
    }
    this.callbacks.writeFrame(socket, sessionId, {
      type: "daemon_notification",
      method: REQUEST_BUDGET_NOTIFICATION_METHOD,
      requestId: request.id,
      timeoutMs: resolvedMs,
    });
  }

  writeFrame(
    socket: Socket,
    sessionId: string,
    frame: DaemonResponse | DaemonNotification,
    { onFlushed, deviceId }: { onFlushed?: () => void; deviceId?: string } = {},
  ): void {
    if (this.state.onFrameTrace && frame.type === "mcp_response") {
      this.callbacks.traceFrame("response_write_started", frame.id ?? "null", { deviceId });
      this.callbacks.writeFrameData(socket, sessionId, frame, {
        onFlushed: (error) => {
          this.callbacks.traceFrame("response_write_callback", frame.id ?? "null", {
            deviceId,
            error: error?.message,
            details: {
              writableLengthInCallback: socket.writableLength,
            },
          });
          onFlushed?.();
        },
        onWritten: (writableLengthAfterWrite, byteLength) => {
          this.callbacks.traceFrame("response_write_returned", frame.id ?? "null", {
            deviceId,
            details: {
              byteLength,
              writableLengthAfterWrite,
            },
          });
        },
      });
      return;
    }
    this.callbacks.writeFrameData(socket, sessionId, frame, { onFlushed });
  }
  writeFrameData(
    socket: Socket,
    sessionId: string,
    frame: DaemonResponse | DaemonNotification,
    {
      onFlushed,
      onWritten,
    }: {
      onFlushed?: (error?: Error | null) => void;
      onWritten?: (writableLengthAfterWrite: number, byteLength: number) => void;
    },
  ): void {
    if (socket.destroyed) {
      onFlushed?.(new Error("socket destroyed"));
      return;
    }
    try {
      const payload = serializeControlFrame(frame);
      const byteLength = Buffer.byteLength(payload);
      const guard = this.callbacks.connectionFor(socket, sessionId).outboundWriteGuard();
      const queuedBytes = guard.admit(byteLength);
      if (queuedBytes !== undefined) {
        const error = new DaemonSocketQueueOverflowError(
          queuedBytes,
          DAEMON_RPC_SOCKET_MAX_QUEUED_BYTES,
        );
        logger.warn(
          `Daemon RPC socket ${sessionId} write queue exceeded limit; queuedBytes=${queuedBytes}, limitBytes=${DAEMON_RPC_SOCKET_MAX_QUEUED_BYTES}; destroying`,
        );
        onFlushed?.(error);
        socket.destroy();
        return;
      }
      const ok = socket.write(payload, (error) => {
        if (!error && !socket.destroyed && socket.writableLength === 0) {
          this.state.controlConnections.get(socket)?.refreshIdle();
          guard.flushed();
        }
        onFlushed?.(error);
      });
      guard.written();
      if (onWritten) {
        onWritten(socket.writableLength, byteLength);
      }
      if (!ok) {
        this.state.controlConnections.get(socket)?.startBackpressureIdle();
        logger.debug(`Daemon RPC socket ${sessionId} backpressured; awaiting drain`);
      }
    } catch (error) {
      onFlushed?.(error instanceof Error ? error : new Error(errorMessage(error)));
      logger.warn(`Daemon RPC write failed for ${sessionId}: ${error}`);
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }
}
