import { describe, expect, test } from "bun:test";
import {
  buildAllowlist,
  checkAllowlist,
  classifySource,
  type CliIo,
  isUnitTestPath,
  parseAllowlist,
  renderAllowlist,
  runCli,
  type UnitFile,
} from "../../scripts/test/classify-shared-safe";

// Fixture sources for each tier (#10583). They are strings, so this file
// itself classifies as tier A and always runs isolated.
const TIER_A: Record<string, string> = {
  mockModule: `mock.module("../../src/utils/logger", () => ({ logger: fake }));`,
  globalWrite: `globalThis.fetch = fakeFetch;`,
  definePropertyGlobal: `Object.defineProperty(globalThis, "navigator", { value: {} });`,
  chdir: `process.chdir(tempDir);`,
  nativePatch: `fs.readFileSync = () => "stub";`,
  bunPatch: `Bun.spawn = fakeSpawn;`,
};

const TIER_B: Record<string, string> = {
  spyOn: `const spy = spyOn(logger, "warn");`,
  envWrite: `process.env.AUTOMOBILE_DATA_DIR = dir;`,
  envBracketWrite: `process.env["HOME"] = dir;`,
  envDelete: `delete process.env.HOME;`,
  singleton: `const manager = DeviceSessionManager.getInstance();`,
  resetInstance: `afterEach(() => NavigationGraphManager.resetInstance());`,
  db: `const db = await createTestDatabase();`,
  dbHarness: `import { useNavigationTestHarness } from "../helpers/navigationTestHarness";`,
  testOverrides: `testOverrides.clock = fakeClock;`,
  systemTime: `setSystemTime(new Date(0));`,
  moduleSetter: `setObserveCacheStore(new FakeObserveCacheStore());`,
  moduleReset: `afterEach(() => resetAdbClientCaches());`,
  spyOnAlias: `import { spyOn as spyOnOutputSchema } from "bun:test";\nspyOnOutputSchema(schema, "parse");`,
  importedSingletonSetter: `import { serverConfig } from "../../src/utils/ServerConfig";\nserverConfig.setRawElementSearchEnabled(true);`,
  importedNestedSetter: `import * as cfg from "../../src/cfg";\ncfg.shared.resetCache();`,
  staticResetForTests: `afterEach(() => AndroidAvdProvenanceCache.resetForTests());`,
};

const TIER_C = [
  // Setters on a local fake are not shared state, even when the class is imported.
  `import { FakeThing } from "../fakes/FakeThing";\nconst fake = new FakeThing();\nfake.setMode(1);\nfake.resetCalls();`,
  `import { FakeTimer } from "../fakes/FakeTimer";\nconst timer = new FakeTimer();\nexpect(parse(input)).toEqual(expected);`,
  // Comparisons and reads are not writes.
  `if (process.env.CI === "true") {}\nexpect(globalThis.fetch === original).toBe(true);`,
  `const home = process.env.HOME;\nexpect(fs.existsSync(path)).toBe(false);`,
  // Methods on fakes and the timer globals are not module state.
  `fake.setCommandResponse("ls", ok);\nfakeTimer.resetCalls();\nawait new Promise((r) => setImmediate(r));\nsetTimeout(done, 0);`,
];

describe("classifySource", () => {
  test.each(Object.entries(TIER_A))("tier A: %s", (_signal, source) => {
    expect(classifySource(source).tier).toBe("A");
  });

  test.each(Object.entries(TIER_B))("tier B: %s", (_signal, source) => {
    expect(classifySource(source).tier).toBe("B");
  });

  test.each(TIER_C.map((source, index) => [index, source] as const))(
    "tier C fixture %d has no signal",
    (_index, source) => {
      expect(classifySource(source)).toEqual({ tier: "C", signals: [] });
    },
  );

  test("a tier A signal outranks tier B signals in the same file", () => {
    const result = classifySource(`${TIER_B.spyOn}\n${TIER_A.mockModule}`);
    expect(result.tier).toBe("A");
    expect(result.signals).toEqual(["mockModule", "spyOn"]);
  });
});

describe("unit-lane paths", () => {
  test("matches the discovery in scripts/test-ts.sh", () => {
    expect(isUnitTestPath("test/utils/a.test.ts")).toBe(true);
    expect(isUnitTestPath("test/utils/a.integration.test.ts")).toBe(false);
    expect(isUnitTestPath("test/stress/a.test.ts")).toBe(false);
    expect(isUnitTestPath("test/helpers/a.ts")).toBe(false);
    expect(isUnitTestPath("src/a.test.ts")).toBe(false);
  });
});

const files: UnitFile[] = [
  { path: "test/b/pure.test.ts", source: TIER_C[0] },
  { path: "test/a/pure.test.ts", source: TIER_C[1] },
  { path: "test/a/mocked.test.ts", source: TIER_A.mockModule },
  { path: "test/a/spied.test.ts", source: TIER_B.spyOn },
  { path: "test/a/real.integration.test.ts", source: TIER_C[0] },
  { path: "test/stress/load.test.ts", source: TIER_C[0] },
];

describe("buildAllowlist", () => {
  test("lists only tier C unit files, sorted, minus exclusions", () => {
    expect(buildAllowlist(files, {})).toEqual(["test/a/pure.test.ts", "test/b/pure.test.ts"]);
    expect(buildAllowlist(files, { "test/b/pure.test.ts": "leaks a cache" })).toEqual([
      "test/a/pure.test.ts",
    ]);
  });

  test("the rendered list round-trips through the parser, ignoring comments and CRLF", () => {
    const text = renderAllowlist(["test/a/pure.test.ts", "test/b/pure.test.ts"]);
    expect(text.startsWith("#")).toBe(true);
    expect(parseAllowlist(text.replaceAll("\n", "\r\n"))).toEqual([
      "test/a/pure.test.ts",
      "test/b/pure.test.ts",
    ]);
  });
});

describe("checkAllowlist", () => {
  test("a current list passes", () => {
    const result = checkAllowlist(["test/a/pure.test.ts", "test/b/pure.test.ts"], files, {});
    expect(result).toEqual({ problems: [], candidates: [] });
  });

  test("a listed file that gained a tier A or B signal fails", () => {
    const gained = files.map((file) =>
      file.path === "test/a/pure.test.ts" ? { ...file, source: TIER_B.envWrite } : file,
    );
    const { problems } = checkAllowlist(["test/a/pure.test.ts", "test/b/pure.test.ts"], gained, {});
    expect(problems).toEqual([
      "test/a/pure.test.ts: gained tier B signal(s) envWrite; it must run isolated",
    ]);
    const mocked = checkAllowlist(["test/a/mocked.test.ts"], files, {});
    expect(mocked.problems[0]).toContain("gained tier A signal(s) mockModule");
  });

  test("stale, non-unit, excluded, duplicate and unsorted entries fail", () => {
    const { problems } = checkAllowlist(
      [
        "test/b/pure.test.ts",
        "test/a/pure.test.ts",
        "test/a/pure.test.ts",
        "test/a/deleted.test.ts",
        "test/a/real.integration.test.ts",
      ],
      files,
      { "test/b/pure.test.ts": "leaks a cache" },
    );
    expect(problems).toEqual([
      "test/b/pure.test.ts: excluded from shared processes (leaks a cache)",
      "test/a/pure.test.ts: out of order (the list must be sorted)",
      "test/a/pure.test.ts: listed more than once",
      "test/a/deleted.test.ts: out of order (the list must be sorted)",
      "test/a/deleted.test.ts: not an existing unit-lane test file (stale entry)",
      "test/a/real.integration.test.ts: not an existing unit-lane test file (stale entry)",
    ]);
  });

  test("an unlisted tier C file is only a candidate: new files run isolated", () => {
    const result = checkAllowlist(["test/a/pure.test.ts"], files, {});
    expect(result).toEqual({ problems: [], candidates: ["test/b/pure.test.ts"] });
  });
});

class FakeIo implements CliIo {
  readonly logs: string[] = [];
  readonly errors: string[] = [];
  written: string | undefined;
  constructor(
    private readonly unitFiles: UnitFile[],
    private allowlist: string | undefined,
  ) {}
  listUnitFiles(): UnitFile[] {
    return this.unitFiles;
  }
  readAllowlist(): string | undefined {
    return this.allowlist;
  }
  writeAllowlist(text: string): void {
    this.written = text;
    this.allowlist = text;
  }
  log(message: string): void {
    this.logs.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

describe("runCli", () => {
  const unitFiles = files.filter((file) => isUnitTestPath(file.path));

  test("generate writes the list and --check then passes", () => {
    const io = new FakeIo(unitFiles, undefined);
    expect(runCli([], io)).toBe(0);
    expect(parseAllowlist(io.written ?? "")).toEqual(buildAllowlist(unitFiles));
    expect(runCli(["--check"], io)).toBe(0);
    expect(io.errors).toEqual([]);
  });

  test("--check fails with each problem and the regenerate hint", () => {
    const io = new FakeIo(unitFiles, renderAllowlist(["test/a/spied.test.ts"]));
    expect(runCli(["--check"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("test/a/spied.test.ts: gained tier B signal(s) spyOn");
    expect(io.errors.at(-1)).toContain("bun scripts/test/classify-shared-safe.ts");
    expect(io.written).toBeUndefined();
  });

  test("--check fails when the list is missing and rejects unknown arguments", () => {
    expect(runCli(["--check"], new FakeIo(unitFiles, undefined))).toBe(1);
    expect(runCli(["--fix"], new FakeIo(unitFiles, undefined))).toBe(2);
  });
});
