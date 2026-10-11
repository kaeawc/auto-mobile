import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  registerDerivedLabelSessionReleaseCascade,
  type DerivedLabelSessionReleaseCascade,
} from "../../src/daemon/derivedLabelSessionReleaseCascade";
import { PLAN_AUTO_RELEASE_REASON, SessionManager } from "../../src/daemon/sessionManager";
import { sessionReleaseThatCancelledCall } from "../../src/daemon/sessionReleasedDuringCall";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

// #11091: releasing a base session releases its derived `${base}:${label}` sessions and frees
// their devices, whatever released the base.
describe("derived label sessions are released with their base (#11091)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let freed: Array<[string, string]>;
  let releases: Array<[string, string]>;
  let cascade: DerivedLabelSessionReleaseCascade;
  let tracker: ExecutionTracker;
  /** Runs when the pool frees a device, before the free is recorded. */
  let onFree: (deviceId: string) => void;

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    freed = [];
    releases = [];
    manager.onSessionRelease((sessionId, _deviceId, reason) => {
      releases.push([sessionId, reason]);
    });
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    onFree = () => {};
    cascade = registerDerivedLabelSessionReleaseCascade(
      manager,
      {
        releaseDevice: async (deviceId, sessionId) => {
          onFree(deviceId);
          freed.push([deviceId, sessionId]);
        },
      },
      tracker,
    );
    const map = buildDeviceLabelMap(["A", "B", "C"], "base");
    await manager.createSession("base", "device-A", "android");
    await asPlanAllocation(manager, "base", ["base:B", "base:C"], async () => {
      await manager.createSession("base:B", "device-B", "android");
      await manager.createSession("base:C", "device-C", "android");
    });
    manager.setDeviceLabels("base", map);
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test.each(["explicit-release", "heartbeat-timeout", "cli-idle-timeout"])(
    "a base released by %s releases every derived session and frees its device",
    async (reason) => {
      await manager.releaseSession("base", reason);
      await cascade.settled();

      for (const id of ["base", "base:B", "base:C"]) {
        expect(manager.hasSession(id)).toBe(false);
      }
      expect(releases).toEqual([
        ["base", reason],
        ["base:B", PLAN_AUTO_RELEASE_REASON],
        ["base:C", PLAN_AUTO_RELEASE_REASON],
      ]);
      expect(freed).toEqual([
        ["device-B", "base:B"],
        ["device-C", "base:C"],
      ]);
    },
  );

  // #11490: the cascade frees a derived session's device, so it cuts that session's calls first.
  // The derived UUID is released as `plan-auto-release` (re-issuable), so the cut is plain.
  test("a call still running under a derived session is cut before its device is freed", async () => {
    const onDerived = tracker.startExecution("input/tap", undefined, "base:B");
    tracker.bindDeviceExecution(onDerived.id, "device-B");
    const onSibling = tracker.startExecution("input/tap", undefined, "base:C");
    tracker.bindDeviceExecution(onSibling.id, "device-C");
    const elsewhere = tracker.startExecution("input/tap", undefined, "unrelated");
    const abortedWhenFreed: Record<string, boolean> = {};
    onFree = (deviceId) => {
      abortedWhenFreed[deviceId] = (
        deviceId === "device-B" ? onDerived : onSibling
      ).abortController.signal.aborted;
    };

    await manager.releaseSession("base", "explicit-release");
    await cascade.settled();

    expect(abortedWhenFreed).toEqual({ "device-B": true, "device-C": true });
    expect(sessionReleaseThatCancelledCall(onDerived.cancelReason)).toBeUndefined();
    expect(elsewhere.abortController.signal.aborted).toBe(false);
  });

  test("the index survives the base's cache losing its label map", async () => {
    manager.clearSessionCache("base");
    expect(manager.getDeviceLabels("base")).toBeUndefined();

    await manager.releaseSession("base");
    await cascade.settled();

    expect(manager.hasSession("base:B")).toBe(false);
    expect(manager.hasSession("base:C")).toBe(false);
  });

  test("derived sessions already released by plan auto-release are not released again", async () => {
    await manager.releaseSession("base:B", PLAN_AUTO_RELEASE_REASON);
    await manager.releaseSession("base:C", PLAN_AUTO_RELEASE_REASON);
    releases.length = 0;

    await manager.releaseSession("base", PLAN_AUTO_RELEASE_REASON);
    await cascade.settled();

    expect(releases).toEqual([["base", PLAN_AUTO_RELEASE_REASON]]);
    expect(freed).toEqual([]);
  });

  test("a derived session's own release does not cascade to its siblings", async () => {
    await manager.releaseSession("base:B");
    await cascade.settled();

    expect(manager.hasSession("base")).toBe(true);
    expect(manager.hasSession("base:C")).toBe(true);
  });

  test("a failed derived release is logged and does not stop the others", async () => {
    const release = manager.releaseSession.bind(manager);
    const failing = spyOn(manager, "releaseSession").mockImplementation(async (id, ...rest) => {
      if (id === "base:B") {
        throw new Error("injected B release failure");
      }
      return release(id, ...rest);
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await manager.releaseSession("base");
      await cascade.settled();

      expect(manager.hasSession("base:B")).toBe(true);
      expect(manager.hasSession("base:C")).toBe(false);
      expect(freed).toEqual([["device-C", "base:C"]]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to release label session base:B with its base base"),
        expect.any(Error),
      );
    } finally {
      failing.mockRestore();
      warn.mockRestore();
    }
  });
});
