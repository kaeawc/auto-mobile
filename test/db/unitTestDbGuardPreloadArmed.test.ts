import { describe, expect, test } from "bun:test";
// Structural import: Bun parses bunfig.toml, so `bunfigConfig.test.preload` is the
// actual parsed array — immune to comments, quote style, and whitespace/multi-line
// reformats that a raw text/regex match would mishandle (a commented-out preload
// entry is simply absent from the array rather than falsely matching).
import bunfigConfig from "../../bunfig.toml";
import { UNIT_TEST_DB_GUARD_ENV } from "../../src/db/database";

const bunfigPreload: string[] = (bunfigConfig as { test?: { preload?: string[] } }).test?.preload ?? [];

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
    // This assumes no sibling test clobbers this key without restoring it; today
    // test/db/unitTestDbGuard.test.ts is the only mutator and it restores the whole
    // tracked-env set in afterEach, so the ambient read is a faithful "preload ran"
    // signal. Any future test that mutates AUTOMOBILE_UNIT_TEST_DB_GUARD MUST keep
    // that invariant, or it would mis-blame the preload here.
    expect(process.env[UNIT_TEST_DB_GUARD_ENV]).toBe("1");
  });

  test("bunfig.toml still wires the guard preload via [test].preload", () => {
    // Structural check against the parsed [test].preload array (see the import
    // note above): a removed OR commented-out entry is simply absent from the
    // array, so this fails loudly with a precise cause. `endsWith` tolerates a
    // future formatter dropping the leading `./` (bun resolves either form) while
    // still pinning the exact preload module.
    expect(
      bunfigPreload.some(entry => entry.endsWith("test/setup/unitTestDbGuard.ts"))
    ).toBe(true);
  });
});
