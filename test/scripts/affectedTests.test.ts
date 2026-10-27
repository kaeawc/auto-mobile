import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  selectAffectedTests,
  parseIntegrationTiers,
  affectedTestsExitCode,
  parseAlwaysRun,
} from "../../scripts/lib/affectedTests";
import { FakeSourceReader } from "../fakes/FakeSourceReader";

// In-memory replay pins keep selector unit tests independent of filesystem/git state.
const fixtures = new Map<number, string[]>([
  [12426, ["src/daemon/devicePool.ts", "src/daemon/foreignClaims.ts"]],
  [
    12443,
    [
      "src/db/keyedJsonConfigRepository.ts",
      "test/db/keyedJsonConfigRepository.integration.test.ts",
    ],
  ],
  [
    12458,
    [
      "docs/using/environment-variables.md",
      "src/db/keyedJsonConfigRepository.ts",
      "src/db/migrationDependencyIntegrity.ts",
      "src/features/observe/AwaitIdle.ts",
      "src/features/observe/Idle.ts",
      "src/models/UiStabilityResult.ts",
      "src/server/deviceTools.ts",
      "test/db/keyedJsonConfigRepository.legacyRows.test.ts",
      "test/features/observe/AwaitIdle.test.ts",
      "test/features/observe/Idle.test.ts",
      "test/server/deviceTools.appResourceDependencies.test.ts",
    ],
  ],
  [12474, ["bun.lock", "package.json", "scripts/release/runtime-graph.json"]],
  [
    12480,
    [
      "scripts/unit-test-host-spawn-allowlist.txt",
      "test/features/observe/audits/SafeAreaAuditor.test.ts",
      "test/lint/relativeImportCasing.test.ts",
      "test/server/toolRegistration.integration.test.ts",
      "test/shared-process-allowlist.txt",
    ],
  ],
]);
const db = "test/db/keyedJsonConfigRepository.integration.test.ts";
const tool = "test/server/toolRegistration.integration.test.ts";
const explicit = "test/server/readToolsExplicitDeviceIdRule.test.ts";
const runtime = "test/packaging/runtimeGraphPinning.test.ts";
const migrations = "test/scripts/dbMigrationsSelfContained.test.ts";
const graph = {
  "src/daemon/devicePool.ts": 'import "./foreignClaims";',
  "src/daemon/foreignClaims.ts": "export {};",
  "src/db/keyedJsonConfigRepository.ts": "export {};",
  [explicit]: 'import "../../src/daemon/devicePool";',
  [db]: 'import "../../src/db/keyedJsonConfigRepository";',
  [tool]: "export {};",
  [runtime]:
    'path.join(repoRoot, "scripts/release/runtime-graph.json"); path.join(repoRoot, "package.json");',
  [migrations]: 'import packageJson from "../../package.json";',
  "package.json": "{}",
};
const tierList = `${db} | safe | fake DB\n${tool} | safe | fake tools`;
const select = (changedFiles: string[], files = graph) =>
  selectAffectedTests({ reader: new FakeSourceReader(files), changedFiles, tierList });

describe("affected tests", () => {
  test("replays daemon imports", () =>
    expect(select(fixtures.get(12426)!).unit).toContain(explicit));
  test("replays both DB regressions", () => {
    for (const id of [12443, 12458]) {
      expect(select(fixtures.get(id)!).integrationSafe).toContain(db);
    }
  });
  test("replays runtime graph references and JSON imports", () => {
    const result = select(fixtures.get(12474)!);
    expect(result.unit).toEqual([runtime, migrations].sort());
    expect(result.unitReferenceOnly).toEqual([runtime]);
  });
  test("excludes import-only and overlapping paths from unit extras", () => {
    const result = select(["package.json"]);
    expect(result.unit).toEqual([runtime, migrations].sort());
    expect(result.unitReferenceOnly).toEqual([runtime]);
    expect(select(["package.json", runtime]).unitReferenceOnly).toEqual([]);
    const overlapping = select(["package.json", "src/daemon/devicePool.ts"], {
      ...graph,
      [runtime]: `${graph[runtime]} import "../../src/daemon/devicePool";`,
    });
    expect(overlapping.unit).toContain(runtime);
    expect(overlapping.unitReferenceOnly).toEqual([]);
  });
  test("replays changed safe integration test", () =>
    expect(select(fixtures.get(12480)!).integrationSafe).toContain(tool));
  test("reports unsafe and unlisted integration, skips stress and deleted tests", () => {
    const reader = new FakeSourceReader({
      "test/a.integration.test.ts": 'import "../src/deleted";',
      "test/b.integration.test.ts": 'import "../src/deleted";',
      "test/stress/a.test.ts": 'import "../../src/deleted";',
    });
    const result = selectAffectedTests({
      reader,
      changedFiles: ["src/deleted.ts", "test/gone.test.ts"],
      tierList: "test/a.integration.test.ts | unsafe | host",
    });
    expect(result.unit).toEqual([]);
    expect(result.integrationUnsafeSkipped).toEqual(["test/a.integration.test.ts"]);
    expect(result.integrationUnlisted).toEqual(["test/b.integration.test.ts"]);
    expect(result.reasons["test/a.integration.test.ts"]).toContain("skipped unsafe");
    expect(affectedTestsExitCode(result)).toBe(3);
    expect(result.reasons["test/b.integration.test.ts"]).toContain("unlisted");
  });
  test("unlisted changed integration fails while unsafe and empty selections succeed", () => {
    const file = "test/new.integration.test.ts";
    const reader = new FakeSourceReader({ [file]: "export {};" });
    const result = selectAffectedTests({ reader, changedFiles: [file], tierList: "" });
    expect(result.integrationUnlisted).toEqual([file]);
    expect(result.integrationUnsafeSkipped).toEqual([]);
    expect(affectedTestsExitCode(result)).toBe(3);
    const unsafe = selectAffectedTests({
      reader,
      changedFiles: [file],
      tierList: `${file} | unsafe`,
    });
    expect(unsafe.integrationUnsafeSkipped).toEqual([file]);
    expect(affectedTestsExitCode(unsafe)).toBe(0);
    expect(affectedTestsExitCode(select([]))).toBe(0);
  });
  test.each(["test/new.integration.test.ts", "test/integration-safe-tier.txt"])(
    "classification change forces tier validator into both unit lists: %s",
    (changed) => {
      const validator = "test/scripts/integrationSafeTier.test.ts";
      const reader = new FakeSourceReader({ [validator]: "export {};" });
      // Even a validator already in the import closure must be an explicit extra.
      for (const changedFiles of [[changed], [changed, validator]]) {
        const result = selectAffectedTests({ reader, changedFiles, tierList: "" });
        expect(result.unit).toEqual([validator]);
        expect(result.unitReferenceOnly).toEqual([validator]);
      }
    },
  );
  test.each(["docs/design", "docs/design/"])("matches directory prefixes: %s", (directory) => {
    const reader = new FakeSourceReader({
      "test/folder.test.ts": `const directory = "${directory}";`,
      "test/sibling.test.ts": 'const directory = "docs/design-other";',
    });
    for (const changed of ["docs/design/nested/a.md", "docs/design/a.ts"]) {
      const result = selectAffectedTests({ reader, changedFiles: [changed], tierList: "" });
      expect(result.unit).toEqual(["test/folder.test.ts"]);
      expect(result.unitReferenceOnly).toEqual(result.unit);
    }
  });
  test.each(["readdir", "readdirSync", "Glob", "glob"])(
    "top-level directory requires an AST walk identifier: %s",
    (identifier) => {
      const reader = new FakeSourceReader({
        "scripts/walk.ts": `const root = "docs/"; void ${identifier};`,
        "test/walk.test.ts": 'import "../scripts/walk";',
        "test/bare.test.ts": 'const root = "docs";',
        "test/comment.test.ts": `const root = "docs"; // ${identifier}`,
        "test/string.test.ts": `const root = "docs"; const name = "${identifier}";`,
        "test/other.test.ts": `const root = "schemas"; void ${identifier};`,
      });
      expect(
        selectAffectedTests({ reader, changedFiles: ["docs/a.md"], tierList: "" }).unit,
      ).toEqual(["test/walk.test.ts"]);
    },
  );
  test("follows all import forms, cycles, deleted substitutes and index resolution", () => {
    const reader = new FakeSourceReader({
      "src/a.ts": 'export * from "./folder";',
      "src/folder/index.ts": 'import x = require("../gone.js");',
      "test/helper.ts": 'const a = require("../src/a"); import "./cycle";',
      "test/cycle.ts": 'import "./helper";',
      "test/a.test.ts": 'void import("./helper");',
    });
    expect(
      selectAffectedTests({ reader, changedFiles: ["src/gone.ts"], tierList: "" }).unit,
    ).toEqual(["test/a.test.ts"]);
  });
  test("AST literals and template chunks seed transitive helpers, ignoring comments", () => {
    const reader = new FakeSourceReader({
      "scripts/helper.ts":
        "const x = `prefix/${root}/rules.txt`; const y = `docs/readme.md${suffix}`;",
      "test/a.test.ts": 'import "../scripts/helper";',
      "test/b.test.ts": 'const x = "rules.txt";',
      "test/comment.test.ts": '// "rules.txt"',
    });
    const result = selectAffectedTests({
      reader,
      changedFiles: ["config/rules.txt"],
      tierList: "",
    });
    expect(result.unit).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(result.unitReferenceOnly).toEqual(result.unit);
    expect(
      selectAffectedTests({ reader, changedFiles: ["docs/readme.md"], tierList: "" }).unit,
    ).toEqual(["test/a.test.ts"]);
  });
  test("selects changed tests and resolves TSX, MTS and extensionless JSON", () => {
    const reader = new FakeSourceReader({
      "src/view.tsx": "export {};",
      "src/esm.mts": "export {};",
      "src/config.json": "{}",
      "test/a.test.ts":
        'import "../src/view.js"; export * from "../src/esm.mjs"; import "../src/config";',
      "test/b.test.ts": "export {};",
    });
    for (const changed of ["src/view.tsx", "src/esm.mts", "src/config.json", "test/a.test.ts"]) {
      expect(selectAffectedTests({ reader, changedFiles: [changed], tierList: "" }).unit).toEqual([
        "test/a.test.ts",
      ]);
    }
    expect(
      selectAffectedTests({ reader, changedFiles: ["test/b.test.ts"], tierList: "" }).unit,
    ).toEqual(["test/b.test.ts"]);
  });
  test("sets both cap fallbacks without discarding selections", () => {
    const result = selectAffectedTests({
      reader: new FakeSourceReader(graph),
      changedFiles: [explicit, db, "scripts/release/runtime-graph.json"],
      tierList,
      maxUnit: 0,
      maxIntegration: 0,
    });
    expect(result.fallback).toEqual({ unitFallback: true, integrationFallback: true });
    expect(result.unit).toEqual([runtime, explicit].sort());
    expect(result.unitReferenceOnly).toEqual([runtime]);
    expect(result.integrationSafe).toEqual([db]);
  });
  test("import-only unit selections do not consume the extra-unit cap", () => {
    const result = selectAffectedTests({
      reader: new FakeSourceReader(graph),
      changedFiles: [explicit, "package.json"],
      tierList,
      maxUnit: 1,
    });
    expect(result.unit).toHaveLength(3);
    expect(result.unitReferenceOnly).toEqual([runtime]);
    expect(result.fallback.unitFallback).toBe(false);
  });
  test.each([
    'import type { A } from "../src/a";',
    'import type A from "../src/a";',
    'import type * as A from "../src/a";',
    'export type { A } from "../src/a";',
    'export type * from "../src/a";',
    'import { type A, type B } from "../src/a";',
    'export { type A, type B } from "../src/a";',
    'import type A = require("../src/a");',
  ])("ignores type-only edge: %s", (source) => {
    const reader = new FakeSourceReader({ "test/a.test.ts": source });
    expect(selectAffectedTests({ reader, changedFiles: ["src/a.ts"], tierList: "" }).unit).toEqual(
      [],
    );
  });
  test.each([
    'import { type A, B } from "../src/a";',
    'import A, { type B } from "../src/a";',
    'export { type A, B } from "../src/a";',
    'import A = require("../src/a");',
    'import {} from "../src/a";',
    'export {} from "../src/a";',
  ])("retains runtime edge: %s", (source) => {
    const reader = new FakeSourceReader({ "test/a.test.ts": source });
    const result = selectAffectedTests({ reader, changedFiles: ["src/a.ts"], tierList: "" });
    expect(result.unit).toEqual(["test/a.test.ts"]);
    expect(result.unitReferenceOnly).toEqual([]);
  });
  test("empty changes select nothing", () => expect(select([]).unit).toEqual([]));
  test("tier parser trims fields and ignores comments", () => {
    expect([
      ...parseIntegrationTiers(
        "# comment\na | safe | reason\nb | unsafe | reason\nc | unknown | reason",
      ),
    ]).toEqual([
      ["a", "safe"],
      ["b", "unsafe"],
    ]);
  });

  describe("always-run list", () => {
    const audit = "test/server/interactionTools.outputSchema.test.ts";
    const bats = "test/bats/linux-qualification-workflow.bats";
    const reader = new FakeSourceReader({ [audit]: "export {};", "src/a.ts": "export {};" });
    const run = (changedFiles: string[], alwaysRun: string[]) =>
      selectAffectedTests({ reader, changedFiles, tierList: "", alwaysRun });

    test("parses paths, ignoring comments and blanks", () =>
      expect(parseAlwaysRun(`# note\n\n  ${audit}  \n${bats}\n`)).toEqual([audit, bats]));
    test("selects listed tests regardless of what changed, even when nothing did", () => {
      for (const changed of [["src/a.ts"], ["docs/x.md"], []]) {
        const result = run(changed, [audit, bats]);
        expect(result.unit).toEqual([audit]);
        expect(result.unitReferenceOnly).toEqual([audit]);
        expect(result.alwaysRunBats).toEqual([bats]);
        expect(affectedTestsExitCode(result)).toBe(0);
      }
    });
    test("does not duplicate a listed test already selected as changed", () => {
      expect(run([audit], [audit]).unitReferenceOnly).toEqual([audit]);
    });
    test("a stale entry fails the gate", () => {
      const result = run([], ["test/gone.test.ts"]);
      expect(result.alwaysRunMissing).toEqual(["test/gone.test.ts"]);
      expect(affectedTestsExitCode(result)).toBe(3);
    });
    test("the checked-in list covers the whole-repo stale path scan (#14499)", () => {
      // It walks every tracked path, so a change under a directory the
      // --changed repository-lint predicate omits (e.g. benchmark/) can still
      // break it; always-run closes that gap without widening the predicate.
      const listed = parseAlwaysRun(
        readFileSync(path.join(import.meta.dir, "../always-run-tests.txt"), "utf8"),
      );
      expect(listed).toContain("test/lint/staleRepoPathReferences.test.ts");
    });
    test("the checked-in list parses and has no duplicates", () => {
      const listed = parseAlwaysRun(
        readFileSync(path.join(import.meta.dir, "../always-run-tests.txt"), "utf8"),
      );
      expect(listed.length).toBeGreaterThan(0);
      expect(new Set(listed).size).toBe(listed.length);
      for (const file of listed) {
        expect(existsSync(path.join(import.meta.dir, "../..", file))).toBe(true);
      }
    });
  });
});
