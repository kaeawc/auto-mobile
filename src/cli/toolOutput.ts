import fs from "node:fs";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { ObservationArtifactWriter } from "../server/finalizeToolResponse";

/**
 * The CLI's stdout boundary (issue #6870).
 *
 * A `--cli` invocation used to `JSON.stringify(result, null, 2)` straight into
 * `console.log` and then `process.exit(0)`, which drops whatever the runtime has
 * not flushed. A single `tapOn` landed as 65600 bytes cut mid-string: no
 * truncation marker, no `path`, no `resourceUri`, and `json.loads` refusing to
 * parse it. Two things are needed for a client to trust the output:
 *
 * 1. Count the serialized bytes BEFORE writing and, over the ceiling, spill the
 *    payload to a tool-output artifact and emit the #5882 envelope instead. If
 *    the spill is impossible, say so in a `truncated` field rather than cutting
 *    a string in half.
 * 2. Write what is left with a blocking, complete write, so process exit cannot
 *    cut it either (see {@link writeAllSync}).
 */

/**
 * Ceiling on what one `--cli` invocation prints inline. Matches the daemon's
 * `DEFAULT_OBSERVATION_INLINE_MAX_BYTES`, but measured on the CLI's own
 * pretty-printed rendering, which is larger than the compact wire form.
 */
export const CLI_OUTPUT_INLINE_MAX_BYTES = 64 * 1024;

/** The `artifact.payload` discriminator for a spilled whole CLI tool result. */
export const CLI_TOOL_RESULT_ARTIFACT_PAYLOAD = "CliToolResult";

export interface CliToolOutputOptions {
  /** Tool name, recorded in the artifact metadata. */
  tool: string;
  /** Override the inline ceiling (tests). */
  maxBytes?: number;
  /** Where an oversized payload is spilled; absent means no spill is possible. */
  artifactWriter?: ObservationArtifactWriter;
}

/**
 * Render one tool result for stdout: the pretty JSON when it fits, the artifact
 * envelope when it does not, and an explicit `truncated: true` marker when
 * neither is possible. Never returns a partial serialization.
 */
export function renderCliToolOutput(result: unknown, options: CliToolOutputOptions): string {
  const maxBytes = options.maxBytes ?? CLI_OUTPUT_INLINE_MAX_BYTES;

  let text: string;
  try {
    text = JSON.stringify(result, null, 2);
  } catch (error) {
    // A result that cannot be serialized at all (a cycle, a BigInt) must still
    // produce parseable output saying so — printing nothing, or a half-built
    // string, is exactly the failure mode this function exists to prevent.
    return truncationNotice(
      options.tool,
      0,
      `result is not JSON-serializable: ${errorMessage(error)}`,
    );
  }

  // `JSON.stringify` returns undefined for `undefined` and a bare function.
  if (text === undefined) {
    return truncationNotice(options.tool, 0, "tool returned a value with no JSON representation");
  }

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return text;
  }

  if (!options.artifactWriter) {
    return truncationNotice(
      options.tool,
      bytes,
      "no tool-output directory is available to spill the payload to",
    );
  }

  try {
    const metadata = options.artifactWriter.writeJsonArtifact({
      tool: options.tool,
      payload: CLI_TOOL_RESULT_ARTIFACT_PAYLOAD,
      data: result,
      // Spill the rendering we already built, not a re-serialization: the
      // writer's default serializer strips every `extras` property (a saving
      // for the daemon's inline wire payload), and this artifact is advertised
      // as the complete result, so it must round-trip what would have been
      // printed inline (#6870).
      serialized: text,
    });
    return JSON.stringify(
      {
        truncated: false,
        bytes,
        // `resourceUri` is deliberately dropped from the CLI's own spill: the
        // daemon serves `automobile:tool-output/...` only for artifacts recorded
        // in ITS provenance ledger (#5917), and this file was written by the CLI
        // process, so advertising the URI would promise a read that is refused.
        // `path` is the complete payload and is what a shell client reads.
        artifact: { ...metadata.artifact, resourceUri: undefined },
        note:
          `Tool output was ${bytes} bytes, over the ${maxBytes}-byte CLI inline limit. ` +
          `The complete JSON result is in artifact.path.`,
      },
      null,
      2,
    );
  } catch (error) {
    logger.debug(`[cli] failed to spill oversized tool output: ${errorMessage(error)}`);
    return truncationNotice(options.tool, bytes, errorMessage(error));
  }
}

/**
 * The only shape the CLI is allowed to emit when it cannot deliver the payload:
 * complete, parseable JSON that says so — never a severed prefix of the real
 * result, which a client cannot distinguish from malformed output.
 */
function truncationNotice(tool: string, bytes: number, reason: string): string {
  return JSON.stringify(
    {
      truncated: true,
      tool,
      bytes,
      reason,
      recovery:
        "Re-run with AUTOMOBILE_TOOL_OUTPUTS_DIR set to a writable directory, or narrow the " +
        "request (for example observe with a scope) so the result fits inline.",
    },
    null,
    2,
  );
}

/** A byte sink for CLI output; the process streams by default. */
export interface CliByteSink {
  write(text: string): void;
}

export const cliStdout: CliByteSink = { write: (text) => writeAllSync(1, text) };
export const cliStderr: CliByteSink = { write: (text) => writeAllSync(2, text) };

/**
 * The two blocking syscalls {@link writeAllSync} needs, as a seam.
 *
 * A partially-accepting fd and a momentarily-full non-blocking pipe are exactly
 * the conditions the loop below exists to survive, and neither can be produced
 * by swapping out a {@link CliByteSink} — that swap skips the loop entirely.
 * Injecting the syscalls keeps the production call sites unchanged (the default
 * is the real one) while letting a test drive partial writes and `EAGAIN`
 * deterministically, with no process-level plumbing (#6870).
 */
export interface BlockingByteWriter {
  /**
   * Write up to `length` bytes of `buffer` starting at `offset`, returning the
   * number the fd actually accepted — which may be fewer, or none.
   */
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  /** Block this thread for `ms` before the caller retries. */
  sleepSync(ms: number): void;
}

export const nodeBlockingByteWriter: BlockingByteWriter = {
  writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length),
  sleepSync: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

/**
 * Write every byte to `fd` before returning.
 *
 * The CLI calls `process.exit()` as soon as a command completes, which discards
 * whatever the runtime has buffered — the mechanism that cut a `tapOn` result
 * mid-string (#6870). A blocking write removes the race entirely.
 */
export function writeAllSync(
  fd: number,
  text: string,
  syscalls: BlockingByteWriter = nodeBlockingByteWriter,
): void {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += syscalls.writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        // A non-blocking pipe whose buffer is momentarily full. The reader will
        // drain it; wait rather than drop bytes, since this is the only path the
        // result takes.
        syscalls.sleepSync(1);
        continue;
      }
      if (code === "EPIPE") {
        // The reader closed (`| head`); there is nobody left to deliver to, and
        // this is not a tool failure.
        logger.debug(`[cli] output stream closed before the write completed (fd ${fd})`);
        return;
      }
      throw error;
    }
  }
}
