import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  UsageError,
  type ArtifactIdentityRecord,
} from "../../scripts/qualification/artifactIdentity";
import { parseRunCaseArgs, runCase, type RunCasePorts } from "../../scripts/qualification/runCase";
import { FakeTimer } from "../fakes/FakeTimer";

const flags = [
  "--case-id",
  "host.example",
  "--title",
  "Example",
  "--platform",
  "host",
  "--proof-level",
  "source-tests",
  "--observation",
  "deterministic-test",
  "--out",
  "case.json",
];
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
function harness(exitCode = 0) {
  const files = new Map<string, string>();
  const timer = new FakeTimer();
  const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
  const ports: RunCasePorts = {
    repoRoot: resolve("/repo"),
    now: () => timer.now(),
    spawn: async (argv, cwd) => {
      calls.push({ argv, cwd });
      timer.advanceTime(12);
      files.set(resolve("/repo/scratch/log.txt"), "log");
      return { exitCode };
    },
    readText: (path) => {
      const text = files.get(path);
      if (text === undefined) {
        throw new Error(`Missing ${path}`);
      }
      return text;
    },
    writeText: (path, text) => {
      files.set(path, text);
    },
    sha256File: (path) => (files.has(path) ? "b".repeat(64) : null),
  };
  const options = (extra: string[] = []) => ({
    ...parseRunCaseArgs([...flags, ...extra, "--", "bun", "case.ts"]),
    cwd: resolve("/repo"),
  });
  return { files, calls, ports, options };
}
describe("qualification case runner", () => {
  test.each(["local-build", "published-package"] as const)(
    "%s refuses missing identity before spawning",
    async (proofLevel) => {
      const h = harness();
      expect(() =>
        parseRunCaseArgs([
          ...flags.map((value) => (value === "source-tests" ? proofLevel : value)),
          "--",
          "bun",
        ]),
      ).toThrow("--identity");
      await expect(runCase({ ...h.options(), proofLevel }, h.ports)).rejects.toThrow("--identity");
      expect(h.calls).toEqual([]);
      expect(h.files.size).toBe(0);
    },
  );
  test.each(["local-build", "published-package"] as const)(
    "parses and runs %s with a binding identity",
    async (proofLevel) => {
      const h = harness();
      h.files.set("identity.json", JSON.stringify({ ...identity(), proofLevel }));
      const options = parseRunCaseArgs([
        ...flags.map((value) => (value === "source-tests" ? proofLevel : value)),
        "--identity",
        "identity.json",
        "--",
        "bun",
      ]);
      const { result } = await runCase({ ...options, cwd: resolve("/repo") }, h.ports);
      expect(result.proofLevel).toBe(proofLevel);
      expect(result.artifact.sourceSha).toBe("a".repeat(40));
      expect(h.calls).toHaveLength(1);
    },
  );
  test("passing command records fake timing, post-command hash and validated JSON", async () => {
    const h = harness();
    const { result, exitCode } = await runCase(
      h.options([
        "--evidence",
        "scratch/log.txt:log",
        "--evidence",
        "scratch/missing.txt:log",
        "--fixture",
        "target=fixture-host",
      ]),
      h.ports,
    );
    expect(exitCode).toBe(0);
    expect(result.outcome).toBe("pass");
    expect(result.timings).toEqual({
      startedAt: "1970-01-01T00:00:00.000Z",
      finishedAt: "1970-01-01T00:00:00.012Z",
      durationMs: 12,
      operations: [{ name: "command", durationMs: 12, budgetMs: null }],
    });
    expect(result.evidence.map((entry) => entry.sha256)).toEqual(["b".repeat(64), null]);
    expect(result.command.cwd).toBe(".");
    expect(h.calls).toHaveLength(1);
    expect(h.files.get("case.json")).toBe(`${JSON.stringify(result, null, 2)}\n`);
  });
  test("exit 3 records fail and propagates 3", async () => {
    const h = harness(3);
    const output = await runCase(h.options(), h.ports);
    expect(output.exitCode).toBe(3);
    expect(output.result.outcome).toBe("fail");
  });
  test("not-exercised never spawns and records zero durations", async () => {
    const h = harness();
    const output = await runCase(
      h.options(["--not-exercised", "--boundary", "No native test host"]),
      h.ports,
    );
    expect(h.calls).toEqual([]);
    expect(output.exitCode).toBe(0);
    expect(output.result.outcome).toBe("not-exercised");
    expect(output.result.timings.durationMs).toBe(0);
    expect(output.result.timings.operations).toEqual([]);
    expect(output.result.command.argv).toEqual(["bun", "case.ts"]);
  });
  test("identity fills artifact and refuses before spawning", async () => {
    const h = harness();
    const record = identity();
    h.files.set("identity.json", JSON.stringify(record));
    const options = h.options(["--identity", "identity.json"]);
    const { result } = await runCase(options, h.ports);
    expect(result.artifact).toEqual({
      packageVersion: "0.1.0",
      sourceSha: "a".repeat(40),
      integrity: "sha512-test",
    });
    record.verdict = "refused";
    h.files.set("identity.json", JSON.stringify(record));
    await expect(runCase(options, h.ports)).rejects.toBeInstanceOf(UsageError);
    expect(h.calls).toHaveLength(1);
  });
  test("published proof cannot use a local identity", async () => {
    const h = harness();
    h.files.set("identity.json", JSON.stringify(identity()));
    await expect(
      runCase(
        { ...h.options(["--identity", "identity.json"]), proofLevel: "published-package" },
        h.ports,
      ),
    ).rejects.toBeInstanceOf(UsageError);
    expect(h.calls).toEqual([]);
  });
  test("invalid cwd and metadata refuse before spawn or write", async () => {
    const h = harness();
    await expect(
      runCase({ ...h.options(), cwd: resolve("/outside") }, h.ports),
    ).rejects.toBeInstanceOf(UsageError);
    expect(h.calls).toEqual([]);
    expect(h.files.size).toBe(0);
  });
  test("injected fault requires both flags and other observations refuse them", () => {
    const injected = flags.map((value) =>
      value === "deterministic-test" ? "injected-fault" : value,
    );
    for (const extra of [[], ["--fault", "busy"], ["--fault-mechanism", "fake"]]) {
      expect(() => parseRunCaseArgs([...injected, ...extra, "--", "bun"])).toThrow(UsageError);
    }
    expect(
      parseRunCaseArgs([...injected, "--fault", "busy", "--fault-mechanism", "fake", "--", "bun"])
        .observation,
    ).toEqual({ kind: "injected-fault", fault: "busy", mechanism: "fake" });
    expect(() => parseRunCaseArgs([...flags, "--fault", "busy", "--", "bun"])).toThrow(UsageError);
  });
  test.each([
    { extra: [], command: false },
    { extra: [], command: true, empty: true },
    ...[
      ["--unknown"],
      ["--matrix-item", "0"],
      ["--evidence", "bad"],
      ["--evidence", "log"],
      ["--fixture", "bad"],
      ["--fixture", "fixture-host"],
      ["--not-exercised"],
    ].map((extra) => ({ extra, command: true })),
  ])("rejects malformed arguments %j", ({ extra, command, empty }) => {
    const args = [...flags, ...extra, ...(command ? (empty ? ["--"] : ["--", "bun"]) : [])];
    expect(() => parseRunCaseArgs(args)).toThrow(UsageError);
  });
});
