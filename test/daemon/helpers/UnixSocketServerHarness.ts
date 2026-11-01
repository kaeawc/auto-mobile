import type { Server as NetServer, Socket } from "node:net";
import { UnixSocketServer, type StrokeAdmission } from "../../../src/daemon/socketServer";
import type { ProgressExtendableDeadline } from "../../../src/daemon/mcpRequestTimeout";
import type { SocketRequestHandling } from "../../../src/daemon/socketServerParts/SocketAdmission";
import type { BootedDevice } from "../../../src/models";
import type { DaemonNotification, DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import type { ResourceUpdateTargets } from "../../../src/daemon/listChangedBroadcast";
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

  /** Whether a forward is queued under this execution key. */
  hasForwardTail(key: string): boolean {
    return this.mcpForwardTails.has(key);
  }

  /** Wait for every in-flight request handler, however each one ends. */
  async settleActiveRequestHandlers(): Promise<void> {
    await Promise.allSettled([...this.activeRequestHandlers]);
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
    this.writeFrameData(socket, sessionId, frame, { onFlushed });
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
      options: { receivedAtMs: number; handling?: SocketRequestHandling },
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
    return this.handleRequest(sessionId, socket, request, { receivedAtMs });
  }

  /** Run the real local (non-forwarded) handler for one request. */
  dispatchLocalRequest(request: DaemonRequest): Promise<unknown> {
    return this.handleLocalSocketRequest(request);
  }

  /** Run the real owned-session restore step for one call's raw `arguments`. */
  restoreSessions(args: unknown, socketSessionId: string): Promise<void> {
    return this.restoreSelectorSessions(args, socketSessionId);
  }

  /** Run the real release-time lift of strokes the released session still holds. */
  liftStrokesHeldBy(releasedSessionId: string): Promise<void> {
    return super.liftStrokesHeldBy(releasedSessionId);
  }

  strokeAdmissionStillHolds(admission: StrokeAdmission): boolean {
    return super.strokeAdmissionStillHolds(admission);
  }

  /** Forward one request through the real MCP-client passthrough. */
  forwardIdeRequest(...args: Parameters<UnixSocketServerHarness["handleIdeRequest"]>) {
    return this.handleIdeRequest(...args);
  }

  /** Replace the MCP forward step so a request's completion is controlled by the test. */
  set mcpForwarder(
    handler: (
      context: Parameters<UnixSocketServerHarness["forwardMcpRequest"]>[0],
    ) => Promise<unknown>,
  ) {
    this.forwardMcpRequest = handler;
  }

  /** Run one function on the real per-execution-key forward chain. */
  runKeyedForward<T>(executionKey: string, fn: () => Promise<T>): Promise<T> {
    return this.runKeyedMcpForward(executionKey, fn);
  }

  /** Forward through the real route/client acquisition path. */
  forwardRequest(context: Parameters<UnixSocketServerHarness["forwardMcpRequest"]>[0]) {
    return this.forwardMcpRequest(context);
  }

  /** The per-request abort signal an owner socket's forwards share. */
  requestSignalFor(sessionId: string) {
    return this.mcpRequestSignal(sessionId);
  }

  abortSessionMcpRequests(sessionId: string): void {
    this.abortMcpRequests(sessionId);
  }

  /** The live remaining budget, and the pre-flight check that enforces it. */
  remainingForwardBudget(deadline: ProgressExtendableDeadline): number {
    return this.remainingMcpForwardBudget({ deadline });
  }

  requireForwardBudget(
    ...args: Parameters<UnixSocketServerHarness["requireRemainingMcpForwardBudget"]>
  ): number {
    return this.requireRemainingMcpForwardBudget(...args);
  }

  pushProgress(...args: Parameters<UnixSocketServerHarness["pushProgressNotification"]>): void {
    this.pushProgressNotification(...args);
  }

  // Public re-exposure of protected members under their own names, so `spyOn(server, name)`
  // can observe or replace what the server itself calls.
  override handleIdeSocketRequest(...args: Parameters<UnixSocketServer["handleIdeSocketRequest"]>) {
    return super.handleIdeSocketRequest(...args);
  }

  override runIdeKeyValueMutation(...args: Parameters<UnixSocketServer["runIdeKeyValueMutation"]>) {
    return super.runIdeKeyValueMutation(...args);
  }

  override captureStrokeAdmission(...args: Parameters<UnixSocketServer["captureStrokeAdmission"]>) {
    return super.captureStrokeAdmission(...args);
  }

  override resolveInputTargetDevice(
    ...args: Parameters<UnixSocketServer["resolveInputTargetDevice"]>
  ) {
    return super.resolveInputTargetDevice(...args);
  }

  override answeringSessionRelease<T>(
    execution: Parameters<UnixSocketServer["answeringSessionRelease"]>[0],
    run: () => Promise<T>,
  ): Promise<T> {
    return super.answeringSessionRelease(execution, run);
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

  /** The booted-device lookup the ide/* handlers run before acting on a serial. */
  lookupBootedDevicesForIde(platform: "android" | "ios", serial: string): Promise<BootedDevice[]> {
    return this.listBootedDevicesForIdeAction(platform, serial);
  }

  /** Sockets that currently own an open streamed gesture. */
  get ownedGestureOwnerCount(): number {
    return this.ownedGestures.ownerCount;
  }

  /** The largest inbound frame this control server accepts from one peer. */
  get inboundFrameLimit(): number {
    return this.maxInboundFrameBytes;
  }

  /** Resolve the MCP forward route (executionKey/clientKey/session) one request would take. */
  forwardRouteFor(
    request: DaemonRequest,
    socketSessionId: string,
  ): ReturnType<UnixSocketServerHarness["getMcpForwardRoute"]> {
    return this.getMcpForwardRoute(request, socketSessionId);
  }

  /** Record the bound MCP client key a completed forward leaves behind, as the real path does. */
  recordForwardResult(
    ...args: Parameters<UnixSocketServerHarness["recordBoundMcpClientKey"]>
  ): void {
    this.recordBoundMcpClientKey(...args);
  }

  /** Pre-bind a socket session to an MCP client, as an earlier forward would have. */
  bindClient(
    socketSessionId: string,
    entry: {
      clientKey: string;
      executionKey: string;
      sessionUuid?: string;
      toolSelectionProfileUuid?: string;
      requiresLiveDaemonSession: boolean;
    },
  ): void {
    this.boundMcpClientKeysBySocketSession.set(socketSessionId, entry);
  }

  /** The arguments a tools/call forward would send, with the socket-session autolock key applied. */
  withAutolockKey(
    args: unknown,
    socketSessionId: string,
    timeoutMs: number,
  ): Record<string, unknown> {
    const forwarded = this.withSocketSessionAutolockKey(args, socketSessionId, timeoutMs);
    if (typeof forwarded !== "object" || forwarded === null || Array.isArray(forwarded)) {
      throw new Error("Expected forwarded tool arguments to be an object");
    }
    return Object.fromEntries(Object.entries(forwarded));
  }

  /** Replace how input requests pick their target device. */
  set inputTargetDeviceResolver(resolver: () => Promise<BootedDevice>) {
    this.resolveInputTargetDevice = resolver;
  }

  /** Replace the keyed input runner so the operation runs directly with the given signal. */
  runKeyedInputWith(signal: AbortSignal | undefined): void {
    this.runTrackedKeyedDeviceInput = async (_toolName, _device, operation) => operation(signal);
  }

  get pendingRequests() {
    return this.pendingSocketRequests;
  }

  get pendingRequestCount(): number {
    return this.pendingSocketRequests.size;
  }

  /** Ids of the sessions currently registered by accepted connections. */
  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Requests waiting in every registered session's admission queue. */
  get queuedRequestCount(): number {
    return [...this.sessions.values()].reduce(
      (count, context) => count + context.requestQueue.pendingCount,
      0,
    );
  }

  /** Socket-session ids that currently hold a socket-bound MCP client key. */
  get boundClientSocketSessionIds(): string[] {
    return [...this.boundMcpClientKeysBySocketSession.keys()];
  }

  /** The execution scope key a request's raw `arguments` resolve to. */
  scopeKeyFor(args: unknown): string | undefined {
    return this.getRequestArgumentScopeKey(args);
  }

  /** The session uuid a socket session's bound MCP client currently routes to. */
  boundSessionUuidFor(socketSessionId: string): string | undefined {
    return this.boundMcpClientKeysBySocketSession.get(socketSessionId)?.sessionUuid;
  }

  /** The underlying listening `net.Server`, or null before `start()` / after `close()`. */
  get netListener(): NetServer | null {
    return this.server;
  }

  /** Whether the broadcaster subscriptions taken by `start()` are still held. */
  get broadcasterSubscriptions(): { listChanged: boolean; sessionRelease: boolean } {
    return {
      listChanged: this.listChangedUnsubscribe !== null,
      sessionRelease: this.sessionReleaseUnsubscribe !== null,
    };
  }

  /** Drop one socket session's bound MCP client key, as its socket "close" handler does. */
  clearBoundClientKey(socketSessionId: string): void {
    this.clearBoundMcpClientKey(socketSessionId);
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
