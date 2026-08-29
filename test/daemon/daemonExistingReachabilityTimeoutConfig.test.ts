import { afterEach, describe, expect, test } from "bun:test";

const REACHABILITY_ENV = "AUTOMOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS";
const LEGACY_REACHABILITY_ENV = "AUTO_MOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS";
const STARTUP_TIMEOUT_ENV = "AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS";

describe("daemon existing-daemon reachability timeout configuration", () => {
  const trackedKeys = [REACHABILITY_ENV, LEGACY_REACHABILITY_ENV, STARTUP_TIMEOUT_ENV];
  const originalEnvironment = new Map(trackedKeys.map((key) => [key, process.env[key]]));

  function restoreEnvironment(): void {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  async function importFreshConstants() {
    return import(`../../src/daemon/constants.ts?reachability=${Date.now()}-${Math.random()}`);
  }

  afterEach(restoreEnvironment);

  test("defaults to 10s and stays well under the client startup/request timeout", async () => {
    for (const key of trackedKeys) {
      delete process.env[key];
    }

    const constants = await importFreshConstants();

    expect(constants.DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS).toBe(10000);
    // The whole point of #5871: the wait must finish before the client's 30s
    // request timeout so the actionable error is deliverable.
    expect(constants.DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS).toBeLessThan(
      constants.DAEMON_STARTUP_TIMEOUT_MS,
    );
  });

  test("honors a positive override", async () => {
    process.env[REACHABILITY_ENV] = "5000";
    delete process.env[LEGACY_REACHABILITY_ENV];

    const constants = await importFreshConstants();

    expect(constants.DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS).toBe(5000);
  });

  test("clamps an override at or above the startup timeout back to the startup timeout", async () => {
    process.env[STARTUP_TIMEOUT_ENV] = "20000";
    process.env[REACHABILITY_ENV] = "999999";
    delete process.env[LEGACY_REACHABILITY_ENV];

    const constants = await importFreshConstants();

    expect(constants.DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS).toBe(20000);
    expect(constants.DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS).toBeLessThanOrEqual(
      constants.DAEMON_STARTUP_TIMEOUT_MS,
    );
  });
});
