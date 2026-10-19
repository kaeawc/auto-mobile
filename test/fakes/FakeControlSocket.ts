import { EventEmitter } from "node:events";
import type { ControlSocket } from "../../src/daemon/socketServer/ControlConnection";
import {
  daemonResponseSchema,
  type DaemonRequest,
  type DaemonResponse,
} from "../../src/daemon/types";

type WriteCallback = (error?: Error | null) => void;

/**
 * An in-process stand-in for the kernel socket a control-socket server accepts. It is structurally
 * a {@link ControlSocket}, so a test hands it to the server without a cast. A subclass decides what
 * a write does with the bytes ({@link transmit}); the base owns the `net.Socket` write overloads,
 * the close notification and the destroyed flag.
 */
export abstract class FakeControlSocket extends EventEmitter implements ControlSocket {
  destroyed = false;
  writableLength = 0;

  setTimeout(): this {
    return this;
  }

  /** Take what was written. Return an error to fail the write, as a closed socket does. */
  protected abstract transmit(data: string | Uint8Array): Error | undefined;

  write(data: string | Uint8Array, callback?: WriteCallback): boolean;
  write(data: string | Uint8Array, encoding: BufferEncoding, callback?: WriteCallback): boolean;
  write(
    data: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean {
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const error = this.transmit(data);
    done?.(error);
    return error === undefined;
  }

  end(): this {
    return this.destroy();
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }
}

/** A control socket that records the response frames the server writes and feeds it request frames. */
export class FakeFrameSocket extends FakeControlSocket {
  readonly responses: DaemonResponse[] = [];

  protected transmit(data: string | Uint8Array): undefined {
    this.responses.push(daemonResponseSchema.parse(JSON.parse(String(data))));
    return undefined;
  }

  /** The client writes a request frame. */
  send(frame: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  }

  answer(id: string): DaemonResponse | undefined {
    return this.responses.find((frame) => frame.id === id);
  }
}
