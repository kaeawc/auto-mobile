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

  test("caps an override at or above the startup timeout with headroom below the deadline", async () => {
    process.env[STARTUP_TIMEOUT_ENV] = "30000";
    process.env[REACHABILITY_ENV] = "999999";
    delete process.env[LEGACY_REACHABILITY_ENV];

    const constants = await importFreshConstants();

    // Two-thirds of the 30s startup timeout: never equal to the timeout, so the
    // actionable error is produced with headroom before the client's request
    // deadline rather than at it (issue #5871).
    expect(constants.DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS).toBe(20000);
    expect(constants.DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS).toBeLessThan(
      constants.DAEMON_STARTUP_TIMEOUT_MS,
    );
  });

  test("keeps headroom below a lowered startup timeout", async () => {
    process.env[STARTUP_TIMEOUT_ENV] = "6000";
    process.env[REACHABILITY_ENV] = "10000";
    delete process.env[LEGACY_REACHABILITY_ENV];

    const constants = await importFreshConstants();

    // The default 10s candidate exceeds the lowered startup budget, so it is
    // capped to two-thirds of it (4000ms), preserving headroom.
    expect(constants.DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS).toBe(4000);
    expect(constants.DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS).toBeLessThan(
      constants.DAEMON_STARTUP_TIMEOUT_MS,
    );
  });
});
