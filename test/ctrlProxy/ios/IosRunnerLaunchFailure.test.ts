import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  classifyRunnerLaunchOutput,
  IosRunnerLaunchFailures,
} from "../../../src/ctrlProxy/ios/IosRunnerLaunchFailure";

const chunks = readFileSync(
  new URL("../../fixtures/ios-runner-launch-failure/runner-output-captured.txt", import.meta.url),
  "utf8",
)
  .trimEnd()
  .split("\n")
  .map((line) => line.slice(line.indexOf("\t") + 1));

describe("runner launch failure evidence", () => {
  test.each(chunks)("classifies captured chunk %s", (chunk) => {
    const expected = chunk.includes("listener failed")
      ? "listener-bind-failed"
      : chunk.includes("Restarting after unexpected exit")
        ? "runner-lost"
        : undefined;
    expect(classifyRunnerLaunchOutput(chunk)?.reason).toBe(expected);
    if (!expected) {
      expect(classifyRunnerLaunchOutput(chunk)).toBeNull();
    }
  });

  test("classifies concatenated chunks and preserves the diagnostic", () => {
    const output = chunks.join("\n");
    expect(classifyRunnerLaunchOutput(output)?.reason).toBe("listener-bind-failed");
    expect(classifyRunnerLaunchOutput(output)?.detail).toContain("Address already in use");
    expect(classifyRunnerLaunchOutput("listener failed")).toBeNull();
    expect(classifyRunnerLaunchOutput("Address already in use")).toBeNull();
  });

  test("first failure per PID wins until cleared, independently of other PIDs", () => {
    const failures = new IosRunnerLaunchFailures();
    const first = { reason: "runner-lost" as const, detail: "lost" };
    failures.record(1, first);
    failures.record(1, { reason: "supervisor-unhealthy", detail: "missed" });
    failures.record(2, { reason: "listener-bind-failed", detail: "bind" });
    expect(failures.get(1)).toEqual(first);
    failures.clear(1);
    expect(failures.get(1)).toBeUndefined();
    expect(failures.get(2)?.reason).toBe("listener-bind-failed");
    failures.record(1, { reason: "supervisor-unhealthy", detail: "new generation" });
    expect(failures.get(1)?.reason).toBe("supervisor-unhealthy");
  });
});
