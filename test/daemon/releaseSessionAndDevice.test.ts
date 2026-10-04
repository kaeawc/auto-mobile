import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  releaseSessionAndDevice,
  type SessionReleaseManager,
  type SessionReleasePool,
} from "../../src/daemon/releaseSessionAndDevice";
import { logger } from "../../src/utils/logger";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";

class FakeReleaseManager implements SessionReleaseManager {
  session: object | null = {};
  failure: unknown;
  removeOnRelease = true;
  terminalFence = false;
  calls: Array<[string, string | undefined]> = [];
  getSession(): object | null {
    return this.terminalFence ? null : this.session;
  }
  hasSession(): boolean {
    return this.session !== null;
  }
  async releaseSession(id: string, reason?: string): Promise<string | null> {
    this.calls.push([id, reason]);
    if (this.removeOnRelease) {
      this.session = null;
    }
    if (this.failure !== undefined) {
      this.terminalFence = true;
      throw this.failure;
    }
    return "device";
  }
}

class FakeReleasePool implements SessionReleasePool {
  calls: Array<[string, string]> = [];
  failure: unknown;
  constructor(private manager: Pick<SessionManager, "hasSession">) {}
  async releaseDevice(deviceId: string, sessionId: string): Promise<void> {
    this.calls.push([deviceId, sessionId]);
    expect(this.manager.hasSession(sessionId)).toBe(false);
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }
}

describe("releaseSessionAndDevice", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());
  afterAll(() => warn.mockRestore());
  test.each([
    ["explicit-release", true, "Failed to persist terminal release"],
    ["device-restart:Pixel_8", false, "Failed to persist non-terminal release"],
  ] as const)("real manager persistence failure: %s", async (reason, stillPresent, message) => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = new SessionManager(
      new FakeTimer(),
      persistence,
      () => new FakeDbWriteBarrier(),
    );
    const pool = new FakeReleasePool(manager);
    const originalRelease = manager.releaseSession.bind(manager);
    let originalError: unknown;
    const release = spyOn(manager, "releaseSession").mockImplementation(
      async (id, releaseReason) => {
        try {
          return await originalRelease(id, releaseReason);
        } catch (error) {
          originalError = error;
          throw error;
        }
      },
    );
    try {
      await manager.createSession("session", "device", "android");
      persistence.failure = "release";
      const result = releaseSessionAndDevice(manager, pool, "device", "session", reason);
      await expect(result).rejects.toThrow(message);
      await expect(result).rejects.toBe(originalError);
      expect(manager.getSession("session")).toBeNull();
      expect(manager.hasSession("session")).toBe(stillPresent);
      if (stillPresent) {
        expect(manager.getTerminalReleaseSnapshot("session")?.releaseReason).toBe(reason);
      }
      expect(pool.calls).toEqual(stillPresent ? [] : [["device", "session"]]);
    } finally {
      release.mockRestore();
      manager.stopCleanupTimer();
    }
  });
  test.each(["removed", "present", "pool-failure"])(
    "preserves the original release error: %s",
    async (scenario) => {
      const manager = new FakeReleaseManager();
      const pool = new FakeReleasePool(manager);
      const failure = new Error("persistence failed");
      const poolFailure = new Error("pool failed");
      manager.failure = failure;
      manager.removeOnRelease = scenario !== "present";
      if (scenario === "pool-failure") {
        pool.failure = poolFailure;
      }
      await expect(
        releaseSessionAndDevice(manager, pool, "device", "session", "reason"),
      ).rejects.toBe(failure);
      expect(manager.calls).toEqual([["session", "reason"]]);
      expect(manager.getSession()).toBeNull();
      expect(manager.hasSession()).toBe(scenario === "present");
      expect(pool.calls).toEqual(scenario === "present" ? [] : [["device", "session"]]);
      if (scenario === "pool-failure") {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("session"), poolFailure);
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  test("successful release preserves ordering and the supplied reason", async () => {
    const manager = new FakeReleaseManager();
    const pool = new FakeReleasePool(manager);
    await releaseSessionAndDevice(manager, pool, "device", "session", "plan-auto-release");
    expect(manager.calls).toEqual([["session", "plan-auto-release"]]);
    expect(pool.calls).toEqual([["device", "session"]]);
  });

  test("a conditional release returning no device retains ownership", async () => {
    const manager = new FakeReleaseManager();
    const pool = new FakeReleasePool(manager);
    await releaseSessionAndDevice(manager, pool, "device", "session", "reason", async () => null);
    expect(manager.hasSession()).toBe(true);
    expect(manager.calls).toEqual([]);
    expect(pool.calls).toEqual([]);
  });

  test("a custom release uses its returned device even without a known failure fallback", async () => {
    const manager = new FakeReleaseManager();
    const pool = new FakeReleasePool(manager);
    await releaseSessionAndDevice(manager, pool, null, "session", "reason", () =>
      manager.releaseSession("session", "reason"),
    );
    expect(pool.calls).toEqual([["device", "session"]]);
  });

  test("a pool failure after successful release still propagates", async () => {
    const manager = new FakeReleaseManager();
    const pool = new FakeReleasePool(manager);
    pool.failure = new Error("pool failed");
    await expect(releaseSessionAndDevice(manager, pool, "device", "session")).rejects.toBe(
      pool.failure,
    );
    expect(manager.calls).toEqual([["session", undefined]]);
    expect(pool.calls).toEqual([["device", "session"]]);
  });
});
