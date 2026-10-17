import { describe, expect, test } from "bun:test";
import { parseProbeJson, type ProbeSpawnResult } from "./spawnProbe";

const result = (over: Partial<ProbeSpawnResult>): ProbeSpawnResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  ...over,
});

describe("parseProbeJson", () => {
  test("parses the JSON the child printed", () => {
    expect(parseProbeJson<{ a: number }>(result({ stdout: '{"a":1}\n' }))).toEqual({ a: 1 });
  });

  test("empty stdout reports exit code, signal, timeout and stderr instead of a bare SyntaxError", () => {
    expect(() =>
      parseProbeJson(
        result({
          exitCode: null,
          signalCode: "SIGTERM",
          exitedDueToTimeout: true,
          stderr: "error: boom",
        }),
      ),
    ).toThrow(/exitCode=null, signal=SIGTERM, timedOut=true.*stderr="error: boom"/);
  });

  test("a non-zero exit with garbage stdout names the exit code and the stdout", () => {
    expect(() => parseProbeJson(result({ exitCode: 1, stdout: "oops" }))).toThrow(
      /exitCode=1, signal=none, timedOut=false.*stdout="oops"/,
    );
  });
});
