import type {
  PrototypeAgentClient,
  PrototypeAgentHandshake,
  PrototypeAgentMessage,
  PrototypeAgentRequestType,
  PrototypeAgentResult,
} from "../../src/features/prototype/ios/prototypeAgentClient";

export const FAKE_PROTOTYPE_AGENT_CAPABILITIES = [
  "show_prototype",
  "dismiss_prototype",
  "put_prototype_asset",
  "remove_prototype_asset",
  "get_prototype_status",
  "prototype_show_in_place_v1",
  "prototype_inspect_v1",
  "prototype_text_field_options_v1",
];

type Reply = Partial<Omit<PrototypeAgentResult, "type" | "requestId">> | Error;

/** In-memory injected-agent connection: records requests, answers from a queue, pushes events. */
export class FakePrototypeAgentClient implements PrototypeAgentClient {
  readonly requests: Array<{ type: PrototypeAgentRequestType; body: PrototypeAgentMessage }> = [];
  readonly patchRequests: PrototypeAgentMessage[] = [];
  private patchReply?: Reply;
  private patchHold?: Promise<Reply>;
  setPatchResult(reply: Reply): void {
    this.patchReply = reply;
  }
  holdPatchReply(reply: Promise<Reply>): void {
    this.patchHold = reply;
  }
  closed = false;
  private readonly replies: Reply[] = [];
  private readonly eventListeners = new Set<(event: PrototypeAgentMessage) => void>();
  private nextRequestId = 1;

  constructor(
    readonly handshake: PrototypeAgentHandshake = {
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: FAKE_PROTOTYPE_AGENT_CAPABILITIES,
    },
  ) {}

  /** Replies, in order, for the next requests; afterwards every request succeeds. */
  queueReplies(...replies: Reply[]): void {
    this.replies.push(...replies);
  }

  async request(
    type: PrototypeAgentRequestType,
    body: PrototypeAgentMessage = {},
  ): Promise<PrototypeAgentResult> {
    this.requests.push({ type, body });
    if (type === "patch_prototype") {
      this.patchRequests.push(structuredClone(body));
    }
    const hold = type === "patch_prototype" ? this.patchHold : undefined;
    if (hold) {
      this.patchHold = undefined;
    }
    const reply = hold
      ? await hold
      : type === "patch_prototype" && this.patchReply
        ? this.patchReply
        : (this.replies.shift() ?? {});
    if (reply instanceof Error) {
      throw reply;
    }
    return {
      success: true,
      ...reply,
      type: "prototype_result",
      requestId: `r${this.nextRequestId++}`,
    };
  }

  onEvent(listener: (event: PrototypeAgentMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  listenerCount(): number {
    return this.eventListeners.size;
  }

  emit(event: PrototypeAgentMessage): void {
    this.eventListeners.forEach((listener) => listener(event));
  }

  onClosed(_listener: (error: Error) => void): () => void {
    return () => {};
  }

  close(): void {
    this.closed = true;
  }
}
