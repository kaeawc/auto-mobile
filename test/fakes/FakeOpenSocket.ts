import { EventEmitter } from "events";
import type WebSocket from "ws";
import type { CtrlSocket } from "../../src/features/observe/shared/types";

/** `readyState` value of an open socket (the `ws` / WHATWG `OPEN` constant). */
const OPEN = 1;

/**
 * An always-open CtrlProxy socket that hands every outgoing frame to `onSend`.
 * Unlike {@link FakeWebSocket} it needs no handshake tick, so a test can attach
 * it synchronously to a delegate context that only reads `readyState` and `send`.
 */
export class FakeOpenSocket extends EventEmitter implements CtrlSocket {
  readonly readyState: number = OPEN;

  constructor(private readonly onSend: (frame: string) => void = () => {}) {
    super();
  }

  send(data: WebSocket.Data): void {
    this.onSend(typeof data === "string" ? data : String(data));
  }

  close(): void {}

  ping(): void {}

  terminate(): void {}
}
