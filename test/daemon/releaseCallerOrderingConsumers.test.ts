import { describe, expect, spyOn, test } from "bun:test";
import {
  managedExecutionSessionsFrom,
  type ManagedExecutionSessionManager,
} from "../../src/daemon/managedSlots/managedExecutionRelease";
import {
  registerDerivedLabelSessionReleaseCascade,
  type DerivedLabelSessionSource,
} from "../../src/daemon/derivedLabelSessionReleaseCascade";
import type { SessionReleasePool } from "../../src/daemon/releaseSessionAndDevice";
import type {
  SessionReleaseCallback,
  SessionReleaseSnapshot,
  SessionReleaseOptions,
} from "../../src/daemon/sessionManager";
import { logger } from "../../src/utils/logger";

describe("daemon release pool consumers", () => {
  test.each(["success", "session", "pool"] as const)(
    "managed adapter %s orders the session before pool release",
    async (failure) => {
      const events: unknown[][] = [];
      const error = new Error("release failed");
      let live = true;
      const manager: ManagedExecutionSessionManager = {
        hasSession: () => live,
        getSession: () => ({ assignedDevice: "fallback-device" }),
        getReleasingSession: () => null,
        getTerminalReleaseSnapshot: () => undefined,
        forceStuckRelease: () => undefined,
        hasDeviceCleanupInProgress: () => false,
        releaseSession: async (...args) => {
          events.push(["session.releaseSession", ...args]);
          if (failure === "session") throw error;
          live = false;
          return "returned-device";
        },
      };
      const pool: SessionReleasePool = {
        releaseDevice: async (...args) => {
          events.push(["pool.releaseDevice", ...args]);
          if (failure === "pool") throw error;
        },
      };
      const result = managedExecutionSessionsFrom(manager, pool).releaseSession("s1");
      if (failure === "success") expect(await result).toBe("returned-device");
      else await expect(result).rejects.toBe(error);
      expect(events).toEqual([
        ["session.releaseSession", "s1"],
        ...(failure === "session" ? [] : [["pool.releaseDevice", "returned-device", "s1"]]),
      ]);
    },
  );

  test.each(["explicit-release", "daemon-shutdown"])(
    "derived cascade %s orders session and pool calls",
    async (baseReason) => {
      const events: unknown[][] = [];
      let callback!: SessionReleaseCallback;
      const manager: DerivedLabelSessionSource = {
        hasSession: () => false,
        getSession: () => ({ assignedDevice: "d1" }),
        takeDerivedLabelSessions: () => ["base:label"],
        onSessionRelease: (cb) => {
          callback = cb;
        },
        releaseSession: async (...args) => {
          events.push(["session.releaseSession", ...args]);
          return "d1";
        },
      };
      const cascade = registerDerivedLabelSessionReleaseCascade(
        manager,
        {
          releaseDevice: async (...args) => {
            events.push(["pool.releaseDevice", ...args]);
          },
        },
        { cancelDeviceSessionExecutions: async () => 0, cancelDeviceExecutions: async () => 0 },
      );
      callback(
        "base",
        "base-device",
        baseReason,
        {} as SessionReleaseSnapshot,
        {} as SessionReleaseOptions,
      );
      await cascade.settled();
      expect(events).toEqual([
        [
          "session.releaseSession",
          "base:label",
          baseReason === "explicit-release" ? baseReason : "plan-auto-release",
        ],
        ["pool.releaseDevice", "d1", "base:label"],
      ]);
    },
  );

  test.each(["session", "pool"] as const)(
    "derived cascade logs %s failure and settles",
    async (failure) => {
      const events: unknown[][] = [];
      const error = new Error("release failed");
      let callback!: SessionReleaseCallback;
      const manager: DerivedLabelSessionSource = {
        hasSession: () => failure === "session",
        getSession: () => ({ assignedDevice: "d1" }),
        takeDerivedLabelSessions: () => ["base:label"],
        onSessionRelease: (cb) => {
          callback = cb;
        },
        releaseSession: async (...args) => {
          events.push(["session.releaseSession", ...args]);
          if (failure === "session") throw error;
          return "d1";
        },
      };
      const warn = spyOn(logger, "warn").mockImplementation((...args) => {
        events.push(["warn", ...args]);
      });
      try {
        const cascade = registerDerivedLabelSessionReleaseCascade(
          manager,
          {
            releaseDevice: async (...args) => {
              events.push(["pool.releaseDevice", ...args]);
              throw error;
            },
          },
          { cancelDeviceSessionExecutions: async () => 0, cancelDeviceExecutions: async () => 0 },
        );
        callback(
          "base",
          "base-device",
          "explicit-release",
          {} as SessionReleaseSnapshot,
          {} as SessionReleaseOptions,
        );
        await cascade.settled();
        expect(events).toEqual([
          ["session.releaseSession", "base:label", "explicit-release"],
          ...(failure === "pool" ? [["pool.releaseDevice", "d1", "base:label"]] : []),
          [
            "warn",
            "[DeviceLabelMap] Failed to release label session base:label with its base base",
            error,
          ],
        ]);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("lazySessionReleasePool contract resolves a late instance and its patched method on every call", async () => {
    const events: unknown[][] = [];
    let instance!: SessionReleasePool;
    // Phase 1 contract for daemon.ts's closures. Phase 2 replaces this with the helper.
    const port: SessionReleasePool = {
      releaseDevice: (deviceId, sessionId) => instance.releaseDevice(deviceId, sessionId),
    };
    instance = {
      releaseDevice: async (...args) => {
        events.push(["initial", ...args]);
      },
    };
    await port.releaseDevice("d1", "s1");
    instance.releaseDevice = async (...args) => {
      events.push(["patched", ...args]);
    };
    await port.releaseDevice("d2", "s2");
    instance = {
      releaseDevice: async (...args) => {
        events.push(["replacement", ...args]);
      },
    };
    await port.releaseDevice("d3", "s3");
    expect(events).toEqual([
      ["initial", "d1", "s1"],
      ["patched", "d2", "s2"],
      ["replacement", "d3", "s3"],
    ]);
  });
});
