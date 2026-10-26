import type { HostChildProcess } from "../utils/HostCommandExecutor";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";

type Retention = "head" | "tail";

/** Fixed-size byte ring shared by stdout and diagnostic stderr retention. */
export class BoundedByteWindow {
  private readonly buffer: Buffer;
  private offset = 0;
  byteLength = 0;
  /** Byte immediately before the retained tail, for detecting a cut within a line. */
  precedingByte: number | undefined;

  constructor(
    private readonly maxBytes: number,
    private readonly retain: Retention,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new ActionableError("Child output byte bound must be a positive safe integer.");
    }
    this.buffer = Buffer.alloc(maxBytes);
  }

  append(chunk: Buffer): void {
    if (this.retain === "head") {
      this.byteLength += chunk.copy(
        this.buffer,
        this.byteLength,
        0,
        this.maxBytes - this.byteLength,
      );
      return;
    }
    const overflow = this.byteLength + chunk.length - this.maxBytes;
    if (overflow > 0) {
      const start = (this.offset - this.byteLength + this.maxBytes) % this.maxBytes;
      this.precedingByte =
        overflow <= this.byteLength
          ? this.buffer[(start + overflow - 1) % this.maxBytes]
          : chunk[overflow - this.byteLength - 1];
    }
    if (chunk.length >= this.maxBytes) {
      chunk.copy(this.buffer, 0, chunk.length - this.maxBytes);
      this.offset = 0;
    } else {
      const first = chunk.copy(this.buffer, this.offset);
      chunk.copy(this.buffer, 0, first);
      this.offset = (this.offset + chunk.length) % this.maxBytes;
    }
    this.byteLength = Math.min(this.maxBytes, this.byteLength + chunk.length);
  }

  bytes(): Buffer {
    if (this.byteLength < this.maxBytes || this.offset === 0 || this.retain === "head") {
      return this.buffer.subarray(0, this.byteLength);
    }
    // Rotate in place so decoding does not allocate a second maxBytes-sized buffer.
    this.buffer.subarray(0, this.offset).reverse();
    this.buffer.subarray(this.offset).reverse();
    this.buffer.reverse();
    this.offset = 0;
    return this.buffer;
  }
}

export interface BoundedStdout {
  text: string;
  totalBytes: number;
}

function ignoreLatePipeError(): void {
  // Settled already: the outcome was decided before this pipe error arrived.
}

/** Drain a child's output without execFile's whole-output buffer. Close follows stdio EOF. */
export function collectBoundedStdout(
  child: HostChildProcess,
  opts: { maxBytes: number; retain: Retention; signal?: AbortSignal },
): Promise<BoundedStdout> {
  const stdout = new BoundedByteWindow(opts.maxBytes, opts.retain);
  const stderr = new BoundedByteWindow(8192, "tail");
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const onStdout = (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      stdout.append(chunk);
    };
    const onStderr = (chunk: Buffer) => stderr.append(chunk);
    const cleanup = () => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.stdout?.off("error", onError);
      child.stderr?.off("error", onError);
      child.off("error", onError);
      child.off("close", onClose);
      opts.signal?.removeEventListener("abort", onAbort);
      // A late pipe error on a child that is still being killed must not become uncaught.
      child.stdout?.on("error", ignoreLatePipeError);
      child.stderr?.on("error", ignoreLatePipeError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(
        new ActionableError(
          `Unable to collect child output: ${errorMessage(error)}. ${stderr.bytes().toString("utf8")}`,
          { cause: error },
        ),
      );
    };
    const onAbort = () => {
      // Preserve the caller's reason even if kill synchronously emits close/error.
      cleanup();
      try {
        child.kill("SIGTERM");
      } finally {
        reject(opts.signal?.reason);
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0) {
        onError(new Error(`Child exited with ${signal ?? code}`));
        return;
      }
      cleanup();
      let bytes = stdout.bytes();
      const truncated = totalBytes > stdout.byteLength;
      if (truncated && opts.retain === "tail" && stdout.precedingByte !== 10) {
        const newline = bytes.indexOf(10);
        bytes = bytes.subarray(newline < 0 ? bytes.length : newline + 1);
      }
      // Streaming decode discards an incomplete suffix when head retention cuts a code point.
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes, {
        stream: truncated && opts.retain === "head",
      });
      resolve({ text, totalBytes });
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.stdout?.on("error", onError);
    child.stderr?.on("error", onError);
    child.on("error", onError);
    child.on("close", onClose);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) {
      onAbort();
    }
  });
}
