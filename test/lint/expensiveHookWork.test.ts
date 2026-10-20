import { guardDirectoryEntries, readGuardFile } from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import { baselineEntries, scanExpensiveHookWork } from "./expensiveHookWork";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const TEST_DIR = path.join(REPO_ROOT, "test");
// Parsing every test file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;

function unitTestFiles(dir: string): string[] {
  return guardDirectoryEntries(dir).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || file === path.join(TEST_DIR, "integration")
        ? []
        : unitTestFiles(file);
    }
    return entry.name.endsWith(".test.ts") && !entry.name.endsWith(".integration.test.ts")
      ? [file]
      : [];
  });
}

function relativePosix(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function kindsIn(source: string): string[] {
  return scanExpensiveHookWork("fixture.test.ts", source).map(
    (finding) => `${finding.hook}:${finding.kind}`,
  );
}

describe("scanExpensiveHookWork", () => {
  test("flags a temp directory made in beforeEach and removed in afterEach", () => {
    const source = `
      import { afterEach, beforeEach } from "bun:test";
      let dir: string;
      beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "x-")); });
      afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
    `;
    expect(kindsIn(source)).toEqual(["beforeEach:temp-dir", "afterEach:recursive-rm"]);
    expect(kindsIn(String.raw`beforeEach(() => { mkd\u0074emp("x"); });`)).toEqual([
      "beforeEach:temp-dir",
    ]);
  });

  test("follows a hook that names a local function and the helpers it calls", () => {
    const source = `
      function build() { return new DevicePool(deps); }
      const setUp = () => { build(); mkdtempSync("x"); };
      beforeEach(setUp);
    `;
    expect(kindsIn(source).sort()).toEqual(["beforeEach:heavy-harness", "beforeEach:temp-dir"]);
  });

  test("flags the shared suite helpers that build a DevicePool per test", () => {
    const source = `
      beforeEach(() => { pool = makePool({ sessionManager }); });
      afterEach(() => { other = createDevicePoolFor(deps); });
    `;
    expect(kindsIn(source)).toEqual(["beforeEach:heavy-harness", "afterEach:heavy-harness"]);
  });

  test("flags image and zip fixtures built per test", () => {
    const source = `
      describe("x", () => {
        beforeEach(() => { const zip = new AdmZip(); image = new Jimp({ width: 1, height: 1 }); });
      });
    `;
    expect(kindsIn(source)).toEqual(["beforeEach:image-fixture", "beforeEach:image-fixture"]);
  });

  test("ignores the same work in beforeAll, afterAll and test bodies", () => {
    const source = `
      beforeAll(async () => { root = await fs.mkdtemp("x"); new DevicePool(deps); });
      afterAll(async () => { await fs.rm(root, { recursive: true }); });
      test("a", async () => { await fs.mkdtemp("y"); await fs.rm("y"); });
      beforeEach(() => { counter = 0; });
    `;
    expect(kindsIn(source)).toEqual([]);
  });

  test("does not flag the shared scratch-root helper, which makes one directory per test", () => {
    const source = `
      const scratch = useScratchRoot("x-");
      beforeEach(() => { dir = scratch.next(); });
    `;
    expect(kindsIn(source)).toEqual([]);
  });

  test("reports a syntax error instead of silently passing the file", () => {
    expect(() => scanExpensiveHookWork("broken.test.ts", "beforeEach(() => {")).toThrow();
  });
});

describe("expensive per-test hook work stays out of unit tests", () => {
  let found: string[] = [];

  beforeAll(() => {
    found = unitTestFiles(TEST_DIR)
      .map((file) => [relativePosix(file), readGuardFile(file)] as const)
      .flatMap(([file, source]) => baselineEntries(file, scanExpensiveHookWork(file, source)))
      .sort();
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no new test does mkdtemp, rm, image/zip or DevicePool construction in beforeEach/afterEach", () => {
    if (found.length > 0) {
      throw new Error(
        `Expensive beforeEach/afterEach work (CI per-test time includes these hooks, 5-15x on a ` +
          `contended runner):\n  ${found.map((entry) => entry.replace("\t", "  [") + "]").join("\n  ")}\n` +
          `Fix it: use useScratchRoot (test/helpers/scratchRoot.ts) for temp directories and build ` +
          `immutable fixtures/harnesses in beforeAll.`,
      );
    }
  });
});
