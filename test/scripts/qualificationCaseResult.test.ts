import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  caseResultJsonSchema,
  parseCaseResult,
  type CaseResult,
} from "../../scripts/qualification/caseResult";

function fixture(): CaseResult {
  return {
    schemaVersion: 1,
    caseId: "android.reuse-stable-device",
    title: "Reuse",
    matrixItem: 1,
    platform: "android",
    proofLevel: "local-build",
    artifact: { packageVersion: null, sourceSha: null, integrity: null },
    command: { argv: ["bun", "case.ts"], cwd: "." },
    outcome: "pass",
    observation: { kind: "native" },
    timings: {
      startedAt: "2026-10-14T00:00:00.000Z",
      finishedAt: "2026-10-14T00:00:00.010Z",
      durationMs: 10,
      operations: [],
    },
    evidence: [{ path: "scratch/qualification/run/log.txt", kind: "log", sha256: null }],
    fixtures: [{ role: "target", id: "fixture-android-target" }],
    failureCode: null,
    boundary: null,
    notes: null,
  };
}
describe("qualification case format", () => {
  let checkedIn: unknown;
  let generated: unknown;
  beforeAll(() => {
    checkedIn = JSON.parse(
      readFileSync(
        new URL("../../scripts/qualification/case-result.schema.json", import.meta.url),
        "utf8",
      ),
    );
    generated = caseResultJsonSchema();
    // Warm Zod's lazy object parsers outside per-test timing.
    parseCaseResult(fixture());
  });
  test.each(["native", "injected-fault", "deterministic-test", "not-exercised"])(
    "accepts %s",
    (kind) => {
      const result = fixture();
      if (kind === "injected-fault") {
        result.observation = { kind, mechanism: "fake-registry", fault: "busy" };
      }
      if (kind === "deterministic-test") {
        result.observation = { kind };
        result.proofLevel = "source-tests";
      }
      if (kind === "not-exercised") {
        result.outcome = kind;
        result.boundary = "No native fault injection available";
      }
      expect(parseCaseResult(result)).toEqual(result);
    },
  );
  test.each([
    ["source native", { proofLevel: "source-tests" }],
    ["missing mechanism", { observation: { kind: "injected-fault", fault: "busy" } }],
    ["missing boundary", { outcome: "not-exercised" }],
    ["blank boundary", { outcome: "blocked", boundary: " " }],
    ["raw serial", { fixtures: [{ role: "target", id: "emulator-5554" }] }],
    ["absolute evidence", { evidence: [{ path: "/tmp/log", kind: "log", sha256: null }] }],
    ["parent cwd", { command: { argv: ["bun"], cwd: "foo/../bar" } }],
    ["unknown field", { extra: true }],
    [
      "nested unknown field",
      { artifact: { packageVersion: null, sourceSha: null, integrity: null, extra: true } },
    ],
  ])("rejects %s", (_name, patch) => {
    expect(() => parseCaseResult({ ...fixture(), ...patch })).toThrow();
  });
  test("rejects reversed timestamps, including offsets", () => {
    const result = fixture();
    result.timings.finishedAt = "2026-10-14T01:00:00.000+02:00";
    expect(() => parseCaseResult(result)).toThrow("finishedAt");
  });
  test.each(["..", "../log", "a/..", "a/../b", "~/log", "a/~b", "C:\\log", "/log", ""])(
    "rejects unsafe path %s",
    (path) => {
      const result = fixture();
      result.command.cwd = path;
      expect(() => parseCaseResult(result)).toThrow();
    },
  );
  test("allows budget overruns as evidence", () => {
    const result = fixture();
    result.timings.operations = [{ name: "boot", durationMs: 20, budgetMs: 10 }];
    expect(parseCaseResult(result).timings.operations).toEqual(result.timings.operations);
  });
  test("generated JSON Schema has no drift and describes cross-field rules", () => {
    expect(checkedIn).toEqual(generated);
    const text = JSON.stringify(generated);
    for (const rule of [
      "source-tests",
      "at or after startedAt",
      "may exceed budgetMs",
      "non-empty for blocked or not-exercised",
    ]) {
      expect(text).toContain(rule);
    }
  });
});
