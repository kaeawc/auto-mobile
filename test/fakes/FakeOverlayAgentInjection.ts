import type {
  OverlayAgentClient,
  OverlayAgentHandshake,
  OverlayAgentMessage,
  OverlayAgentResult,
} from "../../src/features/overlay/ios/overlayAgentClient";
import type {
  OverlayAgentDylibResolver,
  OverlayAgentPortAllocator,
} from "../../src/features/overlay/ios/overlayAgentInjection";
import type { ResolvedOverlayAgent } from "../../src/features/overlay-agent/OverlayAgentProvider";

export const FAKE_OVERLAY_AGENT_HANDSHAKE: OverlayAgentHandshake = {
  agentVersion: "0.1.0",
  protocolVersion: 1,
  capabilities: ["show_overlay", "dismiss_overlay"],
};

/** A connected agent client that records closes and lets a test simulate the app exiting. */
export class FakeOverlayAgentClient implements OverlayAgentClient {
  closeCount = 0;
  private readonly closedListeners = new Set<(error: Error) => void>();

  constructor(readonly handshake: OverlayAgentHandshake = FAKE_OVERLAY_AGENT_HANDSHAKE) {}

  async request(type: string): Promise<OverlayAgentResult> {
    return { type: "overlay_result", requestId: type, success: true };
  }

  onEvent(_listener: (event: OverlayAgentMessage) => void): () => void {
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
export class FakeOverlayAgentPorts implements OverlayAgentPortAllocator {
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

export class FakeOverlayAgentDylibResolver implements OverlayAgentDylibResolver {
  calls = 0;
  error: Error | undefined;

  constructor(
    readonly resolved: ResolvedOverlayAgent = {
      path: "/cache/overlay-agent/AutoMobileOverlayAgent.dylib",
      source: "cache",
    },
  ) {}

  async ensure(): Promise<ResolvedOverlayAgent> {
    this.calls++;
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.resolved;
  }
}
