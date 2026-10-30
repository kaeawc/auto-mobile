import {
  GrpcStatus,
  type GrpcStatusResult,
} from "../../src/utils/android-cmdline-tools/emulatorGrpc/grpcFraming";
import type {
  GrpcCall,
  GrpcTransport,
} from "../../src/utils/android-cmdline-tools/emulatorGrpc/grpcTransport";

/**
 * A scripted gRPC call. Writes are recorded; `onWrite` can hold a write open to model the
 * emulator's back-pressure. Responses are pushed with `respond` and the call closes with `finish`.
 */
export class FakeGrpcCall implements GrpcCall {
  readonly written: Uint8Array[] = [];
  ended = false;
  cancelled = false;
  onWrite: ((index: number) => Promise<void> | void) | undefined;
  /** Status when the client half-closes and the server has not finished on its own. */
  statusOnEnd: GrpcStatusResult | undefined = { code: GrpcStatus.OK, message: "" };

  private readonly responses: Uint8Array[] = [];
  private closed = false;
  private wake: (() => void) | undefined;
  private resolveStatus!: (status: GrpcStatusResult) => void;
  private readonly finalStatus = new Promise<GrpcStatusResult>((resolve) => {
    this.resolveStatus = resolve;
  });
  private readonly pendingWrites = new Set<(error: Error) => void>();

  constructor(
    readonly method: string,
    readonly metadata: Readonly<Record<string, string>>,
  ) {}

  async write(message: Uint8Array): Promise<void> {
    if (this.closed || this.ended) {
      throw new Error("write after close");
    }
    const index = this.written.push(message) - 1;
    const hook = this.onWrite?.(index);
    if (hook) {
      await new Promise<void>((resolve, reject) => {
        this.pendingWrites.add(reject);
        hook.then(resolve, reject).finally(() => this.pendingWrites.delete(reject));
      });
    }
  }

  end(): void {
    this.ended = true;
    if (this.statusOnEnd) {
      this.finish(this.statusOnEnd);
    }
  }

  async *messages(): AsyncIterable<Uint8Array> {
    for (;;) {
      const next = this.responses.shift();
      if (next) {
        yield next;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    }
  }

  status(): Promise<GrpcStatusResult> {
    return this.finalStatus;
  }

  cancel(): void {
    this.cancelled = true;
    for (const reject of this.pendingWrites) {
      reject(new Error("cancelled"));
    }
    this.finish({ code: GrpcStatus.CANCELLED, message: "cancelled" });
  }

  respond(message: Uint8Array): void {
    this.responses.push(message);
    this.notify();
  }

  finish(status: GrpcStatusResult): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolveStatus(status);
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

export class FakeGrpcTransport implements GrpcTransport {
  readonly calls: FakeGrpcCall[] = [];
  closed = false;
  /** Configures each call before the client sees it. */
  onOpen: ((call: FakeGrpcCall) => void) | undefined;

  open(method: string, metadata: Readonly<Record<string, string>>): FakeGrpcCall {
    const call = new FakeGrpcCall(method, metadata);
    this.onOpen?.(call);
    this.calls.push(call);
    return call;
  }

  close(): void {
    this.closed = true;
  }
}
