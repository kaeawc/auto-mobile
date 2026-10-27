import { readGuardFile } from "./astGuard";
import { describe, expect, test } from "bun:test";

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * turbo caching-safety guard (issue #5124).
 *
 * Two ways turbo caching silently goes wrong for this repo's gates, pinned here
 * so a later edit can't reintroduce them:
 *
 *  1. `typecheck` is a cached task keyed on its declared `inputs`. Drop an input
 *     and an unchanged-input edit can replay a stale (green) verdict for a `src/`
 *     change that would now fail — so the full input set is asserted here.
 *     The same holds for the shell helpers the gate script sources (#14451):
 *     `typecheck-baseline.sh` sources `host-heavy-run.sh`, which sources
 *     `host-slots.sh`, so a helper-only edit must bust both typecheck tasks.
 *  2. `check:host-shell-boundary` compares the working tree against
 *     `origin/main`, so its verdict depends on the base position, not just
 *     `src/**` content. It must never be cached (`cache: false`), or turbo
 *     replays a stale verdict when the base moves.
 */
const repoRoot = path.resolve(import.meta.dir, "../..");
const turbo = JSON.parse(readGuardFile(path.join(repoRoot, "turbo.json")));

const TYPECHECK_SCRIPT = "scripts/typecheck-baseline.sh";

// `source "$ROOT/scripts/lib/x.sh"` / `. "${root}/scripts/x.sh"`: every helper in
// this chain is sourced through a repository-root variable.
const SOURCE_LINE = /^\s*(?:source|\.)\s+"\$\{?\w+\}?\/(scripts\/[^"]+\.sh)"/gm;

/** Repository-relative shell scripts `script` sources, transitively, excluding itself. */
function sourcedScriptChain(script: string): string[] {
  const seen = new Set<string>([script]);
  const pending = [script];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const text = readGuardFile(path.join(repoRoot, current));
    for (const match of text.matchAll(SOURCE_LINE)) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        pending.push(match[1]);
      }
    }
  }
  seen.delete(script);
  return [...seen].sort();
}

function coveredBy(inputs: readonly string[], file: string): boolean {
  return (
    inputs.some((input) => !input.startsWith("!") && new Bun.Glob(input).match(file)) &&
    !inputs.some((input) => input.startsWith("!") && new Bun.Glob(input.slice(1)).match(file))
  );
}

describe("turbo caching safety (#5124)", () => {
  test("typecheck task declares its full input set", () => {
    const task = turbo.tasks?.typecheck;
    expect(task).toBeDefined();
    const inputs: string[] = task.inputs ?? [];
    const required = [
      "src/**",
      "test/**/*.typecheck.ts",
      "tsconfig.json",
      TYPECHECK_SCRIPT,
      "scripts/lib/host-heavy-run.sh",
      "scripts/lib/host-slots.sh",
      "package.json",
    ];
    for (const glob of required) {
      expect(inputs).toContain(glob);
    }
  });

  test("typecheck:test task declares its full input set", () => {
    const task = turbo.tasks?.["typecheck:test"];
    expect(task).toBeDefined();
    const inputs: string[] = task.inputs ?? [];
    const required = [
      "src/**",
      "test/**/*.ts",
      "tsconfig.json",
      "tsconfig.test.json",
      "tsconfig.test-*.json",
      TYPECHECK_SCRIPT,
      "scripts/lib/host-heavy-run.sh",
      "scripts/lib/host-slots.sh",
      "package.json",
    ];
    for (const glob of required) {
      expect(inputs).toContain(glob);
    }
  });

  test("every helper the typecheck script sources invalidates both typecheck tasks (#14451)", () => {
    const chain = sourcedScriptChain(TYPECHECK_SCRIPT);
    // Pin the scan itself: if it stopped matching, the coverage check below would pass vacuously.
    expect(chain).toEqual(
      expect.arrayContaining(["scripts/lib/host-heavy-run.sh", "scripts/lib/host-slots.sh"]),
    );
    expect(chain.filter((script) => !existsSync(path.join(repoRoot, script)))).toEqual([]);
    for (const name of ["typecheck", "typecheck:test"]) {
      const inputs: string[] = turbo.tasks?.[name]?.inputs ?? [];
      expect({
        task: name,
        uncovered: chain.filter((script) => !coveredBy(inputs, script)),
      }).toEqual({
        task: name,
        uncovered: [],
      });
    }
  });

  test("check:host-shell-boundary is not cached (diff-based, depends on origin/main)", () => {
    expect(turbo.tasks?.["check:host-shell-boundary"]?.cache).toBe(false);
  });
});
