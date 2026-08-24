import { describe, expect, test } from "bun:test";
import {
  changedSourceFiles,
  findViolationsInSource,
  resolveBaseRef,
} from "../../scripts/check-host-shell-boundary";

describe("host shell execution boundary (issue #4068)", () => {
  test("rejects direct child_process shell APIs while allowing argv-first execution", () => {
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { exec } from "node:child_process"; exec("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'const { exec } = await import("child_process"); exec("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import * as childProcess from "node:child_process"; childProcess.exec("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import * as childProcess from "node:child_process"; const run = childProcess.exec; run("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'const { exec } = require("node:child_process"); exec("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource("fixture.ts", 'require("node:child_process").exec("curl $HOST");'),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'const exec = require("node:child_process").exec; exec("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        '(await import("node:child_process")).exec("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import * as childProcess from "node:child_process"; childProcess["exec"]("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { spawn } from "node:child_process"; spawn("/bin/sh", ["-c", command]);',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { spawn } from "node:child_process"; const shell = "/bin/sh"; spawn(shell, ["-c", command]);',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { spawn } from "node:child_process"; spawn("powershell.exe", ["-Command", command]);',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { spawn } from "node:child_process"; spawn("curl", [url], { shell: true });',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { spawn } from "node:child_process"; spawn("curl", [url], { shell: "/bin/bash" });',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "src/daemon/manager.ts",
        'import { execSync } from "node:child_process"; execSync("unreviewed");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { execFile } from "node:child_process"; execFile("curl", [url]);',
      ),
    ).toEqual([]);
  });

  test("rejects aliases of directly imported shell APIs", () => {
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { exec } from "node:child_process"; const run = exec; run("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { execSync } from "node:child_process"; class Runner { constructor(private readonly run = execSync) {} execute() { this.run("curl $HOST"); } }',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { exec } from "node:child_process"; function acceptRunner(_run: unknown) {} acceptRunner(exec);',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { exec } from "node:child_process"; const runner = { run: exec }; runner.run("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import * as childProcess from "node:child_process"; function acceptRunner(_run: unknown) {} acceptRunner(childProcess.exec);',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { execFile } from "node:child_process"; function acceptRunner(_run: unknown) {} acceptRunner(execFile);',
      ),
    ).toEqual([]);
  });

  test("rejects shell aliases destructured from a namespace import", () => {
    // Object binding pattern destructured from a registered child_process
    // namespace escaped the boundary before (no property/element access node).
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import * as cp from "node:child_process"; const { exec: run } = cp; run("curl $HOST");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import * as cp from "node:child_process"; const { exec } = cp; exec("curl $HOST");',
      ),
    ).toHaveLength(1);
    // A namespace re-aliased to another identifier stays covered too.
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import * as cp from "node:child_process"; const cp2 = cp; cp2.exec("curl $HOST");',
      ),
    ).toHaveLength(1);
    // Non-shell APIs destructured from a namespace remain argv-first (allowed).
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import * as cp from "node:child_process"; const { execFile } = cp; execFile("curl", [url]);',
      ),
    ).toEqual([]);
  });

  test("excludes references that never execute the shell API", () => {
    // Shadowing parameter resolves to the local binding, not the import.
    expect(
      findViolationsInSource(
        "fixture.ts",
        "import { exec } from \"node:child_process\"; function forward(exec: unknown) { consume(exec); }",
      ),
    ).toEqual([]);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { exec } from "node:child_process"; function forward(exec: (c: string) => void) { exec("curl $HOST"); }',
      ),
    ).toEqual([]);
    // Non-computed property/method names are declaration positions.
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { exec } from "node:child_process"; const opts = { exec: false };',
      ),
    ).toEqual([]);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { exec } from "node:child_process"; const api = { exec() { return 1; } };',
      ),
    ).toEqual([]);
    // Shorthand property is a value reference and stays detectable.
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { exec } from "node:child_process"; const runner = { exec }; runner.exec("curl $HOST");',
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // Type-only imports and type-position references introduce no runtime call.
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import type { exec } from "node:child_process"; type Executor = typeof exec;',
      ),
    ).toEqual([]);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import { type exec } from "node:child_process"; type Executor = typeof exec;',
      ),
    ).toEqual([]);
  });

  test("fails closed outside a Git worktree", () => {
    expect(() => changedSourceFiles("origin/main", false, false)).toThrow(
      "not a Git or Jujutsu worktree",
    );
  });

  test("uses the tracked main bookmark in a jj workspace", () => {
    const calls: string[][] = [];
    const runner = (file: string, args: string[]): string => {
      calls.push([file, ...args]);
      return file === "jj" && args[0] === "diff" ? "src/index.ts\n" : "";
    };

    expect(changedSourceFiles("origin/main", false, true, runner)).toEqual(["src/index.ts"]);
    expect(calls).toContainEqual(["jj", "log", "-r", "main@origin", "--no-graph", "-T", ""]);
    expect(calls).toContainEqual([
      "jj",
      "diff",
      "--from",
      "main@origin",
      "--to",
      "@",
      "--name-only",
      "src",
    ]);
  });

  test("fetches the pull request base in shallow GitHub checkouts", () => {
    const calls: string[][] = [];
    let checks = 0;
    const baseRef = resolveBaseRef(
      "origin/main",
      { GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "main" },
      (file, args) => {
        calls.push([file, ...args]);
        if (args[0] === "rev-parse" && checks++ === 0) {
          throw new Error("missing base");
        }
        return "";
      },
    );

    expect(baseRef).toBe("origin/main");
    expect(calls).toContainEqual([
      "git",
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      "refs/heads/main:refs/remotes/origin/main",
    ]);
  });
});
