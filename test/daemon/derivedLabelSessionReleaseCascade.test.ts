import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  registerDerivedLabelSessionReleaseCascade,
  type DerivedLabelSessionReleaseCascade,
} from "../../src/daemon/derivedLabelSessionReleaseCascade";
import { PLAN_AUTO_RELEASE_REASON, SessionManager } from "../../src/daemon/sessionManager";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11091: releasing a base session releases its derived `${base}:${label}` sessions and frees
// their devices, whatever released the base.
describe("derived label sessions are released with their base (#11091)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let freed: Array<[string, string]>;
  let releases: Array<[string, string]>;
  let cascade: DerivedLabelSessionReleaseCascade;

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    freed = [];
    releases = [];
    manager.onSessionRelease((sessionId, _deviceId, reason) => {
      releases.push([sessionId, reason]);
    });
    cascade = registerDerivedLabelSessionReleaseCascade(manager, {
      releaseDevice: async (deviceId, sessionId) => {
        freed.push([deviceId, sessionId]);
      },
    });
    const map = buildDeviceLabelMap(["A", "B", "C"], "base");
    await manager.createSession("base", "device-A", "android");
    await manager.createSession("base:B", "device-B", "android");
    await manager.createSession("base:C", "device-C", "android");
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
