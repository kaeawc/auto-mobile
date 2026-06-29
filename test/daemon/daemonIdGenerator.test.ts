import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

describe("Daemon UUID source", function() {
  afterEach(() => {
    // Constructing a Daemon initializes the global DaemonState singleton.
    // Reset it so this test does not leak initialized state into other test
    // files (bun shares singleton state across files; execution order varies).
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("routes the daemon session id through the injected IdGenerator", function() {
    const idGenerator = new CountingIdGenerator("daemon-session");
    const daemon = new Daemon(
      {},
      undefined,
      new FakeTimer(),
      new DeviceSessionRepository(),
      idGenerator
    );

    // First id minted during construction (daemonSessionId).
    expect((daemon as unknown as { daemonSessionId: string }).daemonSessionId)
      .toBe("daemon-session-1");
  });
});
