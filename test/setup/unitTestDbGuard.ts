import { UNIT_TEST_DB_GUARD_ENV } from "../../src/db/database";

/**
 * Bun test preload (wired via `bunfig.toml` `[test].preload`) that force-arms the
 * unit-test database guard for the whole suite.
 *
 * As of #3140 the guard arms BY DEFAULT under a bun-test context
 * (`NODE_ENV === "test"`), so this preload is NO LONGER the sole arming path and
 * the guard can no longer silently fail open when the preload is skipped. Setting
 * {@link UNIT_TEST_DB_GUARD_ENV} is retained as a belt-and-suspenders force-arm
 * for the one gap arm-by-default leaves open: bun does NOT override an
 * explicitly-set `NODE_ENV`, so `NODE_ENV=production bun test` slips past the
 * context check and relies on this flag to stay guarded.
 *
 * When armed, `getDatabase()` throws when a test resolves the DEFAULT, real
 * file-backed DB (`~/.auto-mobile/auto-mobile.db`) instead of injecting an
 * in-memory DB via `createTestDatabase` — the durable fix for the real-DB-race
 * flake class (issues #3063 / #3067). Tests that must exercise real file behavior
 * opt out by setting AUTOMOBILE_DB_DIR to a temp dir or AUTOMOBILE_DB_PATH=':memory:'
 * explicitly (see the guard in `src/db/database.ts`).
 *
 * A preload runs once per test process before any test file is imported, so the
 * flag is set before the first lazy `resolveDbPath()`.
 */
process.env[UNIT_TEST_DB_GUARD_ENV] = "1";
