import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { baselineEntries, scanExpensiveHookWork } from "./expensiveHookWork";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const TEST_DIR = path.join(REPO_ROOT, "test");
const BASELINE_FILE = path.join(import.meta.dir, "expensive-hook-work-baseline.txt");
// The baseline may only shrink: lower this when entries are removed, never raise it.
const BASELINE_CEILING = 148;
// Parsing every test file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;

function unitTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
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
  });

  test("follows a hook that names a local function and the helpers it calls", () => {
    const source = `
      function build() { return new DevicePool(deps); }
      const setUp = () => { build(); mkdtempSync("x"); };
      beforeEach(setUp);
    `;
    expect(kindsIn(source).sort()).toEqual(["beforeEach:heavy-harness", "beforeEach:temp-dir"]);
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
  const baseline = readFileSync(BASELINE_FILE, "utf8").split("\n").filter(Boolean);
  let found: string[] = [];

  beforeAll(() => {
    found = unitTestFiles(TEST_DIR)
      .map((file) => [relativePosix(file), readFileSync(file, "utf8")] as const)
      .flatMap(([file, source]) => baselineEntries(file, scanExpensiveHookWork(file, source)));
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no new test does mkdtemp, rm, image/zip or DevicePool construction in beforeEach/afterEach", () => {
    const added = found.filter((entry) => !baseline.includes(entry));
    // CI's per-test time includes beforeEach/afterEach but not beforeAll/afterAll, and a contended
    // runner stretches it 5-15x. Use useScratchRoot (test/helpers/scratchRoot.ts) for temp
    // directories, and build immutable fixtures or harnesses once in beforeAll.
    expect(added).toEqual([]);
  });

  test("the baseline lists only still-offending files, so it can only shrink", () => {
    const stale = baseline.filter((entry) => !found.includes(entry));
    // Fixed a file? Delete its line from expensive-hook-work-baseline.txt and lower the ceiling.
    expect(stale).toEqual([]);
    expect(baseline.length).toBeLessThanOrEqual(BASELINE_CEILING);
  });

  test("the baseline is sorted and free of duplicates", () => {
    expect(baseline).toEqual([...new Set(baseline)].sort());
  });
});
