import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
 *  2. `check:host-shell-boundary` compares the working tree against
 *     `origin/main`, so its verdict depends on the base position, not just
 *     `src/**` content. It must never be cached (`cache: false`), or turbo
 *     replays a stale verdict when the base moves.
 */
const repoRoot = path.resolve(import.meta.dir, "../..");
const turbo = JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf8"));

describe("turbo caching safety (#5124)", () => {
  test("typecheck task declares its full input set", () => {
    const task = turbo.tasks?.typecheck;
    expect(task).toBeDefined();
    const inputs: string[] = task.inputs ?? [];
    const required = [
      "src/**",
      "tsconfig.json",
      "scripts/typecheck-baseline.sh",
      "scripts/typecheck-baseline.txt",
      "package.json",
    ];
    for (const glob of required) {
      expect(inputs).toContain(glob);
    }
  });

  test("check:host-shell-boundary is not cached (diff-based, depends on origin/main)", () => {
    expect(turbo.tasks?.["check:host-shell-boundary"]?.cache).toBe(false);
  });
});
