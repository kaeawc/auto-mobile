import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAdbReverseCommands,
  parsePortProbeOutput,
  portProbeScript,
} from "../../../src/utils/android-cmdline-tools/adbReverse";

// Captured on an API 35 google_apis emulator (toybox 0.8.11-android) by running portProbeScript
// against a host server behind `adb reverse`, with the host server stopped, an unmapped port, and
// a binary that does not exist.
const capture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/port-reverse-probe", name), "utf8");

describe("port probe", () => {
  test("a connection the host keeps open is held", () => {
    expect(parsePortProbeOutput(capture("open.txt"))).toEqual({ kind: "held" });
  });

  test("an immediate close behind a live reverse is closed", () => {
    expect(parsePortProbeOutput(capture("closed-by-peer.txt"))).toEqual({ kind: "closed" });
  });

  test("a refused connect is refused", () => {
    expect(parsePortProbeOutput(capture("refused.txt"))).toEqual({ kind: "refused" });
  });

  test("a missing binary or unrecognised output is unsupported, never a guess", () => {
    expect(parsePortProbeOutput(capture("missing-binary.txt"))).toEqual({
      kind: "unsupported",
      detail: "timeout: exec nonexistentnc: No such file or directory",
    });
    expect(parsePortProbeOutput("")).toEqual({ kind: "unsupported", detail: "no output" });
    expect(parsePortProbeOutput("nc: bad argument count\nautomobile-probe-exit=1\n")).toEqual({
      kind: "unsupported",
      detail: "nc: bad argument count",
    });
  });

  test("probe runs one bounded shell script and parses its stdout", async () => {
    const commands: string[] = [];
    const timeouts: (number | undefined)[] = [];
    const reverse = createAdbReverseCommands({
      executeCommand: async (command: string, options?: { timeoutMs?: number }) => {
        commands.push(command);
        timeouts.push(options?.timeoutMs);
        return { stdout: capture("open.txt"), stderr: "" } as never;
      },
    });
    expect(await reverse.probe(8081)).toEqual({ kind: "held" });
    expect(commands).toEqual([`shell sh -c '${portProbeScript(8081)}'`]);
    expect(portProbeScript(8081)).toBe(
      "sleep 1.1 | timeout 1 nc -w 1 127.0.0.1 8081 2>&1; echo automobile-probe-exit=$?",
    );
    expect(timeouts).toEqual([4000]);
  });
});
