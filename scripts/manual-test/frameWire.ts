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
export class LineDecoder {
  private tail = Buffer.alloc(0);
  /** limit=1 preserves every byte after a video acknowledgement, including binary newlines. */
  push(chunk: Buffer | string, limit = Infinity): string[] {
    this.tail = Buffer.concat([this.tail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const lines: string[] = [];
    while (lines.length < limit) {
      const index = this.tail.indexOf(10);
      if (index < 0) {
        break;
      }
      lines.push(this.tail.subarray(0, index).toString("utf8"));
      this.tail = this.tail.subarray(index + 1);
    }
    return lines;
  }
  remainder(): Buffer {
    return this.tail;
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
