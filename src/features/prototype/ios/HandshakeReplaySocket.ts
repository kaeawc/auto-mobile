import { LineFramer } from "../../../daemon/wire/LineFramer";
import { ActionableError } from "../../../models/ActionableError";
import {
  PROTOTYPE_AGENT_CLIENT_MAX_FRAME_BYTES,
  type PrototypeAgentSocket,
} from "./prototypeAgentClient";
import { REPLAY_LIMIT } from "./BufferedViewerClient";

/**
 * Forward the first nonempty frame (the hello reply) immediately. Hold subsequent frames until
 * the client has an event listener, even when hello and replay arrive in a single socket chunk.
 * Framing stays in LineFramer; JSON validation and authentication stay in connectPrototypeAgent.
 */
export class HandshakeReplaySocket implements PrototypeAgentSocket {
  private readonly lines: string[] = [];
  private firstFrame = true;
  private released = false;
  private dataListener: ((chunk: string) => void) | undefined;
  private closeListener: ((error?: Error) => void) | undefined;
  private failure: Error | undefined;
  private readonly framer = new LineFramer(PROTOTYPE_AGENT_CLIENT_MAX_FRAME_BYTES, {
    onLine: (line) => {
      if (this.failure !== undefined || !line.trim()) {
        return;
      }
      if (this.firstFrame || this.released) {
        this.firstFrame = false;
        this.dataListener?.(`${line}\n`);
      } else {
        if (this.lines.length === REPLAY_LIMIT) {
          this.lines.shift();
        }
        this.lines.push(line);
      }
    },
    onOverflow: () => {
      this.failure = new ActionableError(
        "Prototype viewer response frame exceeded the client limit; reconnect to the viewer.",
      );
      this.lines.length = 0;
      this.socket.end();
      this.closeListener?.(this.failure);
    },
  });

  constructor(private readonly socket: PrototypeAgentSocket) {}
  write(data: string): void {
    this.socket.write(data);
  }
  end(): void {
    this.lines.length = 0;
    this.socket.end();
  }
  onData(listener: (chunk: string) => void): void {
    this.dataListener = listener;
    this.socket.onData((chunk) => this.framer.push(chunk));
  }
  onClose(listener: (error?: Error) => void): void {
    this.closeListener = listener;
    this.socket.onClose((error) => {
      this.failure = error ?? new ActionableError("Prototype viewer closed the connection.");
      this.lines.length = 0;
      listener(this.failure);
    });
  }
  release(): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    // Preserve ordering if forwarding a frame synchronously causes more socket data.
    while (this.lines.length > 0) {
      this.dataListener?.(`${this.lines.shift()!}\n`);
    }
    this.released = true;
  }
}
