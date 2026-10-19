import type { ControlSocket } from "../../../src/daemon/socketServer/ControlConnection";
import type { ListChangedKind } from "../../../src/server/listChangedBroadcast";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { ProgressExtendableDeadline } from "../../../src/daemon/mcpRequestTimeout";
import type { DaemonNotification, DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import { fakeBindLock, unreachableMcpDispatcher } from "../../helpers/createTestUnixSocketServer";

/**
 * A `UnixSocketServer` whose protected collaborators are reachable through a few
 * named test seams, so tests drive connections, frames, and handler stubs without
 * casting the server to a private-member shape. The seams are thin wrappers over
 * the protected members; they add no behaviour.
 */
export class UnixSocketServerHarness extends UnixSocketServer {
  /** Behave as a server that already finished `start()` without opening a listener. */
  allowRequests(): void {
    this.acceptingRequests = true;
  }

  connect(socket: ControlSocket): void {
    this.handleConnection(socket);
  }

  writeFrameTo(
    socket: ControlSocket,
    sessionId: string,
    frame: DaemonResponse | DaemonNotification,
    onFlushed?: (error?: Error | null) => void,
  ): void {
    this.writeFrameData(socket, sessionId, frame, onFlushed);
  }

  /** Replace the local (non-forwarded) request handler. */
  set localRequestHandler(handler: (request: DaemonRequest) => Promise<unknown>) {
    this.handleLocalSocketRequest = handler;
  }

  /** Replace the whole request handler, including its admission callback. */
  set requestHandler(
    handler: (
      sessionId: string,
      socket: ControlSocket,
      request: DaemonRequest,
      receivedAtMs: number,
      onAdmitted?: (deadline: ProgressExtendableDeadline) => void,
    ) => Promise<DaemonResponse | undefined>,
  ) {
    this.handleRequest = handler;
  }

  /** Skip the device-stream frame-context check (no stream server runs in these tests). */
  stubFrameContextCheck(): void {
    this.requireCurrentFrameContext = () => {};
  }

  /** Run the real frame-context check (refuses a stale or unavailable context). */
  checkFrameContext(deviceId: string, frameContext: string | undefined, action: string): void {
    this.requireCurrentFrameContext(deviceId, frameContext, action);
  }

  /** Every list-changed fan-out this server was asked to make, in order. */
  readonly listChangedBroadcasts: ListChangedKind[] = [];

  protected override broadcastListChanged(kind: ListChangedKind): void {
    this.listChangedBroadcasts.push(kind);
    super.broadcastListChanged(kind);
  }

  /** The request handlers still running for accepted connections. */
  get activeHandlers(): Promise<void>[] {
    return [...this.activeRequestHandlers];
  }

  /** Whether forwarded work is queued behind the key (`device:<id>` for a device's input). */
  isForwardQueued(key: string): boolean {
    return this.mcpForwardTails.has(key);
  }

  /** Lift the strokes a released session still holds. */
  liftHeldStrokes(releasedSessionId: string): Promise<void> {
    return this.liftStrokesHeldBy(releasedSessionId);
  }

  /** The daemon process died: nothing is accepted or pushed again, and `close()`'s drain never runs. */
  abandon(): void {
    this.acceptingRequests = false;
    this.closing = true;
    for (const unsubscribe of [
      this.listChangedUnsubscribe,
      this.resourceUpdatedUnsubscribe,
      this.sessionReleaseUnsubscribe,
    ]) {
      unsubscribe?.();
    }
    this.listChangedUnsubscribe = null;
    this.resourceUpdatedUnsubscribe = null;
    this.sessionReleaseUnsubscribe = null;
  }

  get pendingRequestCount(): number {
    return this.pendingSocketRequests.size;
  }

  /** Ids of the sessions currently registered by accepted connections. */
  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }
}

/** Same defaults as `createTestUnixSocketServer`, but returning the harness. */
export function createHarnessServer(
  ...args: ConstructorParameters<typeof UnixSocketServer>
): UnixSocketServerHarness {
  return new UnixSocketServerHarness(
    args[0],
    args[1],
    args[2],
    args[3],
    { mcpDispatcher: unreachableMcpDispatcher, ...args[4] },
    args[5],
    { bindLock: fakeBindLock, ...(args[6] ?? {}) },
    args[7],
  );
}
