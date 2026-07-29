import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";

// Issue #4610: the daemon registers a release callback (next to the nav-graph /
// observe-cache cleanup) that fans the released session key out to the
// SessionReleaseBroadcaster, so a connected proxy learns of a real release
// instead of guessing with the replay TTL.

describe("Daemon session-release signal wiring", () => {
  afterEach(() => {
    SessionReleaseBroadcaster.clearForTesting();
    // Constructing a Daemon initializes the global DaemonState singleton; reset
    // it so this file does not leak initialized state into other suites.
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("emits the released session key to the broadcaster on releaseSession", async () => {
    const daemon = new Daemon({});
    const sessionManager = daemon.getSessionManager();

    const emitted: string[] = [];
    const unsubscribe = SessionReleaseBroadcaster.subscribe(sessionId => {
      emitted.push(sessionId);
    });

    try {
      await sessionManager.createSession("session-release-signal", "emulator-5554", "android");
      await sessionManager.releaseSession("session-release-signal");

      expect(emitted).toEqual(["session-release-signal"]);
    } finally {
      unsubscribe();
      sessionManager.stopCleanupTimer();
    }
  });
});
