import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Child Bun startup belongs in the host integration lane, like the existing
// logger-init-pidfile-crash test; it is exempt from the 100ms unit-test ratchet.
let fixtureDir: string;
beforeAll(() => {
  fixtureDir = mkdtempSync(join(root, "test/.tmp-spawn-guard-preload-"));
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

function runFixture(name: string, hook: string) {
  const fixture = join(fixtureDir, `${name}.test.ts`);
  writeFileSync(
    fixture,
    `import { afterAll, expect, test } from "bun:test";\n` +
      `test("passes", () => expect(true).toBe(true));\n${hook}\n`,
  );
  const env = { ...process.env };
  delete env.AUTOMOBILE_SPAWN_GUARD_CENSUS_FILE;
  delete env.AUTOMOBILE_SPAWN_GUARD_ALLOWLIST;
  delete env.BUN_OPTIONS;
  return Bun.spawnSync([process.execPath, "test", "--isolate", fixture], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
}

// File attribution is intentionally unavailable on Windows in the preload.
const guardedTest = process.platform === "win32" ? test.skip : test;
guardedTest("preload fails a swallowed device launch in a file's afterAll", () => {
  const result = runFixture(
    "swallowed",
    'afterAll(() => { try { Bun.spawnSync(["adb", "devices"]); } catch { /* Intentionally swallowed: prove the final drain. */ } });',
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString() + result.stderr.toString()).toContain("real device tool spawned");
});

guardedTest("preload fails an uncaught device launch in a file's afterAll", () => {
  const result = runFixture("uncaught", 'afterAll(() => { Bun.spawnSync(["adb", "devices"]); });');
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString() + result.stderr.toString()).toContain("real device tool spawned");
});

guardedTest("preload leaves a clean passing file green", () => {
  const result = runFixture("clean", "afterAll(() => {});");
  expect(result.exitCode).toBe(0);
});

interface FixtureRunOptions {
  isolate?: boolean;
  env?: Record<string, string>;
}

function runFiles(files: Record<string, string>, options: FixtureRunOptions = {}) {
  const paths = Object.entries(files).map(([name, body]) => {
    const path = join(fixtureDir, name);
    writeFileSync(path, body);
    return path;
  });
  const env = { ...process.env };
  delete env.AUTOMOBILE_SPAWN_GUARD_CENSUS_FILE;
  delete env.AUTOMOBILE_SPAWN_GUARD_ALLOWLIST;
  delete env.BUN_OPTIONS;
  return Bun.spawnSync(
    [process.execPath, "test", ...(options.isolate ? ["--isolate"] : []), ...paths],
    { cwd: root, env: { ...env, ...options.env }, stdout: "pipe", stderr: "pipe", timeout: 5000 },
  );
}

const passingTest =
  'import { test, expect } from "bun:test"; test("clean", () => expect(true).toBe(true));';
const swallowedLaunch =
  'try { Bun.spawnSync(["adb", "devices"]); } catch { /* Expected guard rejection. */ }';

describe("classification independent of the process argv file", () => {
  const results = new Map<string, ReturnType<typeof runFiles>>();
  beforeAll(() => {
    if (process.platform === "win32") {
      return;
    }
    // Exempt launches use only this inert executable, never a device tool.
    writeFileSync(join(fixtureDir, "adb"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { PATH: `${fixtureDir}:${process.env.PATH ?? ""}` };
    const launchTest = `import { test, expect } from "bun:test";
      console.info("selected argv file: " + process.argv[1]);
      test("launch", () => expect(Bun.spawnSync(["adb", "devices"]).exitCode).toBe(0));`;
    results.set(
      "unit followed by integration",
      runFiles(
        {
          "argv-unit.test.ts": launchTest,
          "argv-last.integration.test.ts": passingTest,
        },
        { env },
      ),
    );
    results.set(
      "integration followed by unit",
      runFiles(
        {
          "argv-first.integration.test.ts": passingTest,
          "argv-after.test.ts": launchTest,
        },
        { env },
      ),
    );
    results.set(
      "integration alone",
      runFiles(
        {
          "argv-alone.integration.test.ts": launchTest,
        },
        { env },
      ),
    );
    results.set(
      "clean unit followed by integration",
      runFiles(
        {
          "argv-clean.test.ts": passingTest,
          "argv-launch.integration.test.ts": launchTest,
        },
        { env },
      ),
    );
  });
  // Child startup is setup work; each separate assertion stays below 100ms.
  guardedTest("unit spawn fails when followed by an integration file", () => {
    const result = results.get("unit followed by integration");
    expect(result).toBeDefined();
    expect(result?.exitCode).not.toBe(0);
    const output = result?.stdout.toString() + result?.stderr.toString();
    expect(output).toContain(
      "real device tool spawned: " + join(fixtureDir, "argv-unit.test.ts").slice(root.length),
    );
  });
  guardedTest("unit spawn fails when process argv selects an integration file", () => {
    const result = results.get("integration followed by unit");
    expect(result).toBeDefined();
    expect(result?.exitCode).not.toBe(0);
    const output = result?.stdout.toString() + result?.stderr.toString();
    expect(output).toContain(
      "real device tool spawned: " + join(fixtureDir, "argv-after.test.ts").slice(root.length),
    );
    expect(output).toContain(
      "selected argv file: " + join(fixtureDir, "argv-first.integration.test.ts"),
    );
  });
  for (const name of ["integration alone", "clean unit followed by integration"]) {
    guardedTest(`${name} permits an integration spawn`, () => {
      const result = results.get(name);
      expect(result).toBeDefined();
      expect(result?.exitCode).toBe(0);
      expect(result?.stdout.toString() + result?.stderr.toString()).not.toContain(
        "real device tool spawned",
      );
    });
  }
});

guardedTest(
  "shared process attributes a swallowed launch to its test and leaves later tests green",
  () => {
    for (const isolate of [false, true]) {
      const result = runFiles(
        {
          "first.integration.test.ts": passingTest,
          "actual.test.ts": `import { test, expect } from "bun:test";
          test("offender", () => { ${swallowedLaunch} });
          test("later clean", () => expect(true).toBe(true));`,
          "last.test.ts": passingTest,
        },
        { isolate },
      );
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain(
        "real device tool spawned: " + join(fixtureDir, "actual.test.ts").slice(root.length),
      );
      expect(output).toContain("3 pass");
      expect(output).toContain("1 fail");
      expect(output).toContain("(fail) offender");
      expect(output).not.toContain(
        "real device tool spawned: " +
          join(fixtureDir, "first.integration.test.ts").slice(root.length),
      );
    }
  },
);

guardedTest(
  "a swallowed import launch fails once outside tests without failing later files",
  () => {
    const result = runFiles({
      "import-launch.test.ts": `${passingTest}\n${swallowedLaunch}`,
      "after-import.test.ts": passingTest,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("2 pass");
    expect(output).toContain("1 fail");
    expect(output).not.toContain("(fail) clean");
    expect(output).toContain("import-launch.test.ts: adb devices");
  },
);

guardedTest(
  "shared census attributes each unit file and allow-list override applies to the actual file",
  () => {
    const names = ["census-a.test.ts", "census-b.test.ts"];
    const files = Object.fromEntries(
      names.map((name) => [name, `${passingTest}\n${swallowedLaunch}`]),
    );
    const census = join(fixtureDir, "census.tsv");
    const allowList = join(fixtureDir, "allowlist.txt");
    writeFileSync(
      allowList,
      names.map((name) => join(fixtureDir, name).slice(root.length)).join("\n"),
    );
    for (const isolate of [false, true]) {
      writeFileSync(census, "");
      const censusResult = runFiles(files, {
        isolate,
        env: {
          AUTOMOBILE_SPAWN_GUARD_CENSUS_FILE: census,
          AUTOMOBILE_SPAWN_GUARD_ALLOWLIST: allowList,
        },
      });
      expect(censusResult.exitCode).toBe(0);
      const rows = readFileSync(census, "utf8").trim().split("\n");
      expect(rows).toHaveLength(2);
      for (const name of names) {
        expect(
          rows.some((row) => row.startsWith(join(fixtureDir, name).slice(root.length) + "\tadb\t")),
        ).toBe(true);
      }
    }
    // A fake executable named adb proves exact pass-through without touching a device.
    const fakeTool = join(fixtureDir, "adb");
    writeFileSync(fakeTool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const allowed = runFiles(files, {
      env: {
        AUTOMOBILE_SPAWN_GUARD_ALLOWLIST: allowList,
        PATH: `${fixtureDir}:${process.env.PATH ?? ""}`,
      },
    });
    expect(allowed.exitCode).toBe(0);
  },
);

guardedTest("later suite teardown is reported once after an earlier clean drain", () => {
  const result = runFiles({
    "late-suites.test.ts": `import { describe, afterAll, expect, test } from "bun:test";
      describe("earlier", () => {
        test("offender", () => { ${swallowedLaunch} });
      });
      describe("later", () => {
        test("clean", () => expect(true).toBe(true));
        afterAll(() => { ${swallowedLaunch} });
      });
      describe("last", () => {
        test("also clean", () => expect(true).toBe(true));
        afterAll(() => { ${swallowedLaunch} });
      });`,
    "after-late.test.ts": passingTest,
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("3 pass");
  expect(output).toContain("2 fail");
  expect(output).not.toContain("(fail) later > clean");
  expect(output).not.toContain("(fail) last > also clean");
});

guardedTest(
  "async launches without test frames fail once per file instead of every subsequent test",
  () => {
    const result = runFiles({
      "untracked-helper.ts": `export function launch(): Promise<void> {
      return new Promise((resolve) => queueMicrotask(() => {
        ${swallowedLaunch}
        resolve();
      }));
    }`,
      "untracked.test.ts": `import { test, expect } from "bun:test";
      import { launch } from "./untracked-helper";
      test("first launch", async () => await launch());
      test("second launch", async () => await launch());
      test("clean", () => expect(true).toBe(true));`,
      "after-untracked.test.ts": passingTest,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("3 pass");
    expect(output).toContain("1 fail");
    expect(output).toContain("untracked.test.ts: adb devices");
    expect(output).not.toContain("(fail) second launch");
  },
);
