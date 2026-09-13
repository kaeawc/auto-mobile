import { describe, expect, test } from "bun:test";
import {
  CLI_OUTPUT_INLINE_MAX_BYTES,
  CLI_TOOL_RESULT_ARTIFACT_PAYLOAD,
  renderCliToolOutput,
} from "../../src/cli/toolOutput";
import {
  resetCliOutputSinksForTesting,
  resetDaemonProxyFactoryForTesting,
  runCliCommand,
  setCliOutputSinksForTesting,
  setDaemonProxyFactoryForTesting,
} from "../../src/cli";
import type {
  ObservationArtifactMetadata,
  ObservationArtifactWriteInput,
  ObservationArtifactWriter,
} from "../../src/server/finalizeToolResponse";

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

    try {
      await runCliCommand(["tapOn"]);
    } finally {
      resetDaemonProxyFactoryForTesting();
      resetCliOutputSinksForTesting();
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
