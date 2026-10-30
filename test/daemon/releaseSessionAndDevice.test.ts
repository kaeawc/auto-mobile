import { afterEach, describe, expect, spyOn, test, mock, beforeEach } from "bun:test";
import {
  lazySessionReleasePool,
  releasePoolDevice,
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

describe("releasePoolDevice", () => {
  test("forwards arguments and returns the pool's promise unchanged", async () => {
    const promise = Promise.resolve();
    const calls: Array<[string, string]> = [];
    const pool: SessionReleasePool = {
      releaseDevice: (...args) => {
        calls.push(args);
        return promise;
      },
    };
    expect(releasePoolDevice(pool, "device", "session")).toBe(promise);
    expect(calls).toEqual([["device", "session"]]);
    await promise;
  });

  test("propagates the pool's rejection unchanged", async () => {
    const failure = new Error("pool failed");
    const pool: SessionReleasePool = {
      releaseDevice: () => Promise.reject(failure),
    };
    await expect(releasePoolDevice(pool, "device", "session")).rejects.toBe(failure);
  });
});

describe("lazySessionReleasePool", () => {
  test("resolves late and per call, looks up patched methods, and preserves promise identity", async () => {
    let pool!: SessionReleasePool;
    let resolutions = 0;
    const lazy = lazySessionReleasePool(() => {
      resolutions++;
      return pool;
    });
    expect(resolutions).toBe(0);
    const calls: unknown[][] = [];
    const first = Promise.resolve();
    const patched = Promise.resolve();
    const replacement = Promise.resolve();
    pool = {
      releaseDevice(...args) {
        expect(this).toBe(pool);
        calls.push(["initial", ...args]);
        return first;
      },
    };
    expect(lazy.releaseDevice("d1", "s1")).toBe(first);
    expect(resolutions).toBe(1);
    pool.releaseDevice = function (...args) {
      expect(this).toBe(pool);
      calls.push(["patched", ...args]);
      return patched;
    };
    expect(lazy.releaseDevice("d2", "s2")).toBe(patched);
    expect(resolutions).toBe(2);
    pool = {
      releaseDevice(...args) {
        expect(this).toBe(pool);
        calls.push(["replacement", ...args]);
        return replacement;
      },
    };
    expect(lazy.releaseDevice("d3", "s3")).toBe(replacement);
    expect(resolutions).toBe(3);
    expect(calls).toEqual([
      ["initial", "d1", "s1"],
      ["patched", "d2", "s2"],
      ["replacement", "d3", "s3"],
    ]);
    await Promise.all([first, patched, replacement]);
  });
});

describe("releaseSessionAndDevice", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());
  test.each([
    ["explicit-release", true, "Failed to persist terminal release"],
    ["device-restart:Pixel_8", false, "Failed to persist non-terminal release"],
  ] as const)("real manager persistence failure: %s", async (reason, stillPresent, message) => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = new SessionManager(new FakeTimer(), persistence, {
      barrier: () => new FakeDbWriteBarrier(),
    });
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
      const result = releaseSessionAndDevice(manager, pool, "device", "session", {
        reason,
      });
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
        releaseSessionAndDevice(manager, pool, "device", "session", {
          reason: "superseded",
        }),
      ).rejects.toBe(failure);
      expect(manager.calls).toEqual([["session", "superseded"]]);
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

  test("a retrying caller defers only failure fallback and preserves the error identity", async () => {
    const manager = new FakeReleaseManager();
    const pool = new FakeReleasePool(manager);
    manager.failure = new Error("persistence failed");
    await expect(
      releaseSessionAndDevice(manager, pool, "device", "session", {
        reason: "superseded",
        deferFailureFallback: true,
      }),
    ).rejects.toBe(manager.failure);
    expect(manager.hasSession()).toBe(false);
    expect(pool.calls).toEqual([]);
    manager.failure = undefined;
    await releaseSessionAndDevice(manager, pool, "device", "session", {
      reason: "superseded",
      deferFailureFallback: true,
    });
    expect(pool.calls).toEqual([["device", "session"]]);
  });

  test("successful release preserves ordering and the supplied reason", async () => {
    const manager = new FakeReleaseManager();
    const pool = new FakeReleasePool(manager);
    await releaseSessionAndDevice(manager, pool, "device", "session", {
      reason: "plan-auto-release",
    });
    expect(manager.calls).toEqual([["session", "plan-auto-release"]]);
    expect(pool.calls).toEqual([["device", "session"]]);
  });

  test("a conditional release returning no device retains ownership", async () => {
    const manager = new FakeReleaseManager();
    const pool = new FakeReleasePool(manager);
    await releaseSessionAndDevice(manager, pool, "device", "session", {
      reason: "superseded",
      release: async () => null,
    });
    expect(manager.hasSession()).toBe(true);
    expect(manager.calls).toEqual([]);
    expect(pool.calls).toEqual([]);
  });

  test("a custom release uses its returned device even without a known failure fallback", async () => {
    const manager = new FakeReleaseManager();
    const pool = new FakeReleasePool(manager);
    await releaseSessionAndDevice(manager, pool, null, "session", {
      reason: "superseded",
      release: () => manager.releaseSession("session", "superseded"),
    });
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

afterEach(() => {
  mock.restore();
});
