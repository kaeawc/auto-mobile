import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
