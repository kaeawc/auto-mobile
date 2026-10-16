import { Socket } from "node:net";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";

type FakeSocketContract = Pick<Socket, "destroyed" | "writable" | "destroy">;

/**
 * Fake Socket for testing socket-based servers without real network connections.
 * Works cross-platform (Windows, macOS, Linux) and doesn't require file system.
 */
export class FakeSocket<Response = DaemonResponse> extends Socket implements FakeSocketContract {
  public destroyed = false;
  public writable = true;
  /** When true (default), writing after destroy throws an EPIPE-coded error. */
  public throwOnWriteAfterDestroy = true;
  /** Value returned from `write`; set false to model named-pipe backpressure. */
  public writeReturnValue = true;
  readonly written: Array<string | Buffer> = [];
  get writes(): string[] {
    return this.getWrittenData();
  }
  /** Each written frame parsed as JSON (one JSON document per `write`). */
  get responses(): Response[] {
    return this._writtenData.map((frame) => JSON.parse(frame) as Response);
  }
  private _writtenData: string[] = [];
  private _peer: FakeSocket | null = null;

  /**
   * Get all data written to this socket
   */
  resetWrittenData(): void {
    this._writtenData = [];
  }

  getWrittenData(): string[] {
    return [...this._writtenData];
  }

  /**
   * Get all written data as a single string
   */
  getWrittenDataString(): string {
    return this._writtenData.join("");
  }

  /**
   * Parse all written JSON messages (newline-delimited)
   */
  getWrittenMessages<T = unknown>(): T[] {
    const allData = this.getWrittenDataString();
    const lines = allData.split("\n").filter((line) => line.trim());
    return lines.map((line) => JSON.parse(line) as T);
  }

  /**
   * Connect this socket to a peer (for bidirectional communication)
   */
  connectToPeer(peer: FakeSocket): void {
    this._peer = peer;
    peer._peer = this;
  }

  /**
   * Write data to the socket. Returns true if successful.
   */
  write(data: string | Buffer, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed && this.throwOnWriteAfterDestroy) {
      throw Object.assign(new Error("Socket is destroyed"), { code: "EPIPE" });
    }
    const str = typeof data === "string" ? data : data.toString();
    this.written.push(typeof data === "string" ? data : Buffer.from(data));
    this._writtenData.push(str);
    callback?.();
    return this.writeReturnValue;
  }

  /** Inert: a real Socket would arm an idle timer. */
  setTimeout(_timeout?: number, _callback?: () => void): this {
    return this;
  }

  /** Simulate a client sending one newline-terminated JSON request frame. */
  send(request: DaemonRequest): void {
    this.simulateData(`${JSON.stringify(request)}\n`);
  }

  /** Simulate raw bytes arriving from the client. */
  sendRaw(text: string): void {
    this.simulateData(text);
  }

  /**
   * Simulate receiving data on this socket (triggers 'data' event)
   */
  simulateData(data: string): void {
    if (!this.destroyed) {
      this.emit("data", Buffer.from(data));
    }
  }

  feed(chunk: Buffer): void {
    if (!this.destroyed) {
      this.emit("data", chunk);
    }
  }

  /**
   * Send data to the peer socket (simulates data going through the connection)
   */
  sendToPeer(data: string): void {
    if (this._peer && !this._peer.destroyed) {
      this._peer.simulateData(data);
    }
  }

  /**
   * Destroy the socket
   */
  destroy(_error?: Error): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.writable = false;
      this.emit("close", false);
    }
    return this;
  }

  /**
   * End the socket gracefully
   */
  end(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      this.writable = false;
      this.emit("close", false);
    }
  }

  /**
   * Simulate a connection event
   */
  connect(_options: { path: string }): this {
    // In fake mode, connection is instant
    process.nextTick(() => {
      if (!this.destroyed) {
        this.emit("connect");
      }
    });
    return this;
  }

  /**
   * Simulate an error on the socket
   */
  simulateError(error: Error): void {
    this.emit("error", error);
  }

  /**
   * Reset the socket state for reuse in tests
   */
  reset(): void {
    this._writtenData = [];
    this.written.length = 0;
    this.destroyed = false;
    this.writable = true;
    this._peer = null;
    this.removeAllListeners();
  }
}

/**
 * FakeSocket that records writes made after `destroy()` instead of throwing, for
 * suites asserting on what a server still wrote to a client that went away.
 */
export class NonThrowingFakeSocket extends FakeSocket {
  public throwOnWriteAfterDestroy = false;
}
