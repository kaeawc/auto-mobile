import http2 from "node:http2";
import { errorMessage } from "../../../models/describeUnknownError";
import {
  GrpcFrameDecoder,
  frameMessage,
  GrpcStatus,
  readGrpcStatus,
  type GrpcStatusResult,
} from "./grpcFraming";
import type { GrpcCall } from "./grpcTransport";

/** One gRPC call on an HTTP/2 stream: framed writes, a decoded message queue, and the final status. */
export class Http2GrpcCall implements GrpcCall {
  private readonly decoder = new GrpcFrameDecoder();
  private readonly queue: Uint8Array[] = [];
  private wake: (() => void) | undefined;
  private finished = false;
  private headers: http2.IncomingHttpHeaders | undefined;
  private readonly finalStatus: Promise<GrpcStatusResult>;

  constructor(private readonly stream: http2.ClientHttp2Stream) {
    stream.on("response", (headers) => {
      this.headers = headers;
    });
    stream.on("data", (chunk: Buffer) => this.onData(chunk));
    this.finalStatus = new Promise((resolve) => {
      let trailers: http2.IncomingHttpHeaders | undefined;
      stream.on("trailers", (received) => {
        trailers = received;
      });
      stream.on("error", (error) => {
        resolve({ code: GrpcStatus.UNAVAILABLE, message: errorMessage(error) });
      });
      stream.on("close", () => {
        this.finish();
        resolve(this.statusAtClose(trailers));
      });
    });
  }

  write(message: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stream.destroyed || this.stream.writableEnded) {
        reject(new Error("gRPC stream is closed"));
        return;
      }
      const onClose = () => reject(new Error("gRPC stream closed before the write completed"));
      // Bun drops the write callback when the stream dies before connecting, so close settles it too.
      this.stream.once("close", onClose);
      this.stream.write(frameMessage(message), (error) => {
        this.stream.off("close", onClose);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  end(): void {
    if (!this.stream.writableEnded) {
      this.stream.end();
    }
  }

  async *messages(): AsyncIterable<Uint8Array> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
      } else if (this.finished) {
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
    if (!this.stream.destroyed) {
      this.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
  }

  private onData(chunk: Buffer): void {
    try {
      this.queue.push(...this.decoder.push(chunk));
    } catch (error) {
      this.stream.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
    }
    this.notify();
  }

  private finish(): void {
    this.finished = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private statusAtClose(trailers: http2.IncomingHttpHeaders | undefined): GrpcStatusResult {
    const status = readGrpcStatus(trailers, this.headers);
    if (status) {
      return status;
    }
    if (this.stream.rstCode === http2.constants.NGHTTP2_CANCEL) {
      return { code: GrpcStatus.CANCELLED, message: "cancelled" };
    }
    return {
      code: GrpcStatus.UNKNOWN,
      message: `stream closed without a gRPC status (HTTP ${this.headers?.[":status"] ?? "none"})`,
    };
  }
}
