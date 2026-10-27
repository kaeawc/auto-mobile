import { createServer, Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureSecureDir, secureFile } from "../../utils/filesystem/securePermissions";

import { logger } from "../../utils/logger";

import { raceWithDeadline } from "../../utils/raceWithDeadline";

import {
  DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
  resolveDaemonVersion,
  syncSettledDaemonVersion,
} from "../wire/constants";

import { daemonShuttingDownFailure, daemonShuttingDownFrameFields } from "../daemonShutdownOutcome";

import { ListChangedBroadcaster, ResourceUpdatedBroadcaster } from "../listChangedBroadcast";
import { SessionDeviceReboundBroadcaster } from "../sessionDeviceReboundBroadcast";
import { SessionReleaseBroadcaster } from "../sessionReleaseBroadcast";

import { ActionableError } from "../../models/ActionableError";

import {
  classifySocketPath,
  readSocketFileIdentity,
  type SocketPathState,
} from "../socketFileIdentity";

import { type PendingSocketRequest } from "../socketServer/PendingRequestTracker";

import {
  DAEMON_REQUEST_HANDLER_DRAIN_TIMEOUT_MS,
  DAEMON_NOTIFICATION_WRITE_DRAIN_TIMEOUT_MS,
  SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS,
} from "./socketServerContracts";

import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations } from "./socketServerOperations";
type State = Pick<
  SocketServerRuntime,
  | "socketPath"
  | "socketReclaimLock"
  | "server"
  | "socketFileIdentity"
  | "closing"
  | "acceptingRequests"
  | "listChangedUnsubscribe"
  | "resourceUpdatedUnsubscribe"
  | "sessionReleaseUnsubscribe"
  | "sessionDeviceReboundUnsubscribe"
  | "serverClosePromise"
  | "lifecycleGeneration"
  | "socketReachability"
  | "socketOwnerLiveness"
  | "clientSockets"
  | "acceptedClientConnections"
  | "notificationSubscribers"
  | "pendingSessionReleaseWrites"
  | "timer"
  | "restartAdmission"
  | "pendingSocketRequests"
  | "sessions"
  | "resourceSubscriptions"
  | "boundMcpClientKeysBySocketSession"
  | "forwardKeyIdleTimers"
  | "mcpForwardTails"
  | "mcpForwardIdleCloseKeys"
  | "appendTextInputs"
  | "activeRequestHandlers"
>;
type Callbacks = Pick<
  SocketServerOperations,
  | "beginAccepting"
  | "reclaimExistingSocketBeforeBind"
  | "connectionHandlerWithFanOut"
  | "broadcastListChanged"
  | "broadcastResourceUpdated"
  | "clearBoundMcpClientsForReleasedSession"
  | "liftStrokesHeldBy"
  | "broadcastSessionReleased"
  | "broadcastSessionDeviceRebound"
  | "handleConnection"
  | "closeListeningServer"
  | "drainActiveRequestHandlers"
  | "stopAcceptingAndFanOut"
  | "writeShutdownSocketResponse"
  | "destroyClientSockets"
  | "writeTerminalSocketResponse"
>;
/** Socket Lifecycle over shared connection state and explicit callbacks. */
export class SocketLifecycle {
  constructor(
    private readonly state: State,
    private readonly resolveCallbacks: () => Callbacks,
  ) {}
  private get callbacks(): Callbacks {
    return this.resolveCallbacks();
  }
  /**
   * Start the Unix socket server
   */
  async start(): Promise<void> {
    this.callbacks.beginAccepting();
    if (!syncSettledDaemonVersion()) {
      await resolveDaemonVersion();
    }
    // Owner-only (0o700) socket directory so the control socket is not
    // world-traversable. On macOS socket-file permission bits are not reliably
    // enforced on connect(), so the containing directory's mode is the primary
    // access control (issue #4750).
    await ensureSecureDir(path.dirname(this.state.socketPath));
    // Hold a single cross-process lock across the whole reclaim → `listen()`
    // sequence (issue #6232, W5). The reachability/owner checks below are
    // observation-only, so two concurrent binders can BOTH judge a stale socket
    // reclaimable and then race unlink-vs-listen, leaving the winner bound to an
    // fd whose pathname the loser deleted. Serializing on `<socket>.bind.lock`
    // makes the sequence atomic: a losing binder cannot enter the reclaim window
    // until the winner has bound, at which point its own probe sees a reachable
    // socket and it refuses. A live holder means another launch is mid-bind, so
    // fail CLOSED rather than racing it (recoverable via `--daemon restart`).
    // A stale lock from a crashed holder is reclaimed by the primitive's dead-PID
    // check on the next attempt.
    if (!this.state.socketReclaimLock.acquire()) {
      throw new ActionableError(
        `Refusing to bind: another AutoMobile process is currently reclaiming or binding the daemon socket ${this.state.socketPath}. ` +
          "Two concurrent launches cannot bind the same socket; let the in-flight one finish, then re-observe, or run `--daemon restart`.",
      );
    }
    try {
      // Reclaim any existing socket file before listen(). Under this reclaim lock
      // the unlink is exclusive across processes. A LOCK-LESS bind — a
      // hand-launched daemon that bypassed the manager — must still NOT unlink a
      // live sibling's socket: doing so bricks every existing client (issue #6232,
      // the #6140 failure mode via a bypassed launch path). So probe first and
      // refuse when a live daemon still owns it.
      if (existsSync(this.state.socketPath)) {
        await this.callbacks.reclaimExistingSocketBeforeBind();
      }
      this.state.server = createServer(this.callbacks.connectionHandlerWithFanOut());
      await new Promise<void>((resolve, reject) => {
        this.state.server!.listen(this.state.socketPath, () => {
          this.state.socketFileIdentity = readSocketFileIdentity(this.state.socketPath);
          logger.info(`Unix socket server listening on ${this.state.socketPath}`);
          // Restrict the bound socket to the owner (0o600) before start() resolves,
          // so no client can connect while it is still world-accessible. listen()
          // creates the socket at the umask default (issue #4750).
          secureFile(this.state.socketPath).then(resolve).catch(reject);
        });
        this.state.server!.on("error", (error) => {
          logger.error(`Unix socket server error: ${error}`);
          reject(error);
        });
      });
    } finally {
      // Release once the socket is bound (or the bind failed): the lock only
      // needs to cover the brief unlink-and-listen window. Past a committed bind
      // the reachability probe alone protects the live socket from later binders.
      this.state.socketReclaimLock.release();
    }
  }
  /**
   * `start()` without the socket file (#11441): the same accept state, broadcast fan-out and
   * connection handler, with the caller handing each connection to the returned handler instead
   * of a bound listener. For an in-process harness; nothing touches the file system.
   */
  startDetached(): (socket: Socket) => void {
    this.callbacks.beginAccepting();
    return this.callbacks.connectionHandlerWithFanOut();
  }
  /** Counterpart of {@link startDetached}: refuse requests and drop the list/resource/release fan-out. */
  stopAcceptingAndFanOut(): void {
    this.state.closing = true;
    this.state.acceptingRequests = false;
    this.state.listChangedUnsubscribe?.();
    this.state.listChangedUnsubscribe = null;
    this.state.resourceUpdatedUnsubscribe?.();
    this.state.resourceUpdatedUnsubscribe = null;
    this.state.sessionReleaseUnsubscribe?.();
    this.state.sessionReleaseUnsubscribe = null;
    this.state.sessionDeviceReboundUnsubscribe?.();
    this.state.sessionDeviceReboundUnsubscribe = null;
  }
  beginAccepting(): void {
    this.state.closing = false;
    this.state.acceptingRequests = true;
    this.state.serverClosePromise = null;
    this.state.lifecycleGeneration += 1;
  }
  /** Subscribe the broadcast fan-out and return the handler every accepted connection goes to. */
  connectionHandlerWithFanOut(): (socket: Socket) => void {
    // Fan list-changed events out to subscribed socket clients (issue #3223).
    // Subscribed here (not in the daemon) so a socket-server recreation during
    // recovery re-wires itself; close() unsubscribes symmetrically.
    this.state.listChangedUnsubscribe?.();
    this.state.listChangedUnsubscribe = ListChangedBroadcaster.subscribe((kind) => {
      this.callbacks.broadcastListChanged(kind);
    });
    this.state.resourceUpdatedUnsubscribe?.();
    this.state.resourceUpdatedUnsubscribe = ResourceUpdatedBroadcaster.subscribe(
      (resolveTargets) => {
        this.callbacks.broadcastResourceUpdated(resolveTargets);
      },
    );
    // Fan session-release events out to subscribed proxy clients (issue #4610),
    // so a proxy clears its remembered binding on a real release instead of the
    // replay-TTL guess. Subscribed here (not in the daemon) for the same
    // recovery-rewire reason as list-changed; close() unsubscribes symmetrically.
    this.state.sessionReleaseUnsubscribe?.();
    this.state.sessionReleaseUnsubscribe = SessionReleaseBroadcaster.subscribe(
      (sessionId, reason, snapshot, extras) => {
        this.callbacks.clearBoundMcpClientsForReleasedSession(sessionId);
        void this.callbacks.liftStrokesHeldBy(sessionId);
        this.callbacks.broadcastSessionReleased(sessionId, reason, snapshot, extras?.recordingIds);
      },
    );
    this.state.sessionDeviceReboundUnsubscribe?.();
    this.state.sessionDeviceReboundUnsubscribe = SessionDeviceReboundBroadcaster.subscribe(
      (event) => this.callbacks.broadcastSessionDeviceRebound(event),
    );
    return (socket) => this.callbacks.handleConnection(socket);
  }
  /**
   * Reclaim an existing socket file before `listen()`, refusing to clobber a live
   * sibling (issue #6232). A startup lock is not ownership evidence, and an
   * inconclusive probe never authorizes reclaim. Reclaim requires both definite
   * socket absence and a positively dead recorded owner.
   */
  async reclaimExistingSocketBeforeBind(): Promise<void> {
    const reachability = await this.state.socketReachability.probe(
      this.state.socketPath,
      SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS,
    );
    if (reachability !== "absent" || this.state.socketOwnerLiveness.getOwnerStatus() !== "dead") {
      throw new ActionableError(
        (reachability === "unknown"
          ? `Refusing to bind: the AutoMobile daemon socket ${this.state.socketPath} probe is inconclusive; the socket could not be verified as dead. `
          : `Refusing to bind: the AutoMobile daemon socket ${this.state.socketPath} is still reachable or its former owner is not positively known to be dead. `) +
          "A startup lock and an inconclusive liveness probe do not authorize unlinking a socket that may still be live. Stop the running daemon or run `--daemon restart` to replace it.",
      );
    }
    await unlink(this.state.socketPath);
  }
  /**
   * Check if socket server is listening
   */
  isListening(): boolean {
    return this.state.server !== null && this.state.server.listening;
  }
  /** Connected control-socket clients (orphaned private-daemon watchdog, #10497). */
  getClientConnectionCount(): number {
    return this.state.clientSockets.size;
  }
  /** Monotonic count of control-socket connections accepted (orphan watchdog, #10497). */
  getAcceptedClientConnectionCount(): number {
    return this.state.acceptedClientConnections;
  }
  /**
   * Stop admitting control-socket work while preserving connected notification
   * subscribers. Daemon shutdown uses this barrier before releasing device
   * sessions, so no new request can mint or refresh a session after the shutdown
   * snapshot while each bound proxy can still receive its exact release reason.
   */
  async quiesce(): Promise<void> {
    this.state.acceptingRequests = false;
    // Stop new connections immediately while keeping established notification
    // subscribers alive long enough to receive session-release frames. Any
    // connection that has not opted in cannot receive the shutdown reason, so
    // close it now and let its proxy reconnect to the successor daemon.
    void this.callbacks.closeListeningServer(
      classifySocketPath(this.state.socketFileIdentity, this.state.socketPath),
    );
    for (const [sessionId, socket] of this.state.clientSockets) {
      if (!this.state.notificationSubscribers.has(sessionId) && !socket.destroyed) {
        socket.end();
      }
    }
    await this.callbacks.drainActiveRequestHandlers();
  }
  /** Wait for release frames to flush to client sockets, bounded for shutdown. */
  async drainSessionReleaseNotifications(): Promise<void> {
    const pendingWrites = Array.from(this.state.pendingSessionReleaseWrites);
    if (pendingWrites.length === 0) {
      return;
    }
    const timedOut = Symbol("notification drain timeout");
    let drained = true;
    try {
      await raceWithDeadline(Promise.allSettled(pendingWrites), {
        timer: this.state.timer,
        timeoutMs: DAEMON_NOTIFICATION_WRITE_DRAIN_TIMEOUT_MS,
        label: "Session release notification drain",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      drained = false;
    }
    if (!drained) {
      logger.warn(
        `Timed out waiting for ${pendingWrites.length} session-release notification(s) to flush during shutdown`,
      );
    }
  }
  /**
   * Stop the Unix socket server
   */
  async close(): Promise<void> {
    logger.info("Closing Unix socket server...");
    this.callbacks.stopAcceptingAndFanOut();
    this.state.lifecycleGeneration += 1;
    this.state.restartAdmission.releaseAll();
    // Keep sockets and session bookkeeping alive while handlers finish and write.
    // The listener stops new connections now; existing requests get the bounded drain.
    const clientSockets = Array.from(this.state.clientSockets.values());
    const socketPathState = classifySocketPath(
      this.state.socketFileIdentity,
      this.state.socketPath,
    );
    const serverClosed = this.callbacks.closeListeningServer(socketPathState);
    // Queued requests have not started device work and must not begin during shutdown.
    for (const pending of this.state.pendingSocketRequests) {
      if (!pending.admitted) {
        this.callbacks.writeShutdownSocketResponse(pending);
      }
    }
    const requestHandlersDrained = this.callbacks.drainActiveRequestHandlers();
    await requestHandlersDrained;
    for (const pending of this.state.pendingSocketRequests) {
      this.callbacks.writeShutdownSocketResponse(pending);
    }
    this.callbacks.destroyClientSockets(clientSockets);
    await serverClosed;
    this.state.sessions.clear();
    this.state.clientSockets.clear();
    this.state.notificationSubscribers.clear();
    this.state.resourceSubscriptions.clear();
    this.state.server = null;
    this.state.boundMcpClientKeysBySocketSession.clear();
    for (const timer of this.state.forwardKeyIdleTimers.values()) {
      this.state.timer.clearTimeout(timer);
    }
    this.state.forwardKeyIdleTimers.clear();
    this.state.mcpForwardTails.clear();
    this.state.mcpForwardIdleCloseKeys.clear();
    this.state.appendTextInputs.clear();
    // The listener removes the socket it created as part of close(). Do not
    // unlink the pathname afterward: a successor can bind in the interval and
    // filesystems are allowed to reuse the original socket inode immediately.
    this.state.socketFileIdentity = null;
  }
  writeShutdownSocketResponse(pending: PendingSocketRequest): void {
    this.callbacks.writeTerminalSocketResponse(pending, {
      id: pending.id,
      type: "mcp_response",
      success: false,
      error: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
      ...daemonShuttingDownFrameFields(daemonShuttingDownFailure(pending.admitted)),
    });
  }
  closeListeningServer(socketPathState: SocketPathState): Promise<void> {
    if (this.state.serverClosePromise) {
      return this.state.serverClosePromise;
    }
    if (!this.state.server) {
      return Promise.resolve();
    }
    if (socketPathState === "replaced") {
      logger.warn(
        `Unix socket path ${this.state.socketPath} no longer belongs to this server; leaving listener for process teardown`,
      );
      this.state.server.unref();
      return Promise.resolve();
    }
    this.state.serverClosePromise = new Promise((resolve) => {
      this.state.server!.close(() => {
        logger.info("Unix socket server closed");
        resolve();
      });
    });
    return this.state.serverClosePromise;
  }
  destroyClientSockets(clientSockets: Socket[]): void {
    for (const socket of clientSockets) {
      if (!socket.destroyed) {
        // `destroy()` may discard a just-flushed session-release frame and reset
        // the peer before it can read the exact daemon-shutdown reason. End the
        // writable side and destroy only after its buffer drains, with a bounded
        // fallback for a non-reading peer.
        const forceClose = this.state.timer.setTimeout(
          () => socket.destroy(),
          DAEMON_NOTIFICATION_WRITE_DRAIN_TIMEOUT_MS,
        );
        socket.once("close", () => this.state.timer.clearTimeout(forceClose));
        socket.end();
      }
    }
  }
  async drainActiveRequestHandlers(): Promise<void> {
    const handlers = Array.from(this.state.activeRequestHandlers);
    if (handlers.length === 0) {
      return;
    }
    const timedOut = Symbol("request handler drain timeout");
    let drained = true;
    try {
      await raceWithDeadline(Promise.allSettled(handlers), {
        timer: this.state.timer,
        timeoutMs: DAEMON_REQUEST_HANDLER_DRAIN_TIMEOUT_MS,
        label: "Unix socket request drain",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      drained = false;
    }
    if (!drained) {
      logger.warn(
        `Timed out waiting for ${handlers.length} in-flight Unix socket request handler(s) to finish during shutdown`,
      );
    }
  }
}
