import type { DaemonClientLike } from "../../src/daemon/client";
import { DaemonUnavailableError } from "../../src/daemon/client";
import type { DaemonNotification } from "../../src/daemon/types";

export interface FakeDaemonClientOptions {
  toolResult?: any;
  resourceResult?: any;
  daemonMethodResults?: Map<string, any>;
}

export class FakeDaemonClient implements DaemonClientLike {
  readonly callToolCalls: Array<{ toolName: string; params: Record<string, any> }> = [];
  readonly readResourceCalls: string[] = [];
  readonly callDaemonMethodCalls: Array<{ method: string; params: Record<string, any> }> = [];
  private connected = false;
  private toolResult: any;
  private resourceResult: any;
  private daemonMethodResults: Map<string, any>;
  private readonly notificationHandlers = new Set<(notification: DaemonNotification) => void>();
  subscribeToNotificationsCalls = 0;
  shouldFailConnect = false;
  shouldFailSubscribe = false;

  constructor(options: FakeDaemonClientOptions = {}) {
    this.toolResult = options.toolResult ?? { content: [{ type: "text", text: "success" }] };
    this.resourceResult = options.resourceResult ?? { contents: [{ uri: "test", text: "test" }] };
    this.daemonMethodResults = options.daemonMethodResults ?? new Map();
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
    this.callToolCalls.push({ toolName, params });
    return this.toolResult;
  }

  async readResource(uri: string): Promise<any> {
    this.readResourceCalls.push(uri);
    return this.resourceResult;
  }

  async callDaemonMethod(method: string, params: Record<string, any>): Promise<any> {
    this.callDaemonMethodCalls.push({ method, params });
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
  emitNotification(method: string, sessionId?: string): void {
    for (const handler of this.notificationHandlers) {
      handler({
        type: "daemon_notification",
        method,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    }
  }
}
