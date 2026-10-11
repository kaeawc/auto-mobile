import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
  getCliSessionIdleTimeoutMs,
} from "../../../src/daemon/constants";

const KEYS = ["AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS", "AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS"];
const saved = KEYS.map((key) => [key, process.env[key]] as const);

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// The one-shot CLI sends this value with every session declaration, and the daemon applies it as
// the session's idle window. `Number.parseInt` accepts a numeric prefix, so a unit suffix turns
// minutes into milliseconds and every CLI session idle-releases at the next scan.
describe("AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS parsing", () => {
  test.each([["2m"], ["120s"], ["5min"], ["1e5"]])(
    "%j is not a plain millisecond count and falls back to the default",
    (value) => {
      for (const key of KEYS) {
        delete process.env[key];
      }
      process.env.AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS = value;
      expect(getCliSessionIdleTimeoutMs()).toBe(DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS);
    },
  );
});
