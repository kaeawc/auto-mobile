import { CONTROL_SOCKET_MAX_FRAME_BYTES } from "../daemon/wire/LineFramer";
import { JsonRpcTopLevelIdScanner } from "./jsonRpcTopLevelIdScanner";

const NEWLINE = 0x0a;

/**
 * Bytes left under the control socket's frame cap for the envelope the stdio proxy
 * wraps around a forwarded request, so a request this transport admits also fits in
 * one control-socket frame.
 */
const CONTROL_SOCKET_ENVELOPE_HEADROOM_BYTES = 64 * 1024;

/**
 * Largest single MCP message (bytes, newline excluded) the stdio transport accepts.
 * It matches the streamable HTTP body cap and the control socket frame cap
 * (256 MiB, see `LineFramer.ts`) less the proxy envelope headroom, so a request one
 * transport admits is not refused by the other (#18330).
 */
export const STDIO_REQUEST_MAX_BYTES =
  CONTROL_SOCKET_MAX_FRAME_BYTES - CONTROL_SOCKET_ENVELOPE_HEADROOM_BYTES;

export interface OversizedStdioRequest {
  /** Bytes of the refused message, newline excluded. */
  readonly requestBytes: number;
  readonly limitBytes: number;
  /** The message's top-level JSON-RPC id, when it had one. */
  readonly id: string | number | undefined;
}

export interface StdioRequestFramerHandlers {
  /** One complete message, including its trailing newline. */
  onFrame(frame: Buffer): void;
  /** One message larger than the limit, after its newline arrived; its bytes were discarded. */
  onOversized(request: OversizedStdioRequest): void;
}

/**
 * Splits stdin into newline-delimited MCP messages and refuses any message larger
 * than `maxRequestBytes` without ending the stream. A refused message's bytes are
 * dropped as they arrive (only its id is kept), and framing resumes at the next
 * newline, so the session keeps serving later requests.
 */
export class StdioRequestFramer {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private oversized: { bytes: number; scanner: JsonRpcTopLevelIdScanner } | null = null;

  constructor(
    private readonly maxRequestBytes: number,
    private readonly handlers: StdioRequestFramerHandlers,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      this.accept(chunk.subarray(start, end));
      if (newline === -1) {
        return;
      }
      this.endFrame();
      start = newline + 1;
    }
  }

  private accept(segment: Buffer): void {
    if (segment.length === 0) {
      return;
    }
    if (this.oversized) {
      this.oversized.bytes += segment.length;
      this.oversized.scanner.push(segment);
      return;
    }
    if (this.pendingBytes + segment.length <= this.maxRequestBytes) {
      this.pending.push(segment);
      this.pendingBytes += segment.length;
      return;
    }
    const scanner = new JsonRpcTopLevelIdScanner();
    for (const held of this.pending) {
      scanner.push(held);
    }
    scanner.push(segment);
    this.oversized = { bytes: this.pendingBytes + segment.length, scanner };
    this.pending = [];
    this.pendingBytes = 0;
  }

  private endFrame(): void {
    const oversized = this.oversized;
    if (oversized) {
      this.oversized = null;
      this.handlers.onOversized({
        requestBytes: oversized.bytes,
        limitBytes: this.maxRequestBytes,
        id: oversized.scanner.id,
      });
      return;
    }
    const frame = Buffer.concat([...this.pending, Buffer.from([NEWLINE])]);
    this.pending = [];
    this.pendingBytes = 0;
    this.handlers.onFrame(frame);
  }
}
