import type { PrototypeChannelHost } from "../prototypeChannelHost";
import type { PrototypeRequestHost } from "../prototypeRequestHandler";
import {
  type PrototypeAgentClient,
  type PrototypeAgentMessage,
  type PrototypeAgentRequestType,
  type PrototypeAgentResult,
} from "./prototypeAgentClient";

export const REPLAY_LIMIT = 256;

/** Buffers only until the first subscription; subsequent subscribers receive live events only. */
export class BufferedViewerClient implements PrototypeAgentClient {
  private readonly events: PrototypeAgentMessage[] = [];
  private readonly listeners = new Set<(event: PrototypeAgentMessage) => void>();
  private buffering = true;
  private replayDelivered = false;
  private closedError: Error | undefined;
  private readonly closedListeners = new Set<(error: Error) => void>();

  constructor(private readonly client: PrototypeAgentClient) {
    const unsubscribe = client.onEvent((event) => {
      if (this.buffering) {
        if (this.events.length === REPLAY_LIMIT) {
          this.events.shift();
        }
        this.events.push(event);
      } else {
        this.listeners.forEach((listener) => listener(event));
      }
    });
    client.onClosed((error) => {
      this.closedError = error;
      unsubscribe();
      this.events.length = 0;
      this.listeners.clear();
      this.closedListeners.forEach((listener) => listener(error));
      this.closedListeners.clear();
    });
  }

  get handshake() {
    return this.client.handshake;
  }
  request(
    type: PrototypeAgentRequestType,
    body?: PrototypeAgentMessage,
    options?: { timeoutMs?: number },
  ): Promise<PrototypeAgentResult> {
    return this.client.request(type, body, options);
  }
  onEvent(listener: (event: PrototypeAgentMessage) => void): () => void {
    this.listeners.add(listener);
    if (!this.replayDelivered) {
      this.replayDelivered = true;
      // Keep live pushes queued during delivery, including reentrant pushes from the listener.
      while (this.events.length > 0) {
        listener(this.events.shift()!);
      }
      this.buffering = false;
    }
    return () => this.listeners.delete(listener);
  }
  onClosed(listener: (error: Error) => void): () => void {
    if (this.closedError !== undefined) {
      listener(this.closedError);
    } else {
      this.closedListeners.add(listener);
    }
    return () => this.closedListeners.delete(listener);
  }
  attachRequestHost(host: PrototypeRequestHost | undefined): void {
    this.client.attachRequestHost?.(host);
  }
  attachChannelHost(host: PrototypeChannelHost | undefined): void {
    this.client.attachChannelHost?.(host);
  }
  close(): void {
    this.client.close();
  }
}
