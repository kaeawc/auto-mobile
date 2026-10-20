import { describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

async function createManager(): Promise<SessionManager> {
  const timer = new FakeTimer();
  return new SessionManager(timer, new DeviceSessionRepository(await createTestDatabase(), timer));
}

describe("SessionManager daemon collaborator assertion", () => {
  test("fails loudly naming every unattached collaborator", async () => {
    const manager = await createManager();
    expect(() => manager.assertDaemonCollaboratorsAttached()).toThrow(
      /daemonSessionId.*activeSessionExecutionChecker/,
    );
    manager.attachDaemonSessionId("daemon-1");
    expect(() => manager.assertDaemonCollaboratorsAttached()).toThrow(
      /activeSessionExecutionChecker.*deviceAcquisitionExecutionCanceller/,
    );
  });

  test("passes once every collaborator is attached", async () => {
    const manager = await createManager();
    manager.attachDaemonSessionId("daemon-1");
    manager.setActiveSessionExecutionChecker(() => true);
    manager.setSessionExecutionDeadlineLookup(() => undefined);
    manager.setExpiryReleaseExecutionCanceller(() => undefined);
    manager.setDeviceAcquisitionExecutionCanceller(() => undefined);
    expect(() => manager.assertDaemonCollaboratorsAttached()).not.toThrow();
  });
});
