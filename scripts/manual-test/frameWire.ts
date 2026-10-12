import { LineFramer } from "../../src/daemon/socketServer/LineFramer";
import type { DaemonRequest } from "../../src/daemon/types";

export function encodeJsonLine(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("A JSON line must contain a JSON value.");
  }
  return `${encoded}\n`;
}
export function encodeDaemonFrame(frame: {
  id: string;
  method: string;
  params?: unknown;
  type?: DaemonRequest["type"];
  timeoutMs?: number;
}): string {
  // DaemonClient.callDaemonMethod handles ide/input as daemon requests too;
  // tools/call uses its MCP request path.
  return encodeJsonLine({
    id: frame.id,
    type: frame.type ?? (frame.method === "tools/call" ? "mcp_request" : "daemon_request"),
    method: frame.method,
    params: frame.params === undefined ? {} : frame.params,
    ...(frame.timeoutMs === undefined ? {} : { timeoutMs: frame.timeoutMs }),
  });
}
export class HarnessFrameTooLargeError extends Error {
  constructor(
    readonly limitBytes: number,
    subject: string,
  ) {
    super(`${subject} frame exceeds ${limitBytes} bytes`);
    this.name = "HarnessFrameTooLargeError";
  }
}
/** Shared bounded line framing; raw bytes after a first-line boundary never enter the framer. */
export class LineDecoder {
  private readonly framer: LineFramer;
  private lines: string[] = [];
  private firstLineComplete = false;
  constructor(maxFrameBytes: number, subject = "Harness response") {
    this.framer = new LineFramer(maxFrameBytes, {
      onLine: (line) => this.lines.push(line),
      onOverflow: () => {
        throw new HarnessFrameTooLargeError(maxFrameBytes, subject);
      },
    });
  }
  push(chunk: Buffer | string): string[] {
    this.lines = [];
    this.framer.push(chunk);
    return this.lines;
  }
  /** Scan only incoming bytes: partial acknowledgement bytes remain solely in LineFramer. */
  pushFirst(chunk: Buffer): { line?: string; raw: Buffer } {
    if (this.framer.hasOverflowed) {
      return { raw: Buffer.alloc(0) };
    }
    if (this.firstLineComplete) {
      return { raw: chunk };
    }
    const newline = chunk.indexOf(0x0a);
    const [line] = this.push(newline < 0 ? chunk : chunk.subarray(0, newline + 1));
    if (newline < 0) {
      return { raw: Buffer.alloc(0) };
    }
    this.firstLineComplete = true;
    return { line, raw: chunk.subarray(newline + 1) };
  }
}
export interface FrameConnection {
  write(data: string): void;
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: (error?: Error) => void): void;
  end(): void;
  destroy(): void;
}
export type ConnectFrameSocket = (socketPath: string) => Promise<FrameConnection>;
