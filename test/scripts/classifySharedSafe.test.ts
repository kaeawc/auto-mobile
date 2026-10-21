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
  singleton: `const manager = DeviceReadiness.getInstance();`,
  getInstanceAssignment: `IOSCtrlProxyClient.getInstance = () => client;`,
  installForTesting: `installDeviceDataStreamSocketServerForTesting(streamServer);`,
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

const PROVEN_SPIES: Record<string, string> = {
  parenthesized: `test("x", () => { (spyOn)(o, "f").mockRestore(); });`,
  bracketCall: `test("x", () => { mock["spyOn"](o, "f").mockRestore(); });`,
  immediate: `test("x", () => { spyOn(o, "f").mockRestore(); });`,
  stored: `let spy; beforeEach(() => { spy = spyOn(o, "f"); }); afterEach(() => { spy.mockRestore(); });`,
  afterAll: `let spy; beforeEach(() => { spy = spyOn(o, "f"); }); afterAll(() => spy.mockRestore());`,
  // A beforeEach spy restored only in afterAll needs an invariant target (#14515):
  // Bun reuses the spy on an already-spied method, so one restore suffices.
  afterAllImported: `import { logger } from "../src/logger"; let spy; beforeEach(() => { spy = spyOn(logger, "warn"); }); afterAll(() => spy.mockRestore());`,
  afterAllTopLevelConst: `const fake = new Fake(); let spy; beforeEach(() => { spy = spyOn(fake.inner, "f"); }); afterAll(() => spy.mockRestore());`,
  afterEachPerTestTarget: `const targets = [a, b]; let i = 0; let spy; beforeEach(() => { spy = spyOn(targets[i++], "f"); }); afterEach(() => spy.mockRestore());`,
  testAfterAllImported: `import { logger } from "../src/logger"; let spy; test("x", () => { spy = spyOn(logger, "warn"); }); afterAll(() => spy.mockRestore());`,
  afterAllRestoreAllPerTestTarget: `import { mock } from "bun:test"; const targets = [a, b]; let i = 0; beforeEach(() => { spyOn(targets[i++], "f"); }); afterAll(() => mock.restore());`,
  chained: `let spy; beforeEach(() => { spy = spyOn(o, "f").mockImplementation(() => {}); }); afterEach(() => spy.mockRestore());`,
  restoreAll: `import { mock } from "bun:test"; beforeEach(() => { spyOn(o, "f"); }); afterEach(() => { mock.restore(); });`,
  globalAfterAll: `test("x", () => { spyOn(o, "f"); }); afterAll(() => restoreAllMocks());`,
  jestAfterEach: `test("x", () => { spyOn(o, "f"); }); afterEach(() => jest.restoreAllMocks());`,
  finally: `test("x", () => { const spy = spyOn(o, "f"); try { work(); } finally { spy.mockRestore(); } });`,
  using: `test("x", () => { using spy = spyOn(o, "f").mockImplementation(() => {}); work(); });`,
  usingBeforeEach: `beforeEach(() => { using spy = spyOn(o, "f"); });`,
  sameTest: `test("x", () => { const spy = spyOn(o, "f"); work(); spy.mockRestore(); });`,
  aliased: `import { spyOn as watch, test as spec, afterEach as clean, mock as mocks } from "bun:test"; spec.each([1])("x", () => { watch(o, "f"); }); clean(() => mocks.restore());`,
  mockSpy: `test("x", () => { mock.spyOn(o, "f").mockRestore(); });`,
  namespace: `import * as bt from "bun:test"; bt.test("x", () => { bt.spyOn(o, "f"); }); bt.afterEach(() => bt.mock.restore());`,
  nestedScope: `describe("outer", () => { afterEach(() => mock.restore()); describe("inner", () => { test.only("x", () => { spyOn(o, "f"); }); }); });`,
  field: `const handles = {}; beforeEach(() => { handles.spy = spyOn(o, "f"); }); afterEach(() => handles.spy.mockRestore());`,
  index: `const spies = []; beforeEach(() => { spies[0] = spyOn(o, "f"); }); afterEach(() => spies[0].mockRestore());`,
  array: `test("x", () => { const spies = [spyOn(o, "f"), spyOn(o, "g")]; for (const spy of spies) { spy.mockRestore(); } });`,
  push: `const spies = []; beforeEach(() => { spies.push(spyOn(o, "f")); }); afterEach(() => { spies.forEach(spy => spy.mockRestore()); });`,
};

const UNPROVEN_SPIES: Record<string, string> = {
  beforeAll: `beforeAll(() => { spyOn(o, "f"); }); afterEach(() => mock.restore());`,
  before: `before(() => { spyOn(o, "f").mockRestore(); });`,
  parenthesizedMissing: `test("x", () => { (spyOn)(o, "f"); });`,
  aliasParenthesizedMissing: `import { spyOn as watch } from "bun:test"; test("x", () => { (watch)(o, "f"); });`,
  bracketMissing: `test("x", () => { mock["spyOn"](o, "f"); });`,
  missing: `test("x", () => { spyOn(o, "f"); });`,
  sibling: `describe("a", () => { test("x", () => { spyOn(o, "f"); }); }); describe("b", () => { afterEach(() => mock.restore()); });`,
  child: `describe("a", () => { test("x", () => { spyOn(o, "f"); }); describe("b", () => { afterEach(() => mock.restore()); }); });`,
  conditional: `test("x", () => { const spy = spyOn(o, "f"); if (ok) spy.mockRestore(); });`,
  conditionalGlobal: `test("x", () => { spyOn(o, "f"); }); afterEach(() => { if (ok) mock.restore(); });`,
  conditionalRegistration: `test("x", () => { spyOn(o, "f"); }); if (ok) afterEach(() => mock.restore());`,
  catchRegistration: `test("x", () => { spyOn(o, "f"); }); try {} catch { afterEach(() => mock.restore()); }`,
  optionalRegistration: `test("x", () => { spyOn(o, "f"); }); afterEach?.(() => mock.restore());`,
  shortCircuit: `test("x", () => { const spy = spyOn(o, "f"); ok && spy.mockRestore(); });`,
  optional: `test("x", () => { const spy = spyOn(o, "f"); spy?.mockRestore(); });`,
  earlyReturn: `test("x", () => { const spy = spyOn(o, "f"); if (ok) return; spy.mockRestore(); });`,
  topLevel: `const spy = spyOn(o, "f"); afterAll(() => spy.mockRestore());`,
  describeBody: `describe("x", () => { const spy = spyOn(o, "f"); afterAll(() => spy.mockRestore()); });`,
  helper: `function install() { return spyOn(o, "f"); } test("x", () => { const spy = install(); spy.mockRestore(); });`,
  nestedHelper: `test("x", () => { const helper = () => spyOn(o, "f"); helper().mockRestore(); });`,
  wrongHandle: `test("x", () => { const spy = spyOn(o, "f"); other.mockRestore(); });`,
  shadowedHandle: `let spy; beforeEach(() => { spy = spyOn(o, "f"); }); afterEach(() => { const spy = other; spy.mockRestore(); });`,
  shadowedMock: `test("x", () => { spyOn(o, "f"); }); afterEach(() => { const mock = fake; mock.restore(); });`,
  namedShadowedMock: `test("x", () => { spyOn(o, "f"); }); afterEach(function mock() { mock.restore(); });`,
  namedCleanup: `test("x", () => { spyOn(o, "f"); }); const clean = () => mock.restore(); afterEach(clean);`,
  overwritten: `test("x", () => { let spy = spyOn(o, "f"); spy = other; spy.mockRestore(); });`,
  overwrittenField: `test("x", () => { let h = {}; h.spy = spyOn(o, "f"); h = {}; h.spy.mockRestore(); });`,
  hookReassignedBeforeRestore: `let spy; afterEach(() => { spy = other; spy.mockRestore(); }); beforeEach(() => { spy = spyOn(o, "f"); });`,
  hookReassignedByTest: `let spy; test("x", () => { spy = other; }); beforeEach(() => { spy = spyOn(o, "f"); }); afterEach(() => spy.mockRestore());`,
  distinctFields: `test("x", () => { const h = {}; h["a.b"] = spyOn(o, "f"); h.a.b.mockRestore(); });`,
  earlyRestore: `test("x", () => { let spy; spy.mockRestore(); spy = spyOn(o, "f"); });`,
  oneLeaks: `test("x", () => { spyOn(o, "f").mockRestore(); spyOn(o, "g"); });`,
  concurrent: `test.concurrent("x", () => { spyOn(o, "f").mockRestore(); });`,
  filteredArray: `test("x", () => { const spies = [spyOn(o, "f")]; for (const spy of spies) { if (ok) spy.mockRestore(); } });`,
  aliasedBeforeAll: `import { spyOn as watch } from "bun:test"; beforeAll(() => watch(o, "f")); afterAll(() => mock.restore());`,
  // afterAll restores only the last spy a repeated beforeEach, test.each row or
  // test left in the handle (#14515).
  afterAllPerTestTarget: `const targets = [a, b]; let i = 0; let spy; beforeEach(() => { spy = spyOn(targets[i++], "f"); }); afterAll(() => spy.mockRestore());`,
  afterAllLetTarget: `let target; let spy; beforeEach(() => { target = pick(); spy = spyOn(target, "f"); }); afterAll(() => spy.mockRestore());`,
  afterAllLocalTarget: `let spy; beforeEach(() => { const fake = new Fake(); spy = spyOn(fake, "f"); }); afterAll(() => spy.mockRestore());`,
  afterAllCallTarget: `let spy; beforeEach(() => { spy = spyOn(make(), "f"); }); afterAll(() => spy.mockRestore());`,
  afterAllReassignedPath: `const deps = { client }; let spy; beforeEach(() => { deps.client = new Fake(); spy = spyOn(deps.client, "f"); }); afterAll(() => spy.mockRestore());`,
  afterAllComputedMethod: `let spy; beforeEach(() => { spy = spyOn(o, pickMethod()); }); afterAll(() => spy.mockRestore());`,
  testsReassignAfterAll: `let spy; test("a", () => { spy = spyOn(a, "f"); }); test("b", () => { spy = spyOn(b, "f"); }); afterAll(() => spy.mockRestore());`,
  testEachReassignAfterAll: `let spy; test.each([a, b])("x", (t) => { spy = spyOn(t, "f"); }); afterAll(() => spy.mockRestore());`,
  afterAllResetCollection: `let spies = []; beforeEach(() => { spies = []; spies.push(spyOn(make(), "f")); }); afterAll(() => { spies.forEach(spy => spy.mockRestore()); });`,
};

describe("spy restore proof", () => {
  test.each(Object.entries(PROVEN_SPIES))("proven: %s", (_name, source) => {
    expect(classifySource(source)).toEqual({ tier: "C", signals: [] });
  });
  test.each(Object.entries(UNPROVEN_SPIES))("unproven: %s", (_name, source) => {
    expect(classifySource(source).tier).toBe("B");
  });
  test.each(Object.entries(TIER_B).filter(([name]) => !["spyOn", "spyOnAlias"].includes(name)))(
    "proven spies preserve other signal: %s",
    (_name, source) => {
      expect(classifySource(`${PROVEN_SPIES.finally}\n${source}`).tier).toBe("B");
    },
  );
  test("reports leaking lines when an allow-listed file loses proof", () => {
    const io = new FakeIo(
      [
        {
          path: "test/a.test.ts",
          source: `test("x", () => {\n spyOn(o, "f");\n spyOn(o, "g");\n});`,
        },
      ],
      renderAllowlist(["test/a.test.ts"]),
    );
    expect(runCli(["--check"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("test/a.test.ts:2:");
    expect(io.errors.join("\n")).toContain("test/a.test.ts:3:");
  });
  test("--explain lists only spy-only blockers, or all sites for a requested file", () => {
    const io = new FakeIo(
      [
        { path: "test/a.test.ts", source: UNPROVEN_SPIES.beforeAll },
        { path: "test/b.test.ts", source: PROVEN_SPIES.finally },
        { path: "test/c.test.ts", source: `${UNPROVEN_SPIES.missing}\n${TIER_B.envWrite}` },
      ],
      undefined,
    );
    expect(runCli(["--explain"], io)).toBe(0);
    expect(io.logs).toHaveLength(1);
    expect(io.logs[0]).toContain("test/a.test.ts:1: spy installed in beforeAll");
    expect(runCli(["--explain", "test/c.test.ts"], io)).toBe(0);
    expect(io.logs.at(-1)).toContain("test/c.test.ts:1:");
    expect(runCli(["--explain", "missing"], io)).toBe(2);
    expect(io.written).toBeUndefined();
  });
});
