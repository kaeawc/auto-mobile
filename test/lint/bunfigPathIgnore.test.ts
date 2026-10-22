import { expect, test } from "bun:test";
import { join } from "node:path";

// #14717: with a bare relative path argument Bun scans the working tree for test
// files; a huge untracked directory (scratch/ Gradle home) then breaks child
// process output for the whole run. Keeping these directories out of the scan
// makes the repository gates independent of untracked files.
const root = join(import.meta.dir, "..", "..");

async function ignorePatterns(): Promise<string[]> {
  const config = Bun.TOML.parse(await Bun.file(join(root, "bunfig.toml")).text()) as {
    test?: { pathIgnorePatterns?: string[] };
  };
  return config.test?.pathIgnorePatterns ?? [];
}

test("bunfig keeps untracked build and scratch trees out of the test scan", async () => {
  const patterns = await ignorePatterns();
  expect(patterns).toEqual(expect.arrayContaining(["scratch/**", "android/**", "ios/**"]));
});

test("bunfig never ignores a directory that holds test files", async () => {
  const roots = (await ignorePatterns()).map((pattern) => pattern.split("/")[0]);
  expect(
    roots.filter((name) => ["test", "src", "scripts", "oxlint-plugins"].includes(name)),
  ).toEqual([]);
});
