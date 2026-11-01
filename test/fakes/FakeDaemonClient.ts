import type {
  DaemonClientLike,
  DaemonMethodCallOptions,
  DaemonToolCallOptions,
} from "../../src/daemon/client/client";
import { DaemonRequestNotDeliveredError } from "../../src/daemon/DaemonRequestNotDeliveredError";
import type { TaskRelayFrame, TaskRelayMethod } from "../../src/daemon/tasks/taskRelay";
import { DaemonUnavailableError } from "../../src/daemon/client/client";
import { DAEMON_BOUND_SESSION_PARAM } from "../../src/daemon/wire/constants";
import type { DaemonNotification } from "../../src/daemon/types";
import { FakeIdGenerator } from "./FakeIdGenerator";

export interface FakeDaemonClientOptions {
  /**
   * A connection to a real daemon (#11441), e.g. `LivenessScenario.daemonConnection()`. With
   * it this client stops answering for the daemon: every tool call, resource read, daemon method
   * and notification subscription is forwarded to that connection and answered (or refused) by
   * it, and its pushed frames and connection close reach this client's handlers unchanged. The
   * client still records calls and runs its hooks first, so a test keeps its fault injection
   * (`shouldFailConnect`, a throwing `onCallTool`, `emitNotification`), and an answer the test
   * scripts explicitly (`toolResult`, `toolResultFor`, `resourceResult`,
   * `daemonMethodResults`, a hook's return value) still wins. Without it every answer is
   * hand-written: `{}` for any daemon method and a bare "success" tool result, which is not what
   * a daemon answers (no heartbeat ack fields, no refusals, no activity echo).
   */
  daemon?: DaemonClientLike;
  toolResult?: any;
  // Per-tool result override. When it returns a value for a given call, that
  // value is the tool result instead of `toolResult`; returning undefined falls
  // back to `toolResult`. Lets a test model a device-acquisition tool minting a
  // session id in its RESULT (issue #5689) while other tools return "success".
  toolResultFor?: (toolName: string, params: Record<string, any>) => any;
  resourceResult?: any;
  daemonMethodResults?: Map<string, any>;
  // Invoked inside callTool AFTER the call is recorded but BEFORE it resolves, so
  // a test can simulate a daemon push (e.g. a session-released notification)
  // arriving WHILE the call is in flight. May throw to simulate an
  // admitted-then-rejected call.
  onCallTool?: (toolName: string, params: Record<string, any>) => void | Promise<void>;
  // Same seam for callDaemonMethod (tools/list, resources/list, ...), so a test
  // can simulate a list_changed / session-released push arriving WHILE a
  // session-scoped discovery request is in flight (issue #4655).
  /** A returned value (other than undefined) is the method's result. */
  onCallDaemonMethod?: (method: string, params: Record<string, any>) => unknown;
  /**
   * Answers a relayed `tasks/*` request (#4668); it may throw to simulate the daemon's error or a
   * lost connection. Without it a relay is forwarded to `daemon`, else answered `{}`.
   */
  onRelayTaskMethod?: (
    method: TaskRelayMethod,
    params: Record<string, unknown>,
    tasks: TaskRelayFrame,
  ) => unknown;
}

export class FakeDaemonClient implements DaemonClientLike {
  readonly callToolCalls: Array<{ toolName: string; params: Record<string, any> }> = [];
  readonly readResourceCalls: string[] = [];
  readonly readResourceParams: Array<Record<string, any>> = [];
  readonly readResourceSignals: Array<AbortSignal | undefined> = [];
  readonly callDaemonMethodCalls: Array<{ method: string; params: Record<string, any> }> = [];
  private connected = false;
  private readonly daemon?: DaemonClientLike;
  private readonly scriptedToolResult: boolean;
  private readonly scriptedResourceResult: boolean;
  private daemonUnsubscribes: Array<() => void> = [];
  private toolResult: any;
  private readonly toolResultFor?: (toolName: string, params: Record<string, any>) => any;
  private resourceResult: any;
  private daemonMethodResults: Map<string, any>;
  private readonly onCallTool?: (
    toolName: string,
    params: Record<string, any>,
  ) => void | Promise<void>;
  private readonly onCallDaemonMethod?: (method: string, params: Record<string, any>) => unknown;
  private readonly onRelayTaskMethod?: FakeDaemonClientOptions["onRelayTaskMethod"];
  /** Each `callTool`'s options, `undefined` when the call passed none. */
  readonly callToolOptions: Array<DaemonToolCallOptions | undefined> = [];
  readonly relayTaskCalls: Array<{
    method: TaskRelayMethod;
    params: Record<string, unknown>;
    tasks: TaskRelayFrame;
  }> = [];
  private readonly notificationHandlers = new Set<(notification: DaemonNotification) => void>();
  private readonly connectionClosedHandlers = new Set<() => void>();
  subscribeToNotificationsCalls = 0;
  shouldFailConnect = false;
  shouldFailSubscribe = false;

  constructor(options: FakeDaemonClientOptions = {}) {
    this.daemon = options.daemon;
    this.scriptedToolResult = options.toolResult !== undefined;
    this.scriptedResourceResult = options.resourceResult !== undefined;
    this.toolResult = options.toolResult ?? { content: [{ type: "text", text: "success" }] };
    this.toolResultFor = options.toolResultFor;
    this.resourceResult = options.resourceResult ?? { contents: [{ uri: "test", text: "test" }] };
    this.daemonMethodResults = options.daemonMethodResults ?? new Map();
    this.onCallTool = options.onCallTool;
    this.onCallDaemonMethod = options.onCallDaemonMethod;
    this.onRelayTaskMethod = options.onRelayTaskMethod;
  }

  async connect(): Promise<void> {
    if (this.shouldFailConnect) {
      throw new DaemonUnavailableError("Connection failed");
    }
    if (this.daemon && !this.connected) {
      this.daemonUnsubscribes = [
        this.daemon.onNotification?.((notification) => this.deliver(notification)),
        this.daemon.onConnectionClosed?.(() => this.emitConnectionClosed()),
      ].filter((unsubscribe) => unsubscribe !== undefined);
      await this.daemon.connect();
    }
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    // The real client forgets its handlers when it closes; a reconnect starts with none.
    this.notificationHandlers.clear();
    this.connectionClosedHandlers.clear();
    for (const unsubscribe of this.daemonUnsubscribes.splice(0)) {
      unsubscribe();
    }
    await this.daemon?.close();
  }

  private deliver(notification: DaemonNotification): void {
    for (const handler of [...this.notificationHandlers]) {
      this.runHandler(() => handler(notification));
    }
  }

  /** The real client logs a throwing handler and still serves the ones after it. */
  private runHandler(run: () => void): void {
    try {
      run();
    } catch {
      // Swallowed on purpose: one failing handler must not block its siblings.
    }
  }

  /**
   * The real client connects on demand; a daemon it cannot reach means the frame was never sent,
   * so a request rejects as not delivered. The fake is always reachable unless `shouldFailConnect`.
   */
  private assertReachable(): void {
    if (this.shouldFailConnect) {
      throw new DaemonRequestNotDeliveredError("Connection failed", {
        cause: new DaemonUnavailableError("Connection failed"),
      });
    }
  }

  /**
   * Rejects when `signal` aborts before `pending` settles, as the real client does for an
   * unanswered request. Without a signal `pending` is returned untouched, so a caller's await
   * costs the same turns as before.
   */
  private abortable<T>(
    pending: T | Promise<T>,
    signal: AbortSignal | undefined,
    onAbort: (reason: unknown) => Error,
  ): T | Promise<T> {
    if (!signal || !(pending instanceof Promise)) {
      return pending;
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(onAbort(signal.reason));
      signal.addEventListener("abort", abort, { once: true });
      // An abort that fired before the listener existed never calls it (the real client
      // rechecks `signal.aborted` after listening, client.ts ~L1457); reject now or hang forever.
      if (signal.aborted) {
        abort();
      }
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  readonly callToolProgressTokens: Array<string | number | undefined> = [];
  readonly callToolRequestIds: string[] = [];
  readonly callToolSignals: Array<AbortSignal | undefined> = [];
  private readonly requestIdGenerator = new FakeIdGenerator();

  async callTool(
    toolName: string,
    params: Record<string, any>,
    progressToken?: string | number,
    options?: DaemonToolCallOptions,
  ): Promise<any> {
    const onRequestId = options?.onRequestId;
    const signal = options?.signal;
    signal?.throwIfAborted();
    this.assertReachable();
    const abortReason = (reason: unknown) => reason as Error;
    this.callToolSignals.push(signal);
    // Recorded without the signal (captured above), so a call without a task relay records none.
    const tasks = options?.tasks;
    this.callToolOptions.push(tasks ? { tasks } : undefined);
    const requestId = this.requestIdGenerator.next();
    this.callToolRequestIds.push(requestId);
    onRequestId?.(requestId);
    const recordedParams = { ...params };
    delete recordedParams[DAEMON_BOUND_SESSION_PARAM];
    this.callToolCalls.push({ toolName, params: recordedParams });
    this.callToolProgressTokens.push(progressToken);
    if (this.onCallTool) {
      await this.abortable(this.onCallTool(toolName, params), signal, abortReason);
    }
    const perToolResult = this.toolResultFor?.(toolName, params);
    if (perToolResult !== undefined || this.scriptedToolResult || !this.daemon) {
      return perToolResult ?? this.toolResult;
    }
    // The request id was already reported for this hop; the daemon hop must not report another.
    const forwarded = options === undefined ? undefined : { ...options, onRequestId: undefined };
    return await this.daemon.callTool(toolName, params, progressToken, forwarded);
  }

  async relayTaskMethod(
    method: TaskRelayMethod,
    params: Record<string, unknown>,
    tasks: TaskRelayFrame,
    options: { signal?: AbortSignal } = {},
  ): Promise<any> {
    options.signal?.throwIfAborted();
    this.relayTaskCalls.push({ method, params, tasks });
    if (this.onRelayTaskMethod) {
      return await this.onRelayTaskMethod(method, params, tasks);
    }
    if (this.daemon?.relayTaskMethod) {
      return await this.daemon.relayTaskMethod(method, params, tasks, options);
    }
    return {};
  }

  async readResource(
    uri: string,
    params: Record<string, any> = {},
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<any> {
    signal?.throwIfAborted();
    this.assertReachable();
    this.readResourceSignals.push(signal);
    this.readResourceCalls.push(uri);
    const recordedParams = { ...params };
    delete recordedParams[DAEMON_BOUND_SESSION_PARAM];
    this.readResourceParams.push(recordedParams);
    if (this.scriptedResourceResult || !this.daemon) {
      return this.resourceResult;
    }
    return await this.daemon.readResource(uri, params, { signal });
  }

  async callDaemonMethod(
    method: string,
    params: Record<string, any>,
    options?: DaemonMethodCallOptions,
  ): Promise<any> {
    const signal = options?.signal;
    const aborted = (reason: unknown) =>
      new DaemonUnavailableError(`Daemon request ${method} aborted`, { cause: reason });
    if (signal?.aborted) {
      throw aborted(signal.reason);
    }
    if (this.shouldFailConnect) {
      // A daemon method surfaces the real client's own connect failure unchanged.
      throw new DaemonUnavailableError("Connection failed");
    }
    const recordedParams = { ...params };
    delete recordedParams[DAEMON_BOUND_SESSION_PARAM];
    this.callDaemonMethodCalls.push({ method, params: recordedParams });
    if (this.onCallDaemonMethod) {
      const result = await this.abortable(this.onCallDaemonMethod(method, params), signal, aborted);
      if (result !== undefined) {
        return result;
      }
    }
    if (this.daemonMethodResults.has(method) || !this.daemon) {
      return this.daemonMethodResults.get(method) ?? {};
    }
    return await this.daemon.callDaemonMethod(method, params, options);
  }

  isConnected(): boolean {
    return this.connected;
  }

  onNotification(handler: (notification: DaemonNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onConnectionClosed(handler: () => void): () => void {
    this.connectionClosedHandlers.add(handler);
    return () => {
      this.connectionClosedHandlers.delete(handler);
    };
  }

  /**
   * Like the real `handleSocketClosed` (client.ts ~L990), handlers run directly: a throwing one
   * propagates to the caller and the handlers after it are not run (unlike notification handlers).
   */
  emitConnectionClosed(): void {
    this.connected = false;
    for (const handler of [...this.connectionClosedHandlers]) {
      handler();
    }
  }

  async subscribeToNotifications(options?: { signal?: AbortSignal }): Promise<void> {
    this.subscribeToNotificationsCalls += 1;
    if (this.shouldFailSubscribe) {
      throw new Error("Unsupported daemon method: daemon/subscribe-notifications");
    }
    await this.daemon?.subscribeToNotifications?.(options);
  }

  /**
   * Test hook (issue #6205): simulate the daemon relaying a
   * `notifications/progress` tick for an in-flight `callTool`, tagged with the
   * SAME `progressToken` the fake received — mirrors what
   * `UnixSocketServer.pushProgressNotification` does for real.
   */
  emitProgress(
    progressToken: string | number,
    progress: number,
    total?: number,
    message?: string,
    requestId = this.callToolRequestIds.at(-1),
  ): void {
    for (const handler of [...this.notificationHandlers]) {
      this.runHandler(() =>
        handler({
          type: "daemon_notification",
          method: "notifications/progress",
          progressToken,
          requestId,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
        }),
      );
    }
  }

  /** Test hook: simulate a daemon-pushed notification frame. */
  emitNotification(
    method: string,
    sessionId?: string,
    reason?: string,
    release?: DaemonNotification["release"],
    uri?: string,
    recordingIds?: string[],
  ): void {
    for (const handler of [...this.notificationHandlers]) {
      this.runHandler(() =>
        handler({
          type: "daemon_notification",
          method,
          ...(recordingIds !== undefined ? { recordingIds } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(reason !== undefined ? { reason } : {}),
          ...(release !== undefined ? { release } : {}),
          ...(uri !== undefined ? { uri } : {}),
        }),
      );
    }
  }
}
