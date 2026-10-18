import type { Socket } from "node:net";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { ProgressExtendableDeadline } from "../../../src/daemon/mcpRequestTimeout";
import type { DaemonNotification, DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import type { ResourceUpdateTargets } from "../../../src/server/listChangedBroadcast";
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

  connect(socket: Socket): void {
    this.handleConnection(socket);
  }

  writeFrameTo(
    socket: Socket,
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
      socket: Socket,
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

  /** Run the real request handler for one request, bypassing frame parsing. */
  dispatchRequest(
    sessionId: string,
    socket: Socket,
    request: DaemonRequest,
    receivedAtMs: number,
  ): Promise<DaemonResponse | undefined> {
    return this.handleRequest(sessionId, socket, request, receivedAtMs);
  }

  /** Run the real local (non-forwarded) handler for one request. */
  dispatchLocalRequest(request: DaemonRequest): Promise<unknown> {
    return this.handleLocalSocketRequest(request);
  }

  releaseSocket(sessionId: string, socket: Socket): void {
    this.releaseSocketSession(sessionId, socket);
  }

  broadcastResourceUpdated(resolveTargets: ResourceUpdateTargets): void {
    super.broadcastResourceUpdated(resolveTargets);
  }

  /** Live views of the connection and subscription registries. */
  get state(): {
    clientSockets: Map<string, Socket>;
    resourceSubscriptions: Map<string, Set<string>>;
    notificationSubscribers: Set<string>;
    activeRequestHandlers: Set<Promise<void>>;
  } {
    return {
      clientSockets: this.clientSockets,
      resourceSubscriptions: this.resourceSubscriptions,
      notificationSubscribers: this.notificationSubscribers,
      activeRequestHandlers: this.activeRequestHandlers,
    };
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
