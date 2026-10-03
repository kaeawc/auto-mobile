import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  releaseSessionAndDevice,
  type SessionReleaseManager,
  type SessionReleasePool,
} from "../../src/daemon/releaseSessionAndDevice";
import { logger } from "../../src/utils/logger";

class FakeReleaseManager implements SessionReleaseManager {
  session: object | null = {};
  failure: unknown;
  removeOnRelease = true;
  calls: Array<[string, string | undefined]> = [];
  getSession(): object | null {
    return this.session;
  }
  async releaseSession(id: string, reason?: string): Promise<string | null> {
    this.calls.push([id, reason]);
    if (this.removeOnRelease) {
      this.session = null;
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return "device";
  }
}

class FakeReleasePool implements SessionReleasePool {
  calls: Array<[string, string]> = [];
  failure: unknown;
  constructor(private manager: FakeReleaseManager) {}
  async releaseDevice(deviceId: string, sessionId: string): Promise<void> {
    expect(this.manager.session).toBeNull();
    this.calls.push([deviceId, sessionId]);
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }
}

describe("releaseSessionAndDevice", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());
  afterAll(() => warn.mockRestore());
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
