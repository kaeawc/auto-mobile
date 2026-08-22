import { afterEach, describe, expect, test } from "bun:test";

const STARTUP_TIMEOUT_ENV = "AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS";
const LEGACY_STARTUP_TIMEOUT_ENV = "AUTO_MOBILE_DAEMON_STARTUP_TIMEOUT_MS";
const MAX_TIMER_DELAY_MS = 2_147_483_647;

describe("daemon startup timeout configuration", () => {
  const originalEnvironment = new Map(
    [STARTUP_TIMEOUT_ENV, LEGACY_STARTUP_TIMEOUT_ENV].map(key => [key, process.env[key]])
  );

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
    return import(`../../src/daemon/constants.ts?startup-timeout=${Date.now()}-${Math.random()}`);
  }

  afterEach(restoreEnvironment);

  test("caps an oversized override at the runtime timer maximum", async () => {
    process.env[STARTUP_TIMEOUT_ENV] = "9223372036854775807";
    delete process.env[LEGACY_STARTUP_TIMEOUT_ENV];

    const constants = await importFreshConstants();

    expect(constants.DAEMON_STARTUP_TIMEOUT_MS).toBe(MAX_TIMER_DELAY_MS);
  });
});
