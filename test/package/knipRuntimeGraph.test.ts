import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as T;
}

// Tool binaries invoked from shell scripts, which knip cannot see.
const SHELL_ONLY_TOOLS = ["oxlint", "oxlint-tsgolint", "@typescript/native-preview"];

describe("knip.json ignoreDependencies", () => {
  const graph = readJson<{ roots: string[]; dependencies: Record<string, string> }>(
    "scripts/release/runtime-graph.json",
  );
  const knip = readJson<{ ignoreDependencies: string[] }>("knip.json");
  const transitiveMembers = Object.keys(graph.dependencies).filter(
    (name) => !graph.roots.includes(name),
  );

  test("never ignores a runtime-graph root", () => {
    for (const name of graph.roots) {
      expect(knip.ignoreDependencies).not.toContain(name);
    }
  });

  test("only names runtime-graph members or shell-only tools", () => {
    const allowed = new Set([...transitiveMembers, ...SHELL_ONLY_TOOLS]);
    const stray = knip.ignoreDependencies.filter((name) => !allowed.has(name));
    expect(stray).toEqual([]);
  });
});
