import { expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

test.each([false, true])("local CLI keeper refuses proxy ownership (claim=%s)", async (claim) => {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const unexpected = (): never => {
    throw new Error("Unexpected daemon operation");
  };
  const state: DaemonStateLike = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: unexpected,
    getDeviceSessionRegistry: unexpected,
  };
  class LocalManager extends SafeDaemonManager {
    override getDaemonState() {
      return state;
    }
  }
  const session = await manager.createSession("proxy-session", "emulator-5554", "android");
  await manager.claimLivenessOwnership(session.sessionId, "proxy-token");
  manager.recordHeartbeat(session.sessionId);
  const before = { ...session };
  timer.advanceTime(1_000);
  const output: string[] = [];
  const error = spyOn(console, "error").mockImplementation((message) => output.push(message));
  const stdout: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message) => stdout.push(message));
  const exited = new Error("fake exit");
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    expect(code).toBe(1);
    throw exited;
  });
  try {
    await expect(
      runDaemonCommand(
        "heartbeat",
        [
          session.sessionId,
          "--liveness-owner-token",
          "keeper",
          ...(claim ? ["--claim-liveness-ownership"] : []),
        ],
        {},
        LocalManager,
      ),
    ).rejects.toBe(exited);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("[liveness_owner_is_proxy]");
    expect(stdout).toEqual([]);
    expect(session).toMatchObject(before);
  } finally {
    error.mockRestore();
    log.mockRestore();
    exit.mockRestore();
    manager.stopCleanupTimer();
  }
});
