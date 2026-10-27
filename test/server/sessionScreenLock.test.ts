import { describe, expect, spyOn, test } from "bun:test";
import {
  createSessionScreenLockMutation,
  type SessionScreenLockHost,
} from "../../src/server/sessionScreenLock";
import { ScreenLockRegistry } from "../../src/features/utility/screenLock/ScreenLockRegistry";
import type { ScreenLockState } from "../../src/features/utility/screenLock/ScreenLockTypes";
import { logger } from "../../src/utils/logger";
import { FakeLockSettingsClient } from "../fakes/FakeLockSettingsClient";
import { FakeTimer } from "../fakes/FakeTimer";

interface FakeSession {
  sessionId: string;
  assignedDevice: string;
}

const DEVICE = "emulator-5554";
const SET: ScreenLockState = { supported: true, type: "pin", set: true, restoreOnRelease: true };

/** A session host whose session can be released (or its setup refused) mid-test. */
class FakeScreenLockHost implements SessionScreenLockHost<FakeSession> {
  session: FakeSession | null = { sessionId: "s-1", assignedDevice: DEVICE };
  admitted = true;
  runSetup = true;
  setups = 0;
  pendingCleanups: Array<{ deviceId: string; cleanup: Promise<unknown> }> = [];

  getSession(sessionId: string): FakeSession | null {
    return this.session?.sessionId === sessionId ? this.session : null;
  }

  isAdmittedForAutomation(): boolean {
    return this.admitted;
  }

  async trackSessionSetup(_session: FakeSession, createSetup: () => Promise<void>): Promise<void> {
    this.setups++;
    if (this.runSetup) {
      await createSetup();
    }
  }

  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>): void {
    this.pendingCleanups.push({ deviceId, cleanup });
  }
}

describe("createSessionScreenLockMutation", () => {
  test("a sessionless write gets no owner", async () => {
    const owners: Array<string | undefined> = [];
    const mutation = createSessionScreenLockMutation(undefined, undefined, DEVICE);
    await mutation(async (owner) => {
      owners.push(owner);
      return SET;
    });
    expect(owners).toEqual([undefined]);
  });

  test("a session write is tracked as setup and owned by the session", async () => {
    const host = new FakeScreenLockHost();
    const owners: Array<string | undefined> = [];
    const result = await createSessionScreenLockMutation(
      host,
      "s-1",
      DEVICE,
    )(async (owner) => {
      owners.push(owner);
      return SET;
    });
    expect(result).toBe(SET);
    expect(owners).toEqual(["s-1"]);
    expect(host.setups).toBe(1);
  });

  test("a released or rebound session is refused before anything changes", async () => {
    const host = new FakeScreenLockHost();
    host.admitted = false;
    let ran = false;
    const write = async () => {
      ran = true;
      return SET;
    };
    await expect(createSessionScreenLockMutation(host, "s-1", DEVICE)(write)).rejects.toThrow(
      "Cannot change the screen lock",
    );
    host.admitted = true;
    await expect(
      createSessionScreenLockMutation(host, "s-1", "other-device")(write),
    ).rejects.toThrow("Cannot change the screen lock");
    host.runSetup = false;
    await expect(createSessionScreenLockMutation(host, "s-1", DEVICE)(write)).rejects.toThrow(
      "nothing was changed",
    );
    expect(ran).toBe(false);
  });

  test("a set that lands after the session ended is cleared at once", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const host = new FakeScreenLockHost();
      const registry = new ScreenLockRegistry();
      const client = new FakeLockSettingsClient({ type: "pin", credential: "1357" });
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const mutation = createSessionScreenLockMutation(host, "s-1", DEVICE, {
        registry,
        timer,
        clientFactory: () => client,
        forgetRememberedUnlock: async () => {},
      });

      const result = await mutation(async (owner) => {
        registry.record({
          deviceId: DEVICE,
          sessionId: owner ?? "s-1",
          type: "pin",
          credential: "1357",
        });
        host.session = null; // Released while the write ran; its cleanup found nothing yet.
        return SET;
      });
      await Promise.all(host.pendingCleanups.map(({ cleanup }) => cleanup));

      expect(result).toMatchObject({ set: true, restoreOnRelease: false });
      expect(client.lock).toBeNull();
      expect(registry.get(DEVICE)).toBeUndefined();
      expect(await registry.restoreReport("s-1")).toMatchObject({ status: "cleared" });
    } finally {
      warn.mockRestore();
    }
  });
});
