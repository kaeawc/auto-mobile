import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNIT_TEST_DB_GUARD_ENV } from "../../src/db/database";

/**
 * Positive "the arming machinery is intact" tripwire for the real-DB guard
 * (issue #3083, follow-up to #3067 / PR #3082).
 *
 * The guard in `src/db/database.ts` (`assertUnitTestDbAccessAllowed`) only fires
 * when `process.env[UNIT_TEST_DB_GUARD_ENV] === "1"`, and that flag is set solely
 * by the bun test preload `test/setup/unitTestDbGuard.ts` (wired via
 * `bunfig.toml` `[test].preload`). If the preload never runs — a `bun test
 * --config other.toml`, a future CI job that doesn't pick up `bunfig.toml`, or an
 * accidentally-deleted `[test].preload` line — the guard silently disables itself
 * and the suite can report a false green while a real-DB race (the #3063 class)
 * flakes unguarded. The guard "fails open".
 *
 * These two assertions turn that silent failure LOUD:
 *   1. Ambient-env: the preload actually ran in THIS test process. This test does
 *      NOT set the flag itself (that would be vacuous) — it reads the ambient
 *      value, so it goes red if the preload was skipped for ANY reason.
 *   2. Wiring: `bunfig.toml` still lists the preload, so removing the line trips a
 *      targeted failure that names the exact cause.
 */
describe("unit-test DB guard preload is armed (issue #3083)", () => {
  test("the bun test preload ran: UNIT_TEST_DB_GUARD_ENV is set to \"1\" in this process", () => {
    // Read the AMBIENT value — deliberately not set here, so this fails loudly if
    // the preload (test/setup/unitTestDbGuard.ts) did not run for this process.
    expect(process.env[UNIT_TEST_DB_GUARD_ENV]).toBe("1");
  });

  test("bunfig.toml still wires the guard preload via [test].preload", () => {
    // Resolve bunfig.toml relative to this file (repo root is two levels up from
    // test/db/) so the assertion is independent of the runner's cwd.
    const repoRoot = join(import.meta.dir, "..", "..");
    const bunfig = readFileSync(join(repoRoot, "bunfig.toml"), "utf8");

    // The preload path exactly as bun resolves it from bunfig.toml. If this line
    // is removed the guard silently disables — catch it here with a precise cause.
    expect(bunfig).toContain("./test/setup/unitTestDbGuard.ts");
    // And confirm it lives under the [test].preload key, not merely mentioned in a
    // comment somewhere, so the wiring — not just the string — is what's asserted.
    expect(bunfig).toMatch(/preload\s*=\s*\[[^\]]*\.\/test\/setup\/unitTestDbGuard\.ts/);
  });
});
