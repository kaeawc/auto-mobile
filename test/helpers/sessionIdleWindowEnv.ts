import { afterAll, beforeAll } from "bun:test";
import { SESSION_IDLE_TIMEOUT_ENV } from "../../src/daemon/sessionLivenessWindows";

/**
 * The device-restart recovery window (three minutes) is capped by the session's idle deadline,
 * which now defaults to two minutes. Suites that exercise the restart window's own arithmetic
 * give their sessions an idle window longer than it, so the cap does not mask what they test.
 */
export const RESTART_WINDOW_SUITE_IDLE_MS = 30 * 60_000;

/** Run every SessionManager the calling suite constructs with `idleMs` as its idle window. */
export function useSessionIdleWindowForSuite(idleMs: number = RESTART_WINDOW_SUITE_IDLE_MS): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[SESSION_IDLE_TIMEOUT_ENV];
    process.env[SESSION_IDLE_TIMEOUT_ENV] = String(idleMs);
  });
  afterAll(() => {
    if (saved === undefined) {
      delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    } else {
      process.env[SESSION_IDLE_TIMEOUT_ENV] = saved;
    }
  });
}
