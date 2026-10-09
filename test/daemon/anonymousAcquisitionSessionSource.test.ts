import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS_ACQUISITION_SESSION_SOURCE,
  isAnonymousAcquisitionSession,
  SessionManager,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * An anonymous acquisition's session may be reused by another anonymous acquisition of its device
 * (#2421); any other session may not (#11071). The creator kind is persisted, so a daemon restart
 * does not flip which sessions an anonymous `--cli` startDevice may reuse.
 */
describe("anonymous-acquisition creator kind (#11071)", () => {
  async function restartWith(source: string | undefined) {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    const persistence = new FakeDeviceSessionPersistence();
    const first = new SessionManager(timer, persistence);
    first.stopCleanupTimer();
    const created = await first.createSession(
      "cli-session",
      "emulator-5554",
      "android",
      undefined,
      undefined,
      "Pixel_8_API_35",
      undefined,
      undefined,
      source,
    );
    const createdIsAnonymous = isAnonymousAcquisitionSession(created);
    const persistedSource = (await persistence.getSession?.("cli-session"))?.source;
    await persistence.markReleased("cli-session", "expired", 1_000, "daemon-restart");

    // The restarted daemon rebinds the row without knowing who created it.
    const restarted = new SessionManager(timer, persistence);
    restarted.stopCleanupTimer();
    const pool: SessionDeviceAssigner = {
      async assignDeviceToSession(id, _platform, target): Promise<string> {
        const session = await restarted.createSession(
          id,
          "emulator-5554",
          "android",
          target?.liveness?.sessionTimeoutMs,
          target?.liveness?.heartbeatTimeoutMs,
          target?.stableDeviceId,
          target?.liveness,
          target?.initialOwnership,
        );
        return session.assignedDevice;
      },
    };
    await restarted.rehydratePersistedSessions(pool);
    const rehydrated = restarted.getSession("cli-session");
    return { createdIsAnonymous, persistedSource, rehydrated };
  }

  test("an anonymous acquisition's session stays anonymous across a daemon restart", async () => {
    const result = await restartWith(ANONYMOUS_ACQUISITION_SESSION_SOURCE);

    expect(result.createdIsAnonymous).toBe(true);
    expect(result.persistedSource).toBe(ANONYMOUS_ACQUISITION_SESSION_SOURCE);
    expect(result.rehydrated).not.toBeNull();
    expect(isAnonymousAcquisitionSession(result.rehydrated!)).toBe(true);
  });

  test("any other session stays non-anonymous across a daemon restart", async () => {
    const result = await restartWith(undefined);

    expect(result.createdIsAnonymous).toBe(false);
    expect(result.persistedSource).toBe("session-manager");
    expect(result.rehydrated).not.toBeNull();
    expect(isAnonymousAcquisitionSession(result.rehydrated!)).toBe(false);
  });
});
