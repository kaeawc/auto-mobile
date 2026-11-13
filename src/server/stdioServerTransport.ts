import { PassThrough, type Readable, type Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import {
  type OversizedStdioRequest,
  STDIO_REQUEST_MAX_BYTES,
  StdioRequestFramer,
} from "./stdioRequestFramer";

/** JSON-RPC 2.0 "Invalid Request". */
const INVALID_REQUEST = -32600;

/**
 * The stdio server transport with the v1 SDK's end-of-input behaviour (issue #4678).
 *
 * The SDK v2 `StdioServerTransport` closes itself when stdin ends, which aborts every
 * in-flight request and drops its answer. The v1 transport ignored stdin's end: stdin
 * EOF belongs to `installStdinShutdownHandlers` and `OutputGatedTransport`, which still
 * answer the requests received before EOF (#11951, #12049). So the SDK transport reads a
 * feed that carries stdin's data but never ends; stdin's own `end`/`close` still reach the
 * lifecycle handlers, which listen on stdin directly.
 *
 * Like v1, stdin is only read between `start()` and `close()`. Data and an EOF that arrive
 * before `start()` stay buffered in stdin (a paused stream does not emit `end` until it is
 * read), so a request piped before the server connects is still delivered and answered.
 * stdin errors are reported through `onerror` only while started, as v1 did; forwarding
 * them into the feed would raise an unhandled `error` (an uncaught exception) before
 * `start()` or after `close()`, when the feed has no listener.
 */
class EofTolerantStdioServerTransport extends StdioServerTransport {
  constructor(
    private readonly source: Readable,
    private readonly feed: PassThrough,
    stdout: Writable,
    maxRequestBytes: number,
  ) {
    // One framed message plus its newline; the framer never writes more than that at once.
    super(feed, stdout, { maxBufferSize: maxRequestBytes + 1 });
    this.framer = new StdioRequestFramer(maxRequestBytes, {
      onFrame: (frame) => this.feed.write(frame),
      onOversized: (request) => this.rejectOversized(request),
    });
  }

  private readonly framer: StdioRequestFramer;

  private readonly forwardSourceData = (chunk: Buffer | string): void => {
    this.framer.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  };

  private readonly forwardSourceError = (error: Error): void => {
    this.onerror?.(error);
  };

  override async start(): Promise<void> {
    await super.start();
    this.source.on("error", this.forwardSourceError);
    this.source.on("data", this.forwardSourceData);
    // A listener alone does not resume a stream an earlier close() paused.
    this.source.resume();
  }

  override async close(): Promise<void> {
    this.source.off("error", this.forwardSourceError);
    this.source.off("data", this.forwardSourceData);
    if (this.source.listenerCount("data") === 0) {
      this.source.pause();
    }
    await super.close();
  }

  private rejectOversized(request: OversizedStdioRequest): void {
    const message =
      `MCP message of ${request.requestBytes} bytes exceeds the stdio transport limit of ` +
      `${request.limitBytes} bytes. Pass large files by host path (putAppFile files[].sourcePath) ` +
      "instead of contentBase64, or connect over the streamable HTTP transport.";
    logger.warn(`[stdio] ${message}`);
    if (request.id === undefined) {
      // A notification, or a message without a readable id, has no response to carry the error.
      this.onerror?.(new Error(message));
      return;
    }
    const data = { limitBytes: request.limitBytes, requestBytes: request.requestBytes };
    this.send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: INVALID_REQUEST, message, data },
    }).catch((error: unknown) => {
      logger.warn(`[stdio] failed to answer an oversized request: ${errorMessage(error)}`, error);
    });
  }
}

export interface StdioServerTransportOptions {
  /** Largest message accepted, newline excluded. Defaults to {@link STDIO_REQUEST_MAX_BYTES}. */
  readonly maxRequestBytes?: number;
}

export function createStdioServerTransport(
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
  options: StdioServerTransportOptions = {},
): StdioServerTransport {
  return new EofTolerantStdioServerTransport(
    stdin,
    new PassThrough(),
    stdout,
    options.maxRequestBytes ?? STDIO_REQUEST_MAX_BYTES,
  );
}
