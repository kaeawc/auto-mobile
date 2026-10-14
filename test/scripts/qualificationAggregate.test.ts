import { describe, expect, test } from "bun:test";
import {
  aggregateResults,
  aggregateExitCode,
  parseAggregateArgs,
} from "../../scripts/qualification/aggregateResults";
import type { ArtifactIdentityRecord } from "../../scripts/qualification/artifactIdentity";
import type { CaseResult } from "../../scripts/qualification/caseResult";

function fixture(caseId = "host.example"): CaseResult {
  return {
    schemaVersion: 1,
    caseId,
    title: "Example",
    matrixItem: null,
    platform: "host",
    proofLevel: "local-build",
    artifact: { packageVersion: "0.1.0", sourceSha: "a".repeat(40), integrity: "sha512-test" },
    command: { argv: ["bun", "case.ts", "space | apostrophe's `value`"], cwd: "." },
    outcome: "pass",
    observation: { kind: "native" },
    timings: {
      startedAt: "1970-01-01T00:00:00.000Z",
      finishedAt: "1970-01-01T00:00:00.010Z",
      durationMs: 10,
      operations: [],
    },
    evidence: [],
    fixtures: [],
    failureCode: null,
    boundary: null,
    notes: null,
  };
}
function identity(): ArtifactIdentityRecord {
  return {
    schemaVersion: 1,
    verdict: "identified",
    proofLevel: "local-build",
    package: {
      name: "@kaeawc/auto-mobile",
      version: "0.1.0",
      root: "/package",
      contentSha256: null,
      fileCount: 1,
    },
    source: {
      sha: "a".repeat(40),
      evidence: "build-info",
      dirty: false,
      tag: null,
      expectedSha: null,
    },
    tarball: {
      path: "package.tgz",
      integrity: "sha512-test",
      shasum: "b".repeat(40),
      expectedIntegrity: null,
    },
    nativeResources: { from: "none", entries: {}, localAssets: [] },
    managedSlotContract: {
      present: true,
      contractVersions: [1],
      capabilities: ["managed-slots/v1"],
    },
    checks: [],
  };
}
function file(result: CaseResult, name = `${result.caseId}.json`) {
  return { name, text: JSON.stringify(result) };
}
describe("qualification aggregation", () => {
  test.each(["packageVersion", "sourceSha", "integrity"] as const)(
    "rejects mixed artifact %s",
    (key) => {
      const result = fixture();
      result.artifact[key] =
        key === "sourceSha" ? "b".repeat(40) : key === "integrity" ? "sha512-other" : "other";
      const report = aggregateResults({ files: [file(result)], identity: identity() });
      expect(report.errors).toEqual([
        {
          file: "host.example.json",
          message: `Mixed artifacts: artifact.${key} differs from identity`,
        },
      ]);
      expect(aggregateExitCode(report, false)).toBe(1);
    },
  );
  test("duplicate platform/case pairs are errors and not counted twice", () => {
    const result = fixture();
    const report = aggregateResults({
      files: [file(result, "a.json"), file(result, "b.json")],
      identity: null,
    });
    expect(report.errors[0].message).toContain("Duplicate case (host, host.example)");
    expect(report.results).toHaveLength(1);
    expect(report.counts.host.pass).toBe(1);
  });
  test("same case on separate platforms is valid", () => {
    const result = fixture();
    const report = aggregateResults({
      files: [file(result), file({ ...result, platform: "ios" }, "ios.json")],
      identity: null,
    });
    expect(report.errors).toEqual([]);
    expect(report.results).toHaveLength(2);
  });
  test("invalid JSON and schema report filenames and issue paths", () => {
    const report = aggregateResults({
      files: [
        { name: "bad.json", text: "{" },
        {
          name: "schema.json",
          text: JSON.stringify({ ...fixture(), command: { argv: [], cwd: ".." } }),
        },
      ],
      identity: null,
    });
    expect(report.errors.map((error) => error.file)).toEqual(["bad.json", "schema.json"]);
    expect(report.errors[1].message).toContain("command.argv");
    expect(report.errors[1].message).toContain("command.cwd");
    expect(report.markdown).toContain("## Validation errors");
  });
  test("published result refuses local identity; refused identity is an error", () => {
    const report = aggregateResults({
      files: [file({ ...fixture(), proofLevel: "published-package" })],
      identity: identity(),
    });
    expect(report.errors[0].message).toContain("published-package identity");
    expect(
      aggregateResults({ files: [], identity: { ...identity(), verdict: "refused" } }).errors,
    ).toEqual([{ file: "identity", message: "Artifact identity verdict is refused" }]);
  });
  test("warns about missing artifact fields and over-budget operations", () => {
    const result = fixture();
    result.artifact = { packageVersion: null, sourceSha: null, integrity: null };
    result.timings.operations = [
      { name: "boot", durationMs: 11, budgetMs: 10 },
      { name: "ready", durationMs: 10, budgetMs: 10 },
    ];
    const report = aggregateResults({ files: [file(result)], identity: identity() });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toHaveLength(4);
    expect(report.warnings[3]).toContain("boot over budget (11ms > 10ms)");
    expect(report.markdown).toContain("## Warnings");
  });
  test("deterministic markdown sorts rows, separates observations, escapes pipes and quotes args", () => {
    const a = fixture("a.case");
    const z = fixture("z.case");
    const injected: CaseResult = {
      ...fixture("fault.case"),
      observation: { kind: "injected-fault", mechanism: "fake", fault: "busy" },
    };
    const gap: CaseResult = {
      ...fixture("gap.case"),
      outcome: "not-exercised",
      boundary: "No host | native boundary",
    };
    const files = [file(z), file(injected), file(gap), file(a)];
    const report = aggregateResults({ files, identity: null });
    const md = report.markdown;
    expect(aggregateResults({ files: [...files].reverse(), identity: null }).markdown).toBe(md);
    expect(md).toStartWith("# Managed-slot qualification summary\n");
    const native = md.split("## Native observations")[1].split("## Injected faults")[0];
    expect(native.indexOf("host.a.case")).toBeLessThan(native.indexOf("host.z.case"));
    expect(native).not.toContain("fault.case");
    expect(native).not.toContain("gap.case");
    expect(
      md
        .split("## Injected faults (not native observations)")[1]
        .split("## Deterministic tests")[0],
    ).toContain("fault.case");
    expect(md).toContain("'space \\| apostrophe'\\''s `value`'");
    expect(md).toContain("## Deterministic tests\n\nNone.");
    expect(md).toContain("No host \\| native boundary");
    expect(md).toContain("No artifact identity supplied — results are not bound to an artifact.");
    expect(md).not.toContain("## Validation errors");
    expect(md).not.toContain("## Warnings");
  });
  test("artifact section reports identity and source evidence", () => {
    const md = aggregateResults({ files: [file(fixture())], identity: identity() }).markdown;
    for (const value of [
      "0.1.0",
      "a".repeat(40),
      "build-info",
      "sha512-test",
      "local-build",
      "identified",
    ]) {
      expect(md).toContain(value);
    }
  });
  test.each(["pass", "fail", "blocked", "not-exercised"] as const)(
    "require-pass semantics: %s",
    (outcome) => {
      const result: CaseResult = { ...fixture(), outcome, boundary: "Recorded boundary" };
      const report = aggregateResults({ files: [file(result)], identity: null });
      expect(aggregateExitCode(report, false)).toBe(0);
      expect(aggregateExitCode(report, true)).toBe(
        outcome === "fail" || outcome === "blocked" ? 1 : 0,
      );
    },
  );
  test("CLI requires results and parses require-pass", () => {
    expect(() => parseAggregateArgs([])).toThrow("--results");
    expect(() => parseAggregateArgs(["--unknown"])).toThrow();
    expect(parseAggregateArgs(["--results", "cases", "--require-pass"]).requirePass).toBe(true);
  });
});
