import { describe, expect, test } from "bun:test";
import { daemonCommandSkipsServerBootstrap } from "../../src/daemon/cli/daemonCommandRouting";

// #11252: read-only and release commands ran the full server bootstrap (tool registration,
// startup maintenance incl. iOS orphan-runner reaping, CtrlProxy/xcodebuild/video prefetch).
describe("daemon command routing around the server bootstrap", () => {
  test.each([
    "status",
    "stop",
    "health",
    "diagnose",
    "heartbeat",
    "available-devices",
    "active-sessions",
    "session-info",
    "release-session",
    "release-liveness-ownership",
    "no-such-command",
  ])("%s returns before the server bootstrap", (command) => {
    expect(daemonCommandSkipsServerBootstrap(command)).toBe(true);
  });

  test.each(["start", "restart", "restart-admitted", "restart-acceptance-session"])(
    "%s keeps the bootstrap that configures the launched daemon",
    (command) => {
      expect(daemonCommandSkipsServerBootstrap(command)).toBe(false);
    },
  );
});
