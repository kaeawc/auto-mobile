import type fs from "node:fs";
import { Writable } from "node:stream";

export type WriteDone = (error: Error | null | undefined) => void;

/** Shape-complete `fs.WriteStream` stand-in. It extends a real `Writable` and adds the
 * members only `fs.WriteStream` has, so `createWriteStream` spies can return it uncast. */
export class FakeLogWriteStream extends Writable implements fs.WriteStream {
  bytesWritten = 0;
  path = "fake.log";
  pending = false;

  override write(chunk: unknown, callback?: WriteDone): boolean;
  override write(chunk: unknown, encoding: BufferEncoding, callback?: WriteDone): boolean;
  override write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
    return this.recordWrite(chunk, FakeLogWriteStream.callbackOf(encodingOrCallback, callback));
  }

  /** The seam subclasses override instead of re-declaring `write`'s overloads. */
  protected recordWrite(_chunk: unknown, done: WriteDone | undefined): boolean {
    queueMicrotask(() => done?.(null));
    return true;
  }

  close(callback?: (error?: NodeJS.ErrnoException | null) => void): void {
    this.end(() => callback?.());
  }

  /** Resolves a (chunk, [encoding], [callback]) argument tail to its callback. */
  static callbackOf(encodingOrCallback: unknown, callback: unknown): WriteDone | undefined {
    const candidate = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    return typeof candidate === "function" ? (error) => candidate(error) : undefined;
  }
}
