import type {
  OverlayAgentClient,
  OverlayAgentHandshake,
  OverlayAgentMessage,
  OverlayAgentRequestType,
  OverlayAgentResult,
} from "../../src/features/overlay/ios/overlayAgentClient";

export const FAKE_OVERLAY_AGENT_CAPABILITIES = [
  "show_overlay",
  "dismiss_overlay",
  "put_overlay_asset",
  "remove_overlay_asset",
  "get_overlay_status",
];

type Reply = Partial<Omit<OverlayAgentResult, "type" | "requestId">> | Error;

/** In-memory injected-agent connection: records requests, answers from a queue, pushes events. */
export class FakeOverlayAgentClient implements OverlayAgentClient {
  readonly requests: Array<{ type: OverlayAgentRequestType; body: OverlayAgentMessage }> = [];
  closed = false;
  private readonly replies: Reply[] = [];
  private readonly eventListeners = new Set<(event: OverlayAgentMessage) => void>();
  private nextRequestId = 1;

  constructor(
    readonly handshake: OverlayAgentHandshake = {
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: FAKE_OVERLAY_AGENT_CAPABILITIES,
    },
  ) {}

  /** Replies, in order, for the next requests; afterwards every request succeeds. */
  queueReplies(...replies: Reply[]): void {
    this.replies.push(...replies);
  }

  async request(
    type: OverlayAgentRequestType,
    body: OverlayAgentMessage = {},
  ): Promise<OverlayAgentResult> {
    this.requests.push({ type, body });
    const reply = this.replies.shift() ?? {};
    if (reply instanceof Error) {
      throw reply;
    }
    return {
      success: true,
      ...reply,
      type: "overlay_result",
      requestId: `r${this.nextRequestId++}`,
    };
  }

  onEvent(listener: (event: OverlayAgentMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  listenerCount(): number {
    return this.eventListeners.size;
  }

  emit(event: OverlayAgentMessage): void {
    this.eventListeners.forEach((listener) => listener(event));
  }

  onClosed(_listener: (error: Error) => void): () => void {
    return () => {};
  }

  close(): void {
    this.closed = true;
  }
}
