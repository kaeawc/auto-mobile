import type {
  PrototypeAgentClient,
  PrototypeAgentHandshake,
  PrototypeAgentMessage,
  PrototypeAgentResult,
} from "../../src/features/prototype/ios/prototypeAgentClient";
import type {
  PrototypeAgentDylibResolver,
  PrototypeAgentPortAllocator,
} from "../../src/features/prototype/ios/prototypeAgentInjection";
import type { ResolvedPrototypeAgent } from "../../src/features/prototype-agent/PrototypeAgentProvider";

export const FAKE_PROTOTYPE_AGENT_HANDSHAKE: PrototypeAgentHandshake = {
  agentVersion: "0.1.0",
  protocolVersion: 1,
  capabilities: ["show_prototype", "dismiss_prototype"],
};

/** A connected agent client that records closes and lets a test simulate the app exiting. */
export class FakePrototypeAgentClient implements PrototypeAgentClient {
  closeCount = 0;
  private readonly closedListeners = new Set<(error: Error) => void>();

  constructor(readonly handshake: PrototypeAgentHandshake = FAKE_PROTOTYPE_AGENT_HANDSHAKE) {}

  async request(type: string): Promise<PrototypeAgentResult> {
    return { type: "prototype_result", requestId: type, success: true };
  }

  onEvent(_listener: (event: PrototypeAgentMessage) => void): () => void {
    return () => {};
  }

  onClosed(listener: (error: Error) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  close(): void {
    this.closeCount++;
    this.notifyClosed(new Error("closed by host"));
  }

  /** The agent's side went away, e.g. the app exited. */
  exit(): void {
    this.notifyClosed(new Error("app exited"));
  }

  private notifyClosed(error: Error): void {
    const listeners = [...this.closedListeners];
    this.closedListeners.clear();
    listeners.forEach((listener) => listener(error));
  }
}

/** Hands out sequential ports per key and records releases. */
export class FakePrototypeAgentPorts implements PrototypeAgentPortAllocator {
  readonly allocated = new Map<string, number>();
  readonly released: string[] = [];
  allocateError: Error | undefined;
  private nextPort: number;

  constructor(firstPort = 8770) {
    this.nextPort = firstPort;
  }

  allocate(key: string): number {
    if (this.allocateError !== undefined) {
      throw this.allocateError;
    }
    const existing = this.allocated.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const port = this.nextPort++;
    this.allocated.set(key, port);
    return port;
  }

  release(key: string): void {
    this.released.push(key);
    this.allocated.delete(key);
  }
}

export class FakePrototypeAgentDylibResolver implements PrototypeAgentDylibResolver {
  calls = 0;
  error: Error | undefined;

  constructor(
    readonly resolved: ResolvedPrototypeAgent = {
      path: "/cache/prototype-agent/AutoMobilePrototypeAgent.dylib",
      source: "cache",
    },
  ) {}

  async ensure(): Promise<ResolvedPrototypeAgent> {
    this.calls++;
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.resolved;
  }
}
