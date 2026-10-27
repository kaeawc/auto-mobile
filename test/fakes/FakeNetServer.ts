import { Server as NetServer, Socket, type SocketConnectOpts } from "node:net";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";

/** Any zod schema (v3 or v4): the frames are validated by `parse`, which throws on a mismatch. */
export interface FrameSchema<T> {
  parse(data: unknown): T;
}

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
  /** Called with each written frame, e.g. to deliver it to the other end of an in-memory pair. */
  public onWrite: ((frame: string) => void) | undefined;
  private _writtenData: string[] = [];
  private _peer: FakeSocket<unknown> | null = null;

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
   * Parse all written JSON messages (newline-delimited). With a `schema`, every frame is
   * validated against it and returned with the schema's output type; without one the frames are
   * `unknown`.
   */
  getWrittenMessages(): unknown[];
  getWrittenMessages<T>(schema: FrameSchema<T>): T[];
  getWrittenMessages(schema?: FrameSchema<unknown>): unknown[] {
    const lines = this.getWrittenDataString()
      .split("\n")
      .filter((line) => line.trim());
    const frames: unknown[] = lines.map((line) => JSON.parse(line));
    return schema === undefined ? frames : frames.map((frame) => schema.parse(frame));
  }

  /**
   * Connect this socket to a peer (for bidirectional communication)
   */
  connectToPeer(peer: FakeSocket<unknown>): void {
    this._peer = peer;
    peer._peer = this;
  }

  /**
   * Write data to the socket. Returns true if successful. The overloads mirror
   * `net.Socket#write`, so a `FakeSocket` is assignable wherever a `Socket` is expected.
   */
  write(buffer: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  write(
    str: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (err?: Error | null) => void,
  ): boolean;
  write(
    data: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean {
    if (this.destroyed && this.throwOnWriteAfterDestroy) {
      throw Object.assign(new Error("Socket is destroyed"), { code: "EPIPE" });
    }
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    const str = typeof data === "string" ? data : Buffer.from(data).toString();
    this.written.push(typeof data === "string" ? data : Buffer.from(data));
    this._writtenData.push(str);
    this.onWrite?.(str);
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
  end(callback?: () => void): this;
  end(buffer: string | Uint8Array, callback?: () => void): this;
  end(str: string | Uint8Array, encoding?: BufferEncoding, callback?: () => void): this;
  end(..._args: unknown[]): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.writable = false;
      this.emit("close", false);
    }
    return this;
  }

  /**
   * Simulate a connection event
   */
  connect(options: SocketConnectOpts, connectionListener?: () => void): this;
  connect(port: number, host: string, connectionListener?: () => void): this;
  connect(port: number, connectionListener?: () => void): this;
  connect(path: string, connectionListener?: () => void): this;
  connect(..._target: unknown[]): this {
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

type FakeListeningNetServerContract = Pick<NetServer, "listening">;

/** A net.Server that reports listening without binding a port, for socket-server subclasses under test. */
export class FakeListeningNetServer extends NetServer implements FakeListeningNetServerContract {
  override listening = true;
}
