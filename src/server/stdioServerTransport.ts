import { PassThrough, type Readable, type Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

/**
 * The stdio server transport with the v1 SDK's end-of-input behaviour (issue #4678).
 *
 * The SDK v2 `StdioServerTransport` closes itself when stdin ends, which aborts every
 * in-flight request and drops its answer. The v1 transport ignored stdin's end: stdin
 * EOF belongs to `installStdinShutdownHandlers` and `OutputGatedTransport`, which still
 * answer the requests received before EOF (#11951, #12049). So the SDK transport reads a
 * feed that carries stdin's data and errors but never ends; stdin's own `end`/`close`
 * still reach the lifecycle handlers, which listen on stdin directly.
 */
export function createStdioServerTransport(
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
): StdioServerTransport {
  const feed = new PassThrough();
  stdin.pipe(feed, { end: false });
  stdin.on("error", (error) => feed.emit("error", error));
  return new StdioServerTransport(feed, stdout);
}
