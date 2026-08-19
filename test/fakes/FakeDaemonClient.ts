import type { DaemonClientLike } from "../../src/daemon/client";
import { DaemonUnavailableError } from "../../src/daemon/client";
import { DAEMON_BOUND_SESSION_PARAM } from "../../src/daemon/constants";
import type { DaemonNotification } from "../../src/daemon/types";

export interface FakeDaemonClientOptions {
  toolResult?: any;
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
  onCallDaemonMethod?: (method: string, params: Record<string, any>) => void | Promise<void>;
}

export class FakeDaemonClient implements DaemonClientLike {
  readonly callToolCalls: Array<{ toolName: string; params: Record<string, any> }> = [];
  readonly readResourceCalls: string[] = [];
  readonly readResourceParams: Array<Record<string, any>> = [];
  readonly callDaemonMethodCalls: Array<{ method: string; params: Record<string, any> }> = [];
  private connected = false;
  private toolResult: any;
  private resourceResult: any;
  private daemonMethodResults: Map<string, any>;
  private readonly onCallTool?: (toolName: string, params: Record<string, any>) => void | Promise<void>;
  private readonly onCallDaemonMethod?: (method: string, params: Record<string, any>) => void | Promise<void>;
  private readonly notificationHandlers = new Set<(notification: DaemonNotification) => void>();
  subscribeToNotificationsCalls = 0;
  shouldFailConnect = false;
  shouldFailSubscribe = false;

  constructor(options: FakeDaemonClientOptions = {}) {
    this.toolResult = options.toolResult ?? { content: [{ type: "text", text: "success" }] };
    this.resourceResult = options.resourceResult ?? { contents: [{ uri: "test", text: "test" }] };
    this.daemonMethodResults = options.daemonMethodResults ?? new Map();
    this.onCallTool = options.onCallTool;
    this.onCallDaemonMethod = options.onCallDaemonMethod;
  }

  async connect(): Promise<void> {
    if (this.shouldFailConnect) {
      throw new DaemonUnavailableError("Connection failed");
    }
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async callTool(toolName: string, params: Record<string, any>): Promise<any> {
    const recordedParams = { ...params };
    delete recordedParams[DAEMON_BOUND_SESSION_PARAM];
    this.callToolCalls.push({ toolName, params: recordedParams });
    if (this.onCallTool) {
      await this.onCallTool(toolName, params);
    }
    return this.toolResult;
  }

  async readResource(uri: string, params: Record<string, any> = {}): Promise<any> {
    this.readResourceCalls.push(uri);
    const recordedParams = { ...params };
    delete recordedParams[DAEMON_BOUND_SESSION_PARAM];
    this.readResourceParams.push(recordedParams);
    return this.resourceResult;
  }

  async callDaemonMethod(method: string, params: Record<string, any>): Promise<any> {
    const recordedParams = { ...params };
    delete recordedParams[DAEMON_BOUND_SESSION_PARAM];
    this.callDaemonMethodCalls.push({ method, params: recordedParams });
    if (this.onCallDaemonMethod) {
      await this.onCallDaemonMethod(method, params);
    }
    return this.daemonMethodResults.get(method) ?? {};
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

  async subscribeToNotifications(): Promise<void> {
    this.subscribeToNotificationsCalls += 1;
    if (this.shouldFailSubscribe) {
      throw new Error("Unsupported daemon method: daemon/subscribe-notifications");
    }
  }

  /** Test hook: simulate a daemon-pushed notification frame. */
  emitNotification(method: string, sessionId?: string, reason?: string): void {
    for (const handler of this.notificationHandlers) {
      handler({
        type: "daemon_notification",
        method,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    }
  }
}
