import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getDevicePoolTimeoutMs,
  isAndroidRebootOnDeathEnabled,
  isDevicePoolAutolockEnabled,
} from "../../src/daemon/poolConfig";

const ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
  "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
  "AUTOMOBILE_ANDROID_REBOOT_ON_DEATH",
  "AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH",
] as const;
const ORIGINAL_ENV = new Map<(typeof ENV_KEYS)[number], string | undefined>(
  ENV_KEYS.map(key => [key, process.env[key]])
);

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

describe("poolConfig autolock", () => {
  beforeEach(clearEnv);
  afterEach(restoreEnv);

  it("isDevicePoolAutolockEnabled defaults to false", () => {
    expect(isDevicePoolAutolockEnabled()).toBe(false);
  });

  it("isDevicePoolAutolockEnabled is true only for '1'", () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    expect(isDevicePoolAutolockEnabled()).toBe(true);

    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "true";
    expect(isDevicePoolAutolockEnabled()).toBe(false);

    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "0";
    expect(isDevicePoolAutolockEnabled()).toBe(false);
  });

  it("isDevicePoolAutolockEnabled honors the AUTO_MOBILE_ alias", () => {
    process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK = "1";
    expect(isDevicePoolAutolockEnabled()).toBe(true);
  });

  it("getDevicePoolTimeoutMs defaults to 60 seconds", () => {
    expect(getDevicePoolTimeoutMs()).toBe(60_000);
  });

  it("getDevicePoolTimeoutMs converts seconds to milliseconds", () => {
    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "120";
    expect(getDevicePoolTimeoutMs()).toBe(120_000);
  });

  it("getDevicePoolTimeoutMs ignores invalid or non-positive values", () => {
    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "not-a-number";
    expect(getDevicePoolTimeoutMs()).toBe(60_000);

    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "0";
    expect(getDevicePoolTimeoutMs()).toBe(60_000);

    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "-5";
    expect(getDevicePoolTimeoutMs()).toBe(60_000);
  });

  // Boundary rows for the base-10 integer parse (PARAM-4). getDevicePoolTimeoutMs
  // uses Number.parseInt(override, 10), which reads a leading integer and stops at
  // the first non-digit — so "1e10" is 1 (not 1e10), " 1 " is 1, and "1.9" is 1.
  const timeoutBoundaryRows: Array<{ value: string; expected: number }> = [
    { value: "1e10", expected: 1_000 },
    { value: " 1 ", expected: 1_000 },
    { value: "1.9", expected: 1_000 },
    { value: "30abc", expected: 30_000 },
    { value: "030", expected: 30_000 },
  ];

  for (const row of timeoutBoundaryRows) {
    it(`getDevicePoolTimeoutMs parses ${JSON.stringify(row.value)} as a leading base-10 integer`, () => {
      process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = row.value;
      expect(getDevicePoolTimeoutMs()).toBe(row.expected);
    });
  }
});

describe("Android reboot-on-death configuration", () => {
  beforeEach(clearEnv);
  afterEach(restoreEnv);

  it("defaults to disabled and accepts only '1'", () => {
    expect(isAndroidRebootOnDeathEnabled()).toBe(false);
    process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "true";
    expect(isAndroidRebootOnDeathEnabled()).toBe(false);
    process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
    expect(isAndroidRebootOnDeathEnabled()).toBe(true);
  });

  it("honors the AUTO_MOBILE_ alias", () => {
    process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH = "1";
    expect(isAndroidRebootOnDeathEnabled()).toBe(true);
  });
});

/**
 * `DEVICE_POOL_MATCHING` (poolConfig.ts) is a module-level constant resolved from
 * the env var at import time, so each row imports the module fresh. The override
 * is a case-sensitive membership check against LATEST/RANDOM/MINIMUM with no trim;
 * anything else falls back to LATEST.
 */
describe("DEVICE_POOL_MATCHING env parsing", () => {
  const MATCHING_KEYS = [
    "AUTOMOBILE_DEVICE_POOL_MATCHING",
    "AUTO_MOBILE_DEVICE_POOL_MATCHING",
  ] as const;

  // Snapshot the process's inherited values ONCE, before any row mutates them, and
  // restore to that snapshot after each test. Bun shares process.env across test
  // files, so deleting a key the caller set would leak the wrong DEVICE_POOL_MATCHING
  // into a later import of poolConfig — restore, don't blanket-delete.
  const ORIGINAL_MATCHING_ENV = new Map<(typeof MATCHING_KEYS)[number], string | undefined>(
    MATCHING_KEYS.map(key => [key, process.env[key]])
  );

  // Establish a clean baseline at the START of each row so "unset" rows are
  // deterministic even when the process inherited one of these vars.
  function clearMatchingEnv(): void {
    for (const key of MATCHING_KEYS) {
      delete process.env[key];
    }
  }

  function restoreMatchingEnv(): void {
    for (const key of MATCHING_KEYS) {
      const original = ORIGINAL_MATCHING_ENV.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }

  afterEach(restoreMatchingEnv);

  async function importFreshMatching(): Promise<string> {
    const mod = await import(`../../src/daemon/poolConfig.ts?matching-env=${Date.now()}-${Math.random()}`);
    return mod.DEVICE_POOL_MATCHING as string;
  }

  const rows: Array<{ name: string; key?: (typeof MATCHING_KEYS)[number]; value?: string; expected: string }> = [
    { name: "unset defaults to LATEST", value: undefined, expected: "LATEST" },
    { name: "LATEST is honored", key: MATCHING_KEYS[0], value: "LATEST", expected: "LATEST" },
    { name: "RANDOM is honored", key: MATCHING_KEYS[0], value: "RANDOM", expected: "RANDOM" },
    { name: "MINIMUM is honored", key: MATCHING_KEYS[0], value: "MINIMUM", expected: "MINIMUM" },
    { name: "lowercase 'random' is rejected (case-sensitive) and falls back", key: MATCHING_KEYS[0], value: "random", expected: "LATEST" },
    { name: "a padded ' RANDOM ' is rejected (no trim) and falls back", key: MATCHING_KEYS[0], value: " RANDOM ", expected: "LATEST" },
    { name: "an empty string falls back", key: MATCHING_KEYS[0], value: "", expected: "LATEST" },
    { name: "an unknown strategy falls back", key: MATCHING_KEYS[0], value: "NEWEST", expected: "LATEST" },
    { name: "the AUTO_MOBILE_ alias is honored", key: MATCHING_KEYS[1], value: "MINIMUM", expected: "MINIMUM" },
  ];

  for (const row of rows) {
    it(`${row.name}`, async () => {
      clearMatchingEnv();
      if (row.key && row.value !== undefined) {
        process.env[row.key] = row.value;
      }
      expect(await importFreshMatching()).toBe(row.expected);
    });
  }
});
