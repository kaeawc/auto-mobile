import http2 from "node:http2";
import type { GrpcStatusResult } from "./grpcFraming";
import { Http2GrpcCall } from "./Http2GrpcCall";
import { errorMessage } from "../../../models/describeUnknownError";
import { logger } from "../../logger";

/** One streaming gRPC call. Requests are written as raw messages; framing is the transport's job. */
export interface GrpcCall {
  /** Resolves once the message is accepted, so a slow server paces the writer. */
  write(message: Uint8Array): Promise<void>;
  /** Half-closes the request stream. */
  end(): void;
  /** Response messages in arrival order; ends when the server closes the stream. */
  messages(): AsyncIterable<Uint8Array>;
  /** The final status. Transport failures resolve as UNAVAILABLE rather than rejecting. */
  status(): Promise<GrpcStatusResult>;
  /**
   * Resolves when response headers arrive: their gRPC status for a trailers-only response,
   * or undefined when they contain no grpc-status. Never rejects; stays pending if no headers arrive.
   */
  responseHeaders(): Promise<GrpcStatusResult | undefined>;
  /** Aborts the call (RST_STREAM CANCEL). Idempotent. */
  cancel(): void;
}

export interface GrpcTransport {
  open(method: string, metadata: Readonly<Record<string, string>>): GrpcCall;
  close(): void;
}

/** A plaintext HTTP/2 connection to `host:port`, as the emulator serves gRPC on localhost. */
export class Http2GrpcTransport implements GrpcTransport {
  private session: http2.ClientHttp2Session | undefined;

  constructor(private readonly address: string) {}

  open(method: string, metadata: Readonly<Record<string, string>>): GrpcCall {
    const session = this.connect();
    const stream = session.request({
      ":method": "POST",
      ":path": method,
      "content-type": "application/grpc",
      te: "trailers",
      ...metadata,
    });
    return new Http2GrpcCall(stream);
  }

  close(): void {
    this.session?.close();
    this.session = undefined;
  }

  private connect(): http2.ClientHttp2Session {
    if (!this.session || this.session.closed || this.session.destroyed) {
      const session = http2.connect(`http://${this.address}`);
      session.on("error", (error) => {
        // Each open stream also fails with this error and reports it as its call status.
        logger.debug(`emulator gRPC session error: ${errorMessage(error)}`);
      });
      this.session = session;
    }
    return this.session;
  }
}
