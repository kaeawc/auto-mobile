import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CLI_OUTPUT_INLINE_MAX_BYTES,
  CLI_TOOL_RESULT_ARTIFACT_PAYLOAD,
  MAX_CONSECUTIVE_ZERO_PROGRESS_WRITES,
  renderCliToolOutput,
  writeAllSync,
  type BlockingByteWriter,
} from "../../src/cli/toolOutput";
import {
  resetCliOutputSinksForTesting,
  resetDaemonProxyFactoryForTesting,
  runCliCommand,
  setCliOutputSinksForTesting,
  setDaemonProxyFactoryForTesting,
} from "../../src/cli";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JsonToolOutputArtifactWriter,
  type ToolOutputArtifactFileSystem,
} from "../../src/server/toolOutputArtifactWriter";
import { ToolOutputArtifactLedger } from "../../src/server/toolOutputArtifactLedger";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import type {
  ObservationArtifactMetadata,
  ObservationArtifactWriteInput,
  ObservationArtifactWriter,
} from "../../src/server/finalizeToolResponse";
import { isolateCliDataDir, type IsolatedCliDataDir } from "../helpers/cliDataDirIsolation";

let isolatedCliDataDir: IsolatedCliDataDir;

beforeEach(() => {
  isolatedCliDataDir = isolateCliDataDir();
});

afterEach(() => {
  isolatedCliDataDir.restore();
});

class FakeArtifactWriter implements ObservationArtifactWriter {
  readonly writes: ObservationArtifactWriteInput[] = [];
  throwOnWrite: Error | undefined;

  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata {
    if (this.throwOnWrite) {
      throw this.throwOnWrite;
    }
    this.writes.push(input);
    return {
      artifact: {
        path: `/tmp/auto-mobile/tool-outputs/${input.tool}-1.json`,
        format: "json",
        payload: input.payload,
        bytes: 99_999,
        tool: input.tool,
        resourceUri: `automobile:tool-output/${input.tool}-1.json`,
      },
    };
  }
}

/** A result whose pretty-printed JSON is comfortably past the CLI ceiling. */
function oversizedResult(): Record<string, unknown> {
  return { success: true, rows: "x".repeat(CLI_OUTPUT_INLINE_MAX_BYTES + 1_024) };
}

/**
 * Issue #6870: a single `tapOn` produced a 65600-byte `--cli` response cut
 * mid-string, with no marker, no `path` and no `resourceUri` — `json.loads`
 * could not parse it and the client could not tell it had been cut. The CLI
 * must count bytes before writing and hand back something complete.
 */
describe("CLI tool output never emits truncated JSON (#6870)", () => {
  test("writes an in-limit result verbatim", () => {
    const writer = new FakeArtifactWriter();
    const result = { success: true, matched: true };

    const rendered = renderCliToolOutput(result, { tool: "tapOn", artifactWriter: writer });

    expect(JSON.parse(rendered)).toEqual(result);
    expect(writer.writes).toHaveLength(0);
  });

  test("spills an oversized result and emits a parseable artifact envelope", () => {
    const writer = new FakeArtifactWriter();

    const rendered = renderCliToolOutput(oversizedResult(), {
      tool: "tapOn",
      artifactWriter: writer,
    });

    // The whole point: what reaches stdout still parses.
    const parsed = JSON.parse(rendered);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(CLI_OUTPUT_INLINE_MAX_BYTES);
    expect(parsed.truncated).toBe(false);
    expect(parsed.artifact).toMatchObject({
      path: "/tmp/auto-mobile/tool-outputs/tapOn-1.json",
      format: "json",
      payload: CLI_TOOL_RESULT_ARTIFACT_PAYLOAD,
      tool: "tapOn",
    });
    expect(typeof parsed.artifact.bytes).toBe("number");
    // The spilled file carries the complete result, not a prefix of it.
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0].data).toEqual(oversizedResult());
  });

  test("a result one byte over the ceiling spills; exactly at the ceiling does not", () => {
    const atLimit = (bytes: number): Record<string, unknown> => {
      const probe = JSON.stringify({ value: "" }, null, 2);
      return { value: "p".repeat(bytes - Buffer.byteLength(probe, "utf8")) };
    };

    const inlineWriter = new FakeArtifactWriter();
    const inline = renderCliToolOutput(atLimit(CLI_OUTPUT_INLINE_MAX_BYTES), {
      tool: "observe",
      artifactWriter: inlineWriter,
    });
    expect(Buffer.byteLength(inline, "utf8")).toBe(CLI_OUTPUT_INLINE_MAX_BYTES);
    expect(inlineWriter.writes).toHaveLength(0);

    const spillWriter = new FakeArtifactWriter();
    renderCliToolOutput(atLimit(CLI_OUTPUT_INLINE_MAX_BYTES + 1), {
      tool: "observe",
      artifactWriter: spillWriter,
    });
    expect(spillWriter.writes).toHaveLength(1);
  });

  test("marks the output truncated rather than cutting it when the spill fails", () => {
    const writer = new FakeArtifactWriter();
    writer.throwOnWrite = new Error("tool outputs directory is read-only");

    const rendered = renderCliToolOutput(oversizedResult(), {
      tool: "tapOn",
      artifactWriter: writer,
    });

    const parsed = JSON.parse(rendered);
    expect(parsed.truncated).toBe(true);
    expect(parsed.tool).toBe("tapOn");
    expect(parsed.bytes).toBeGreaterThan(CLI_OUTPUT_INLINE_MAX_BYTES);
    expect(parsed.reason).toContain("read-only");
    // Nothing may be a cut-off fragment of the real payload.
    expect(rendered).not.toContain("xxxx");
  });

  test("marks the output truncated when no artifact writer is available", () => {
    const rendered = renderCliToolOutput(oversizedResult(), { tool: "tapOn" });

    const parsed = JSON.parse(rendered);
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes).toBeGreaterThan(CLI_OUTPUT_INLINE_MAX_BYTES);
  });

  test("runCliCommand writes complete, parseable JSON for an oversized result", async () => {
    const toolOutputsDir = mkdtempSync(path.join(tmpdir(), "automobile-cli-toolout-"));
    const written: string[] = [];
    setCliOutputSinksForTesting({
      stdout: { write: (text) => written.push(text) },
      stderr: { write: () => {} },
    });
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (): Promise<any> => oversizedResult(),
      adoptCliSessionLiveness: async (): Promise<string | undefined> => undefined,
      close: async (): Promise<void> => {},
    }));
    serverConfig.setToolOutputsDir(toolOutputsDir);

    try {
      await runCliCommand(["tapOn"]);

      const parsed = JSON.parse(written[0]);
      expect(parsed.artifact.path).toStartWith(toolOutputsDir);
      expect(existsSync(parsed.artifact.path)).toBe(true);
    } finally {
      resetDaemonProxyFactoryForTesting();
      resetCliOutputSinksForTesting();
      serverConfig.setToolOutputsDir(undefined);
      rmSync(toolOutputsDir, { recursive: true, force: true });
    }

    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]);
    // Either it spilled (a real tool-outputs dir is writable) or it said it
    // could not — never a severed prefix of the payload.
    expect(parsed.truncated === false || parsed.truncated === true).toBe(true);
    expect(parsed.rows).toBeUndefined();
  });

  test("renders a non-serializable result as an explicit failure, not a crash", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const parsed = JSON.parse(renderCliToolOutput(cyclic, { tool: "tapOn" }));

    expect(parsed.truncated).toBe(true);
    expect(parsed.reason).toBeTruthy();
  });
});

/**
 * Issue #6870 follow-up: `stringifyToolResponse` drops every property named
 * `extras` — an observation-specific token saving for the daemon's inline wire
 * payload. The CLI spill is not that wire payload: it is advertised as the
 * COMPLETE result, and the payload reaching it has already been finalized. A
 * response that fits the daemon's compact 64 KiB ceiling can still exceed the
 * CLI's pretty-printed one (`content` duplicates `structuredContent`), so the
 * spilled artifact must carry exactly what the inline rendering would have.
 */
describe("spilled CLI artifacts carry the exact result (#6870)", () => {
  class RecordingFileSystem implements ToolOutputArtifactFileSystem {
    writes: Array<{ path: string; content: string }> = [];
    ensureDirectory(): void {}
    assertWritableDirectory(): void {}
    writeFileExclusive(filePath: string, content: string): void {
      this.writes.push({ path: filePath, content });
    }
    listFiles(): [] {
      return [];
    }
    deleteFile(): void {}
  }

  test("preserves properties named extras in the spilled artifact", () => {
    const fileSystem = new RecordingFileSystem();
    const timer = new FakeTimer();
    timer.setCurrentTime(1234);
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory: path.resolve("/tmp/auto-mobile-cli-spill"),
      fileSystem,
      idGenerator: new FakeIdGenerator(["id-1"]),
      timer,
      ledger: new ToolOutputArtifactLedger(),
    });
    const result = {
      success: true,
      elements: [{ text: "Submit", extras: { accessibilityRole: "button" } }],
      filler: "x".repeat(CLI_OUTPUT_INLINE_MAX_BYTES),
    };

    const rendered = renderCliToolOutput(result, { tool: "observe", artifactWriter: writer });

    expect(JSON.parse(rendered).truncated).toBe(false);
    expect(fileSystem.writes).toHaveLength(1);
    const spilled = JSON.parse(fileSystem.writes[0].content);
    expect(spilled).toEqual(result);
    expect(spilled.elements[0].extras).toEqual({ accessibilityRole: "button" });
  });

  test("reports the spilled artifact's own byte count", () => {
    const fileSystem = new RecordingFileSystem();
    const timer = new FakeTimer();
    timer.setCurrentTime(1234);
    const writer = new JsonToolOutputArtifactWriter({
      outputDirectory: path.resolve("/tmp/auto-mobile-cli-spill"),
      fileSystem,
      idGenerator: new FakeIdGenerator(["id-2"]),
      timer,
      ledger: new ToolOutputArtifactLedger(),
    });

    const rendered = renderCliToolOutput(oversizedResult(), {
      tool: "observe",
      artifactWriter: writer,
    });

    const parsed = JSON.parse(rendered);
    expect(parsed.artifact.bytes).toBe(Buffer.byteLength(fileSystem.writes[0].content, "utf8"));
  });
});

/**
 * The blocking write itself (#6870 review, PRRT_kwDOP-GF5M6h5Dje).
 *
 * The end-to-end regression above swaps the stdout sink for an array, so it
 * never runs a single line of {@link writeAllSync} — the code that exists to
 * stop `process.exit()` cutting the result mid-string. `fs.writeSync` is free to
 * accept a PREFIX of the buffer and a non-blocking pipe is free to reject the
 * write outright with `EAGAIN`, so the loop, its offset arithmetic and its
 * errno handling are the fix; a suite that never executes them would stay green
 * if the output reverted to `console.log`. Driven here through the narrow
 * syscall seam {@link BlockingByteWriter} instead of process-level plumbing.
 */
describe("writeAllSync delivers every byte (#6870)", () => {
  class FakeSyscalls implements BlockingByteWriter {
    /** Bytes each successive writeSync call accepts; exhausted means "all of it". */
    readonly accepts: number[];
    /** Errors to raise before the corresponding accept, index-aligned. */
    readonly errors: Array<NodeJS.ErrnoException | undefined>;
    calls = 0;
    sleeps: number[] = [];
    received = "";

    constructor(accepts: number[], errors: Array<NodeJS.ErrnoException | undefined> = []) {
      this.accepts = accepts;
      this.errors = errors;
    }

    writeSync(_fd: number, buffer: Uint8Array, offset: number, length: number): number {
      const error = this.errors[this.calls];
      const accept = this.accepts[this.calls] ?? length;
      this.calls += 1;
      if (error) {
        throw error;
      }
      const written = Math.min(accept, length);
      this.received += Buffer.from(buffer)
        .subarray(offset, offset + written)
        .toString("utf8");
      return written;
    }

    sleepSync(ms: number): void {
      this.sleeps.push(ms);
    }
  }

  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  test("keeps writing until a partially-accepting fd has taken every byte", () => {
    const text = JSON.stringify({ success: true, rows: "r".repeat(4096) });
    const syscalls = new FakeSyscalls([10, 100, 1000]);

    writeAllSync(1, text, syscalls);

    expect(syscalls.received).toBe(text);
    expect(syscalls.calls).toBeGreaterThan(3);
  });

  test("retries after EAGAIN instead of dropping the remainder", () => {
    const text = '{"success":true}';
    const syscalls = new FakeSyscalls([4, 0, 0], [undefined, errno("EAGAIN"), errno("EAGAIN")]);

    writeAllSync(1, text, syscalls);

    expect(syscalls.received).toBe(text);
    expect(syscalls.sleeps).toEqual([1, 1]);
  });

  test("refuses to spin forever when writes make no progress", () => {
    const syscalls = new FakeSyscalls(Array(MAX_CONSECUTIVE_ZERO_PROGRESS_WRITES).fill(0));

    expect(() => writeAllSync(7, '{"success":true}', syscalls)).toThrow(
      `Zero-progress write to fd 7 after ${MAX_CONSECUTIVE_ZERO_PROGRESS_WRITES} attempts; refusing to spin`,
    );
    expect(syscalls.sleeps).toEqual(Array(MAX_CONSECUTIVE_ZERO_PROGRESS_WRITES).fill(1));
  });

  test("resets zero-progress retries after a write makes progress", () => {
    const syscalls = new FakeSyscalls([0, 1, 0]);

    writeAllSync(1, '{"success":true}', syscalls);

    expect(syscalls.received).toBe('{"success":true}');
    expect(syscalls.sleeps).toEqual([1, 1]);
  });

  test("advances the offset by multi-byte characters, not code units", () => {
    const text = "漢".repeat(8);
    const syscalls = new FakeSyscalls([3, 3]);

    writeAllSync(1, text, syscalls);

    expect(syscalls.received).toBe(text);
    expect(Buffer.byteLength(syscalls.received, "utf8")).toBe(24);
  });

  test("stops without throwing when the reader closes (EPIPE)", () => {
    const syscalls = new FakeSyscalls([2], [undefined, errno("EPIPE")]);

    expect(() => writeAllSync(1, '{"a":1}', syscalls)).not.toThrow();
    expect(syscalls.received).toBe('{"');
  });

  test("propagates an unexpected errno rather than silently losing output", () => {
    const syscalls = new FakeSyscalls([0], [errno("EBADF")]);

    expect(() => writeAllSync(1, '{"a":1}', syscalls)).toThrow("EBADF");
  });
});
