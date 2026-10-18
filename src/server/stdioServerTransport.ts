import { PassThrough, type Readable, type Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

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
  ) {
    super(feed, stdout);
  }

  private readonly forwardSourceError = (error: Error): void => {
    this.onerror?.(error);
  };

  override async start(): Promise<void> {
    await super.start();
    this.source.on("error", this.forwardSourceError);
    this.source.pipe(this.feed, { end: false });
  }

  override async close(): Promise<void> {
    this.source.off("error", this.forwardSourceError);
    this.source.unpipe(this.feed);
    await super.close();
  }
}

export function createStdioServerTransport(
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
): StdioServerTransport {
  return new EofTolerantStdioServerTransport(stdin, new PassThrough(), stdout);
}
