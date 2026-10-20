import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "heartbeat-accepted-log";

describe("accepted heartbeat debug log", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let debug: Mock<typeof logger.debug>;

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    debug = spyOn(logger, "debug").mockImplementation(() => {});
    await manager.createSession(SESSION, "emulator-5554", "android");
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    debug.mockRestore();
  });

  test("logs the age of the previous heartbeat on acceptance", async () => {
    await timer.advanceTimeAsync(2_000);
    const previousHeartbeat = manager.getSession(SESSION)!.lastHeartbeat;
    const expectedAge = Math.max(0, timer.now() - previousHeartbeat);

    await deliverDaemonHeartbeat(manager, SESSION);

    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toContain(
      `Heartbeat accepted for session ${SESSION}; previous heartbeat age=${expectedAge}ms`,
    );
  });

  test("logs 3000ms for the second heartbeat", async () => {
    await deliverDaemonHeartbeat(manager, SESSION);
    debug.mockClear();
    await timer.advanceTimeAsync(3_000);

    await deliverDaemonHeartbeat(manager, SESSION);

    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toContain(
      `Heartbeat accepted for session ${SESSION}; previous heartbeat age=3000ms`,
    );
  });

  test("does not log acceptance for an unknown session", async () => {
    // The daemon answers a heartbeat for an unknown session as not-found, which rejects here.
    await expect(deliverDaemonHeartbeat(manager, "unknown-heartbeat-session")).rejects.toThrow();

    expect(
      debug.mock.calls.some(([message]) => String(message).includes("Heartbeat accepted")),
    ).toBe(false);
  });
});
