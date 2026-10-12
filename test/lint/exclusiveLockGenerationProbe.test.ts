import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { scanExclusiveLockGenerationProbe } from "./exclusiveLockGenerationProbe";
import { typeScriptFiles, relativePosix } from "./astGuard";

const ROOT = path.join(import.meta.dir, "../..");
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;
// Exceptions must identify a file:line callsite and explain why PID-only ownership is safe.
const ALLOWLIST: readonly { file: string; reason: string }[] = [];
const IMPORT = 'import { tryAcquireExclusiveLock } from "../../src/utils/fileLock";';

describe("exclusive lock generation probe scanner", () => {
  test.each([
    ["tryAcquireExclusiveLock(p, { ownerGeneration: probe });", true],
    ["tryAcquireExclusiveLock(p);", false],
    ["tryAcquireExclusiveLock(p, { pid: 1 });", false],
    ["tryAcquireExclusiveLock(p, { ownerGeneration: undefined });", false],
    ["const claim = { ownerGeneration: probe }; tryAcquireExclusiveLock(p, claim);", true],
    ["tryAcquireExclusiveLock(p, { ...options });", false],
    ["tryAcquireExclusiveLock(p, options);", false],
  ] as const)("checks options: %s", (source, valid) => {
    expect(
      scanExclusiveLockGenerationProbe("test/lint/fixture.ts", `${IMPORT}\n${source}`),
    ).toEqual([{ line: 2, kind: "lock", valid }]);
  });
  test("resolves renamed imports", () => {
    expect(
      scanExclusiveLockGenerationProbe(
        "src/daemon/fixture.ts",
        `
      import { tryAcquireExclusiveLock as acquire } from "../utils/fileLock";
      acquire(p, { ownerGeneration: probe });
    `,
      ),
    ).toEqual([{ line: 3, kind: "lock", valid: true }]);
  });
  test("resolves namespace calls and rejects transparent undefined values", () => {
    expect(
      scanExclusiveLockGenerationProbe(
        "src/daemon/fixture.ts",
        'import * as locks from "../utils/fileLock";\nlocks.tryAcquireExclusiveLock(p, { ownerGeneration: undefined as Probe });',
      ),
    ).toEqual([{ line: 2, kind: "lock", valid: false }]);
  });
  test("does not borrow an options binding from another scope", () => {
    expect(
      scanExclusiveLockGenerationProbe(
        "test/lint/fixture.ts",
        `${IMPORT}\nfunction a() { const claim = {}; tryAcquireExclusiveLock(p, claim); }\nfunction b() { const claim = { ownerGeneration: probe }; }`,
      ),
    ).toEqual([{ line: 2, kind: "lock", valid: false }]);
  });
  test("a parameter's options cannot borrow a literal from an outer scope", () => {
    expect(
      scanExclusiveLockGenerationProbe(
        "test/lint/fixture.ts",
        `${IMPORT}\nconst claim = { ownerGeneration: probe }; function run(claim: Options) { tryAcquireExclusiveLock(p, claim); }`,
      ),
    ).toEqual([{ line: 2, kind: "lock", valid: false }]);
  });
  test("same-named literals in separate functions resolve to their own probe", () => {
    expect(
      scanExclusiveLockGenerationProbe(
        "test/lint/fixture.ts",
        `${IMPORT}\nfunction a() { const claim = { ownerGeneration: first }; tryAcquireExclusiveLock(p, claim); }\nfunction b() { const claim = { ownerGeneration: second }; tryAcquireExclusiveLock(p, claim); }`,
      ),
    ).toEqual([
      { line: 2, kind: "lock", valid: true },
      { line: 3, kind: "lock", valid: true },
    ]);
  });
  test("a shadowed imported callee is a local call", () => {
    expect(
      scanExclusiveLockGenerationProbe(
        "test/lint/fixture.ts",
        `${IMPORT}\nfunction run(tryAcquireExclusiveLock: F) { tryAcquireExclusiveLock(p); }`,
      ),
    ).toEqual([]);
  });
  test.each([true, false])("checks FileMigrationLock construction: probe=%s", (valid) => {
    expect(
      scanExclusiveLockGenerationProbe(
        "src/db/fixture.ts",
        `
      import { FileMigrationLock as Lock } from "./migrationLock";
      new Lock(p, ${valid ? "{ ownerGeneration: probe }" : "{}"});
    `,
      ),
    ).toEqual([{ line: 3, kind: "migration", valid }]);
  });
  test("checks the migration class's own exported constructor", () => {
    expect(
      scanExclusiveLockGenerationProbe(
        "src/db/migrationLock.ts",
        `
      export class FileMigrationLock {}
      new FileMigrationLock(p, {});
    `,
      ),
    ).toEqual([{ line: 3, kind: "migration", valid: false }]);
  });
  test("ignores unused imports and same-named local calls", () => {
    expect(
      scanExclusiveLockGenerationProbe(
        "src/fixture.ts",
        `
      import { tryAcquireExclusiveLock as acquire } from "./utils/fileLock";
      function tryAcquireExclusiveLock() {} tryAcquireExclusiveLock();
    `,
      ),
    ).toEqual([]);
  });
  test("fails on syntax errors", () => {
    expect(() => scanExclusiveLockGenerationProbe("broken.ts", "const =")).toThrow("broken.ts:");
  });
});

describe("production exclusive locks always supply a generation probe", () => {
  let calls: { file: string; line: number; kind: "lock" | "migration"; valid: boolean }[] = [];
  beforeAll(() => {
    calls = typeScriptFiles(path.join(ROOT, "src")).flatMap((file) => {
      const relative = relativePosix(ROOT, file);
      return relative === "src/utils/fileLock.ts"
        ? []
        : scanExclusiveLockGenerationProbe(relative, readFileSync(file, "utf8")).map((finding) => ({
            file: relative,
            ...finding,
          }));
    });
  }, TREE_SCAN_HOOK_TIMEOUT_MS);
  test("every acquisition and migration construction passes ownerGeneration", () => {
    const failures = calls.filter(
      (call) =>
        !call.valid && !ALLOWLIST.some((entry) => entry.file === `${call.file}:${call.line}`),
    );
    expect(failures).toEqual([]);
    expect(
      ALLOWLIST.filter(
        (entry) =>
          !entry.reason.trim() ||
          !calls.some((call) => !call.valid && entry.file === `${call.file}:${call.line}`),
      ),
    ).toEqual([]);
  });
  test("the scan sees real lock and migration callsites", () => {
    expect(calls.filter((call) => call.kind === "lock").length).toBeGreaterThanOrEqual(6);
    expect(calls.filter((call) => call.kind === "migration").length).toBeGreaterThanOrEqual(1);
  });
});
