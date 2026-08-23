import { afterEach, describe, expect, test } from "bun:test";

/**
 * `DAEMON_HANDSHAKE_ENABLED` (constants.ts) is a module-level constant derived
 * from the escape-hatch env var at import time, so each row imports the module
 * fresh with a cache-busting query. The disable override reads
 * `AUTOMOBILE_DAEMON_DISABLE_HANDSHAKE` / `AUTO_MOBILE_DAEMON_DISABLE_HANDSHAKE`
 * (issue #2744) — trimmed, lowercased, and true only for 1 / true / yes.
 */
describe("DAEMON_HANDSHAKE_ENABLED env parsing", () => {
  const KEYS = [
    "AUTOMOBILE_DAEMON_DISABLE_HANDSHAKE",
    "AUTO_MOBILE_DAEMON_DISABLE_HANDSHAKE",
  ] as const;

  // Snapshot the process's inherited values ONCE, before any row mutates them, and
  // restore to that snapshot after each test. Bun shares process.env across test
  // files, so deleting a key the caller set would leak the wrong handshake state
  // into later modules — restore, don't blanket-delete.
  const ORIGINAL_ENV = new Map<(typeof KEYS)[number], string | undefined>(
    KEYS.map((key) => [key, process.env[key]]),
  );

  // Establish a clean baseline at the START of each row so "unset" rows are
  // deterministic even when the process inherited one of these vars.
  function clearEnv(): void {
    for (const key of KEYS) {
      delete process.env[key];
    }
  }

  function restoreEnv(): void {
    for (const key of KEYS) {
      const original = ORIGINAL_ENV.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }

  afterEach(restoreEnv);

  async function importFreshEnabled(): Promise<boolean> {
    const mod = await import(
      `../../src/daemon/constants.ts?handshake-env=${Date.now()}-${Math.random()}`
    );
    return mod.DAEMON_HANDSHAKE_ENABLED as boolean;
  }

  // Table rows are the spec. `enabled` is the resulting DAEMON_HANDSHAKE_ENABLED
  // for the primary env var set to `value` (undefined = var unset).
  const rows: Array<{
    name: string;
    key: (typeof KEYS)[number];
    value?: string;
    enabled: boolean;
  }> = [
    { name: "unset defaults to enabled", key: KEYS[0], value: undefined, enabled: true },
    { name: "empty string leaves it enabled", key: KEYS[0], value: "", enabled: true },
    { name: "'1' disables it", key: KEYS[0], value: "1", enabled: false },
    { name: "'true' disables it", key: KEYS[0], value: "true", enabled: false },
    { name: "'yes' disables it", key: KEYS[0], value: "yes", enabled: false },
    { name: "'TRUE' is lowercased then disables it", key: KEYS[0], value: "TRUE", enabled: false },
    { name: "' 1 ' is trimmed then disables it", key: KEYS[0], value: " 1 ", enabled: false },
    { name: "'0' leaves it enabled", key: KEYS[0], value: "0", enabled: true },
    { name: "'no' leaves it enabled", key: KEYS[0], value: "no", enabled: true },
    {
      name: "an unrecognized value leaves it enabled",
      key: KEYS[0],
      value: "maybe",
      enabled: true,
    },
    { name: "the AUTO_MOBILE_ alias also disables it", key: KEYS[1], value: "1", enabled: false },
  ];

  for (const row of rows) {
    test(`${row.name}`, async () => {
      clearEnv();
      if (row.value !== undefined) {
        process.env[row.key] = row.value;
      }
      expect(await importFreshEnabled()).toBe(row.enabled);
    });
  }
});
