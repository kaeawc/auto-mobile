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
