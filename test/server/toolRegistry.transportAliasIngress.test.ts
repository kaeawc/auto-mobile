import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { DEVICE_ASSIGNED_TO_BINDING_CODE } from "../../src/daemon/sessionBroker/provisioning/refusal";
import { ActionableError } from "../../src/models/ActionableError";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  transportAliasHarness,
  describeOutcome,
  booted,
  USB,
  WIRELESS,
  EMULATOR,
  EMULATOR_TCP,
  HOLDER,
  HOLDER_CONNECTION,
  STRANGER_CONNECTION,
  type HarnessOptions,
} from "../helpers/transportAliasHarness";

const cleanups: Array<() => void> = [];
function runCleanups(): void {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
}
afterEach(runCleanups);
async function harness(options: HarnessOptions) {
  return transportAliasHarness(options, cleanups);
}

const phone = () => harness({ pooledRows: [booted(USB), booted(WIRELESS)], held: USB });

// The first harness loads and compiles the daemon pool, session and tool-call graph; build one
// here, outside the 100 ms test budget, rather than inside whichever test runs first.
beforeAll(async () => {
  try {
    await phone();
  } finally {
    runCleanups();
  }
});

describe("a tool call naming a held handset by either transport id (#11618)", () => {
  test("the pool holds the handset once, under its USB serial", async () => {
    const h = await phone();

    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([USB]);
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([WIRELESS]);
    expect(h.sessions.getSessionForDevice(USB)).toBe(HOLDER);
  });

  describe.each([
    ["canonical", USB],
    ["alias", WIRELESS],
  ])("named by its %s id", (_kind, deviceId) => {
    test("a sessionless control call is refused for the holder and is not use", async () => {
      const h = await phone();
      const before = { ...h.sessions.getSession(HOLDER)! };
      h.timer.advanceTime(5_000);

      const outcome = await h.outcome("controlProbe", { platform: "android", deviceId });

      expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(h.tools.runs).toEqual([]);
      expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(h.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before.lastUsedAt);
      expect(h.sessions.getSession(HOLDER)!.expiresAt).toBe(before.expiresAt);
    });

    test("a control call from another connection is refused for the holder", async () => {
      const h = await phone();

      const outcome = await h.outcome("controlProbe", {
        platform: "android",
        deviceId,
        __mcpSessionId: STRANGER_CONNECTION,
      });

      expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(h.tools.runs).toEqual([]);
    });

    test("a control call under another session is refused and is not that session's use", async () => {
      const h = await phone();
      await h.sessions.createSession("other-session", "OTHER-DEVICE", "android");
      const before = h.sessions.getSession(HOLDER)!.lastUsedAt;
      h.timer.advanceTime(5_000);

      const outcome = await h.outcome("controlProbe", { sessionUuid: "other-session", deviceId });

      expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(h.tools.runs).toEqual([]);
      expect(h.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before);
    });

    test("the holder's call naming its session runs on the one pooled device", async () => {
      const h = await phone();

      const outcome = await h.outcome("controlProbe", { sessionUuid: HOLDER, deviceId });

      expect(outcome).toBe("ran");
      expect(h.tools.runs).toEqual([{ name: "controlProbe", deviceId: USB, sessionUuid: HOLDER }]);
    });

    test("the holder connection's deviceId-only call runs as its session", async () => {
      const h = await phone();

      const outcome = await h.outcome("controlProbe", {
        deviceId,
        __mcpSessionId: HOLDER_CONNECTION,
      });

      expect(outcome).toBe("ran");
      expect(h.tools.runs).toEqual([{ name: "controlProbe", deviceId: USB, sessionUuid: HOLDER }]);
    });

    test.each([undefined, STRANGER_CONNECTION])(
      "a read works, reads the pooled device, and holds, binds and extends nothing (%s)",
      async (connection) => {
        const h = await phone();
        const before = { ...h.sessions.getSession(HOLDER)! };
        const sessionsBefore = h.sessions.getAllSessions().map((session) => session.sessionId);
        h.timer.advanceTime(5_000);

        const outcome = await h.outcome("readProbe", {
          platform: "android",
          deviceId,
          __mcpSessionId: connection,
        });

        expect(outcome).toBe("ran");
        expect(h.reads).toEqual([USB]);
        expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
        expect(h.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before.lastUsedAt);
        expect(h.sessions.getSession(HOLDER)!.expiresAt).toBe(before.expiresAt);
        expect(h.sessions.getAllSessions().map((session) => session.sessionId)).toEqual(
          sessionsBefore,
        );
        expect(h.sessions.getSessionForDevice(USB)).toBe(HOLDER);
      },
    );

    test("a read under another session watches the canonical phone without extending either session", async () => {
      const h = await phone();
      await h.sessions.createSession("other-session", "OTHER-DEVICE", "android");
      const before = h.sessions
        .getAllSessions()
        .map((s) => ({ sessionId: s.sessionId, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt }));
      h.timer.advanceTime(1000);
      expect(await h.outcome("readProbe", { sessionUuid: "other-session", deviceId })).toBe("ran");
      expect(h.reads).toEqual([USB]);
      expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(
        h.sessions.getAllSessions().map((s) => ({
          sessionId: s.sessionId,
          lastUsedAt: s.lastUsedAt,
          expiresAt: s.expiresAt,
        })),
      ).toEqual(before);
    });

    test("a plan step (callInternal) is refused for a stranger and runs for the holder", async () => {
      const h = await phone();

      const refused = await ToolRegistry.callInternal("controlProbe", {
        platform: "android",
        deviceId,
      }).then(describeOutcome, describeOutcome);
      const ran = await ToolRegistry.callInternal(
        "controlProbe",
        { deviceId },
        { sessionUuid: HOLDER },
      ).then(describeOutcome, describeOutcome);

      expect(refused).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(ran).toBe("ran");
      expect(h.tools.runs).toEqual([{ name: "controlProbe", deviceId: USB, sessionUuid: HOLDER }]);
    });
  });

  test("every control device tool decides the same for the alias as for the canonical id", async () => {
    const h = await phone();
    // Control tools only: a refused control call does no device work. Read bodies are real device
    // code here, so reads are covered by the read probe above and `observe` below.
    const controlTools = ToolRegistry.getAllTools().filter(
      (tool) =>
        tool.requiresDevice && !tool.isDeviceReadOnlyCall?.({ platform: "android", deviceId: USB }),
    );
    expect(controlTools.length).toBeGreaterThan(10);

    const decisions: Array<[string, string, string]> = [];
    for (const tool of controlTools) {
      const byCanonical = await h.outcome(tool.name, { platform: "android", deviceId: USB });
      const byAlias = await h.outcome(tool.name, { platform: "android", deviceId: WIRELESS });
      decisions.push([tool.name, byCanonical, byAlias]);
    }

    expect(
      decisions.filter(
        ([, canonical, alias]) =>
          canonical !== DEVICE_OWNED_BY_OTHER_SESSION_CODE || alias !== canonical,
      ),
    ).toEqual([]);
    expect(h.tools.runs).toEqual([]);
  });

  test("observe by either id watches the one pooled device", async () => {
    const h = await phone();

    const byCanonical = await h.outcome("observe", { platform: "android", deviceId: USB });
    const byAlias = await h.outcome("observe", { platform: "android", deviceId: WIRELESS });

    expect([byCanonical, byAlias]).toEqual(["ran", "ran"]);
    expect(h.tools.watcherReads).toEqual([USB, USB]);
    expect(h.tools.runs).toEqual([]);
  });

  test("setActiveDevice from a stranger is refused the same for either id", async () => {
    const h = await phone();
    const attempt = (deviceId: string) =>
      ToolRegistry.callInternal("setActiveDevice", {
        deviceId,
        platform: "android",
        sessionUuid: "stranger-session",
      }).then(describeOutcome, describeOutcome);

    const byCanonical = await attempt(USB);
    const byAlias = await attempt(WIRELESS);

    expect(byCanonical).not.toBe("ran");
    expect(byAlias).toBe(byCanonical);
    expect(h.sessions.getSessionForDevice(USB)).toBe(HOLDER);
  });

  test("killDevice and startDevice-by-serial receive the canonical id on the plan step path", async () => {
    await phone();
    const received: unknown[] = [];
    for (const name of ["killDevice", "startDevice"]) {
      ToolRegistry.register(name, name, z.object({}).passthrough(), async (args) => {
        received.push(args);
        return { success: true };
      });
    }

    await ToolRegistry.callInternal("killDevice", {
      device: { name: "Phone", deviceId: WIRELESS, platform: "android" },
    });
    await ToolRegistry.callInternal("startDevice", { platform: "android", deviceId: WIRELESS });

    expect(received).toMatchObject([
      { device: { name: "Phone", deviceId: USB, platform: "android" } },
      { platform: "android", deviceId: USB },
    ]);
  });
});

describe("a transport the pool has not folded yet (#11618)", () => {
  test("a wireless id first seen on a control call is folded before the holder check", async () => {
    const h = await harness({ pooledRows: [booted(USB)], held: USB });
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([]);
    // Wireless debugging is switched on; no pool refresh has run since.
    h.connect([booted(USB), booted(WIRELESS)]);

    const outcome = await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });

    expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(h.tools.runs).toEqual([]);
    expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([WIRELESS]);
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([USB]);
  });

  test("the holder's own first call by the new wireless id runs as its session", async () => {
    const h = await harness({ pooledRows: [booted(USB)], held: USB });
    h.connect([booted(USB), booted(WIRELESS)]);

    const outcome = await h.outcome("controlProbe", {
      deviceId: WIRELESS,
      __mcpSessionId: HOLDER_CONNECTION,
    });

    expect(outcome).toBe("ran");
    expect(h.tools.runs).toEqual([{ name: "controlProbe", deviceId: USB, sessionUuid: HOLDER }]);
  });

  test.each([undefined, STRANGER_CONNECTION])(
    "a first-seen read folds a held phone, without readiness (%s)",
    async (connection) => {
      const h = await harness({ pooledRows: [booted(USB)], held: USB });
      h.connect([booted(USB), booted(WIRELESS)]);
      const before = { ...h.sessions.getSession(HOLDER)! };
      const sessionsBefore = h.sessions.getAllSessions().map((s) => s.sessionId);
      h.timer.advanceTime(1000);
      const args = { platform: "android", deviceId: WIRELESS, __mcpSessionId: connection };

      expect(await h.outcome("readProbe", args)).toBe("ran");
      expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(h.reads).toEqual([USB]);
      expect(await h.outcome("observe", args)).toBe("ran");
      expect(h.tools.watcherReads).toEqual([USB]);
      expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(h.tools.runs).toEqual([]);
      expect(h.pool.getAndroidTransportAliases(USB)).toEqual([WIRELESS]);
      expect(h.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before.lastUsedAt);
      expect(h.sessions.getSession(HOLDER)!.expiresAt).toBe(before.expiresAt);
      expect(h.sessions.getAllSessions().map((s) => s.sessionId)).toEqual(sessionsBefore);
    },
  );

  test.each([undefined, STRANGER_CONNECTION])(
    "a failed listing leaves an unfolded read read-only (%s)",
    async (connection) => {
      const h = await harness({ pooledRows: [booted(USB)], held: USB });
      h.connect([booted(USB), booted(WIRELESS)]);
      h.discovery.setAndroidDiscoveryIncomplete("adb devices timed out");
      const outcome = await h.outcome("readProbe", {
        platform: "android",
        deviceId: WIRELESS,
        __mcpSessionId: connection,
      });
      expect(outcome).not.toBe("discovery_incomplete");
      expect(outcome).not.toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(outcome).not.toBe(DEVICE_ASSIGNED_TO_BINDING_CODE);
      expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(h.tools.runs).toEqual([]);
    },
  );

  test("a folded read costs no raw listing or adb call", async () => {
    const h = await phone();
    const probes = h.adbFactory.getCallCount();
    const scans = h.rawScans();
    expect(await h.outcome("readProbe", { platform: "android", deviceId: WIRELESS })).toBe("ran");
    expect(h.adbFactory.getCallCount()).toBe(probes);
    expect(h.rawScans()).toBe(scans);
  });

  test.each([USB, EMULATOR, "OTHER-USB"])(
    "an ordinary control id %s costs no raw listing or adb call",
    async (deviceId) => {
      const h = await harness({ pooledRows: [booted(deviceId)] });
      const reconcile = spyOn(h.pool, "reconcileDiscoveryObservation");
      cleanups.push(() => reconcile.mockRestore());
      const probes = h.adbFactory.getCallCount();
      const scans = h.rawScans();
      expect(await h.outcome("controlProbe", { platform: "android", deviceId })).toBe("ran");
      expect(h.adbFactory.getCallCount()).toBe(probes);
      expect(h.rawScans()).toBe(scans);
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  test("a folded alias costs no adb call per tool call", async () => {
    const h = await phone();
    const probes = h.adbFactory.getCallCount();
    const scans = h.tools.deviceReadiness.getDetectConnectedPlatformsCallCount();
    const rawScans = h.rawScans();

    await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });
    await h.outcome("controlProbe", { sessionUuid: HOLDER, deviceId: WIRELESS });
    await h.outcome("controlProbe", { sessionUuid: HOLDER, deviceId: USB });

    expect(h.adbFactory.getCallCount()).toBe(probes);
    expect(h.tools.deviceReadiness.getDetectConnectedPlatformsCallCount()).toBe(scans);
    expect(h.rawScans()).toBe(rawScans);
  });

  test("a refused first-sighting call leaves the holder's dispatch route where it was", async () => {
    const TCP = "192.168.1.20:5555";
    const h = await harness({ pooledRows: [booted(USB), booted(TCP)], held: USB });
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([TCP]);
    // The same phone also appears under its mDNS id; adb lists the USB row first.
    const rows = [booted(USB), booted(TCP), booted(WIRELESS)];
    h.connect(rows);
    const rawScans = h.rawScans();

    const outcome = await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });

    expect(outcome).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    // The fold is fed one fresh RAW listing, not the readiness scan's pool-mapped rows.
    expect(h.rawScans()).toBe(rawScans + 1);
    expect(h.pool.getAndroidTransportAliases(USB).toSorted()).toEqual([TCP, WIRELESS].toSorted());
    // The next readiness scan re-routes a group from its live rows: USB is live, so it stays.
    h.pool.mapAndroidReadinessDiscovery(rows);
    expect(h.pool.getAndroidTransportRouting().resolveTransport(USB)).toBe(USB);
    // And when Wi-Fi drops with the cable still attached, dispatch is still on USB.
    h.pool.mapAndroidReadinessDiscovery([booted(USB)]);
    expect(h.pool.getAndroidTransportRouting().resolveTransport(USB)).toBe(USB);
  });
});

describe("unidentified transports use the held-alias rule (#11596)", () => {
  test.each([undefined, "0123456789abcdef"])(
    "a listed unidentified control target reconciles before the held-alias verdict (holder %s)",
    async (held) => {
      const generic = "0123456789abcdef";
      const rows = [booted(generic), booted(WIRELESS)];
      const h = await harness({ pooledRows: rows, serial: generic, held });
      const mapped = h.pool.mapAndroidDiscovery(rows);
      const events: string[] = [];
      const reconcileObservation = h.pool.reconcileDiscoveryObservation.bind(h.pool);
      const mayAlias = h.pool.androidTransportMayAliasDevice.bind(h.pool);
      const reconcile = spyOn(h.pool, "reconcileDiscoveryObservation").mockImplementation(
        async (devices, source, options) => {
          await reconcileObservation(devices, source, options);
          if (source === "tools/call:identity-gate") {
            events.push("reconciled");
          }
        },
      );
      cleanups.push(() => reconcile.mockRestore());
      const identity = spyOn(h.pool, "androidTransportMayAliasDevice").mockImplementation(
        (device, deviceId) => {
          events.push("identity");
          return mayAlias(device, deviceId);
        },
      );
      cleanups.push(() => identity.mockRestore());

      expect(await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS })).toBe(
        held ? DEVICE_OWNED_BY_OTHER_SESSION_CODE : "ran",
      );

      expect(reconcile).toHaveBeenCalledWith(mapped, "tools/call:identity-gate", {
        signal: expect.any(AbortSignal),
      });
      expect(events).toEqual(held ? ["reconciled", "identity"] : ["reconciled"]);
    },
  );

  test.each(["incomplete", "throws"])(
    "an identity listing that %s reconciles nothing and uses a conservative synthetic row",
    async (failure) => {
      const generic = "0123456789abcdef";
      const h = await harness({
        pooledRows: [booted(generic), booted(WIRELESS)],
        serial: generic,
        held: generic,
      });
      const list = h.discovery.getBootedDevicesDetailed.bind(h.discovery);
      const listing = spyOn(h.discovery, "getBootedDevicesDetailed").mockImplementation(
        async (platform, options = {}) => {
          if (options.bypassAndroidDeviceListCache) {
            return list(platform, options);
          }
          if (failure === "throws") {
            throw new Error("identity listing failed");
          }
          return { ...(await list(platform, options)), succeededSources: new Set() };
        },
      );
      cleanups.push(() => listing.mockRestore());
      const reconcile = spyOn(h.pool, "reconcileDiscoveryObservation");
      cleanups.push(() => reconcile.mockRestore());
      const identity = spyOn(h.pool, "androidTransportMayAliasDevice");
      cleanups.push(() => identity.mockRestore());

      expect(await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS })).toBe(
        DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      );

      expect(
        reconcile.mock.calls.filter(([, source]) => source === "tools/call:identity-gate"),
      ).toEqual([]);
      expect(identity.mock.calls.at(-1)?.[0]).toEqual({
        deviceId: WIRELESS,
        name: WIRELESS,
        platform: "android",
      });
      expect(h.tools.runs).toEqual([]);
    },
  );

  test.each([false, true])(
    "an identity reconcile failure stops control before readiness (already actionable %s)",
    async (actionable) => {
      const h = await harness({ pooledRows: [booted(WIRELESS)], serial: "unknown" });
      const failure = actionable
        ? new ActionableError("identity reconcile failed")
        : new Error("identity reconcile failed");
      const reconcileObservation = h.pool.reconcileDiscoveryObservation.bind(h.pool);
      const reconcile = spyOn(h.pool, "reconcileDiscoveryObservation").mockImplementation(
        async (devices, source, options) => {
          if (source === "tools/call:identity-gate") {
            throw failure;
          }
          await reconcileObservation(devices, source, options);
        },
      );
      cleanups.push(() => reconcile.mockRestore());

      const result = await h.tools
        .call("controlProbe", {
          platform: "android",
          deviceId: WIRELESS,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(result).toBeInstanceOf(ActionableError);
      if (actionable) {
        expect(result).toBe(failure);
      } else {
        expect(result).toMatchObject({
          cause: failure,
          message: `Failed to reconcile identity listing for ${WIRELESS}: identity reconcile failed`,
        });
      }
      expect(h.tools.runs).toEqual([]);
      expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
    },
  );

  test("an identity reconcile failure keeps a sessionless read read-only", async () => {
    const h = await harness({ pooledRows: [booted(WIRELESS)], serial: "unknown" });
    const reconcileObservation = h.pool.reconcileDiscoveryObservation.bind(h.pool);
    const reconcile = spyOn(h.pool, "reconcileDiscoveryObservation").mockImplementation(
      async (devices, source, options) => {
        if (source === "tools/call:identity-gate") {
          throw new Error("identity reconcile failed");
        }
        await reconcileObservation(devices, source, options);
      },
    );
    cleanups.push(() => reconcile.mockRestore());

    expect(await h.outcome("readProbe", { platform: "android", deviceId: WIRELESS })).toBe("ran");
    expect(reconcile.mock.calls.some(([, source]) => source === "tools/call:identity-gate")).toBe(
      true,
    );
    expect(h.reads).toEqual([WIRELESS]);
    expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("a control call on a wireless phone with a generic serial is allowed, as before", async () => {
    // A generic factory serial proves nothing, so the pool neither pools nor aliases the row.
    const h = await harness({ pooledRows: [booted(WIRELESS)], serial: "unknown" });
    expect(h.pool.getAllDevices()).toEqual([]);
    expect(h.pool.isAndroidTransportAssignable(booted(WIRELESS))).toBe(false);

    const outcome = await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });

    expect(outcome).toBe("ran");
    expect(h.tools.runs).toEqual([
      { name: "controlProbe", deviceId: WIRELESS, sessionUuid: undefined },
    ]);
  });

  test("an unidentified transport is probed by the first call only, not on every call", async () => {
    const h = await harness({ pooledRows: [booted(WIRELESS)], serial: "unknown" });
    const call = () => h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS });
    const beforeFirst = h.adbFactory.getCallCount();

    await call();
    const afterFirst = h.adbFactory.getCallCount();
    await call();
    await call();

    expect(afterFirst).toBeGreaterThan(beforeFirst);
    expect(h.adbFactory.getCallCount()).toBe(afterFirst);
    expect(h.tools.runs).toHaveLength(3);
  });

  test("two phones reporting the same generic serial are not folded, and ambiguous control is refused", async () => {
    const generic = "0123456789abcdef";
    const h = await harness({
      pooledRows: [booted(generic), booted(WIRELESS)],
      serial: generic,
      held: generic,
    });
    expect(h.pool.isAndroidTransportAssignable(booted(WIRELESS))).toBe(false);
    expect(h.pool.androidTransportMayAliasDevice(booted(WIRELESS), generic)).toBe(true);
    const before = { ...h.sessions.getSession(HOLDER)! };
    h.timer.advanceTime(1000);
    expect(await h.outcome("controlProbe", { platform: "android", deviceId: WIRELESS })).toBe(
      DEVICE_OWNED_BY_OTHER_SESSION_CODE,
    );
    expect(h.tools.runs).toEqual([]);
    expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
    expect(h.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before.lastUsedAt);
    expect(h.sessions.getSession(HOLDER)!.expiresAt).toBe(before.expiresAt);
    expect(h.pool.getAndroidTransportAliases(generic)).toEqual([]);
    expect(await h.outcome("controlProbe", { sessionUuid: HOLDER, deviceId: generic })).toBe("ran");
    expect(h.tools.runs).toEqual([
      { name: "controlProbe", deviceId: generic, sessionUuid: HOLDER },
    ]);
  });

  test("an ambiguous callInternal plan step is refused before readiness", async () => {
    const generic = "0123456789abcdef";
    const h = await harness({
      pooledRows: [booted(generic), booted(WIRELESS)],
      serial: generic,
      held: generic,
    });
    expect(
      await ToolRegistry.callInternal("controlProbe", {
        platform: "android",
        deviceId: WIRELESS,
      }).then(describeOutcome, describeOutcome),
    ).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(h.tools.runs).toEqual([]);
    expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test.each([undefined, STRANGER_CONNECTION])(
    "an unidentified read that could alias a holder never readies (%s)",
    async (connection) => {
      const generic = "0123456789abcdef";
      const h = await harness({
        pooledRows: [booted(generic), booted(WIRELESS)],
        serial: generic,
        held: generic,
      });
      const before = { ...h.sessions.getSession(HOLDER)! };
      const sessionsBefore = h.sessions.getAllSessions().map((s) => s.sessionId);
      h.timer.advanceTime(1000);
      expect(
        await h.outcome("readProbe", {
          platform: "android",
          deviceId: WIRELESS,
          __mcpSessionId: connection,
        }),
      ).toBe("ran");
      expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(h.reads).toEqual([WIRELESS]);
      expect(h.tools.runs).toEqual([]);
      expect(h.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before.lastUsedAt);
      expect(h.sessions.getSession(HOLDER)!.expiresAt).toBe(before.expiresAt);
      expect(h.sessions.getAllSessions().map((s) => s.sessionId)).toEqual(sessionsBefore);
    },
  );

  test("a healthy listing gives an unidentified read the real transport row", async () => {
    const generic = "0123456789abcdef";
    const listed = booted(WIRELESS);
    const h = await harness({
      pooledRows: [booted(generic), listed],
      serial: generic,
      held: generic,
    });
    const identity = spyOn(h.pool, "androidTransportMayAliasDevice");
    cleanups.push(() => identity.mockRestore());
    const mapping = spyOn(h.pool, "mapAndroidDiscovery");
    cleanups.push(() => mapping.mockRestore());
    const listingsBefore = h.rawScans();

    expect(await h.outcome("readProbe", { platform: "android", deviceId: WIRELESS })).toBe("ran");

    expect(h.rawScans() - listingsBefore).toBe(2);
    expect(identity).toHaveBeenCalledWith(listed, generic);
    const mapped: unknown = mapping.mock.results.at(-1)?.value;
    expect(identity.mock.calls.at(-1)?.[0]).toBe(
      Array.isArray(mapped)
        ? mapped.find((row: BootedDevice) => row.deviceId === WIRELESS)
        : undefined,
    );
    expect(h.reads).toEqual([WIRELESS]);
    expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("an unidentified read with nothing held keeps read readiness", async () => {
    const h = await harness({ pooledRows: [booted(WIRELESS)], serial: "unknown" });
    expect(await h.outcome("readProbe", { platform: "android", deviceId: WIRELESS })).toBe("ran");
    expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(1);
    expect(h.tools.deviceReadiness.getLastOptions()?.intent).toBe("read");
  });
});

describe("devices the alias fold does not concern (#11618)", () => {
  test("an emulator's loopback adb address is its console serial for a broker binding", async () => {
    const h = await harness({
      pooledRows: [booted(EMULATOR, "Pixel"), booted(EMULATOR_TCP)],
      avd: "Pixel",
      bindingStableId: "Pixel",
    });
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([EMULATOR]);

    const byCanonical = await h.outcome("controlProbe", {
      platform: "android",
      deviceId: EMULATOR,
    });
    const byAlias = await h.outcome("controlProbe", {
      platform: "android",
      deviceId: EMULATOR_TCP,
    });
    const readByAlias = await h.outcome("readProbe", {
      platform: "android",
      deviceId: EMULATOR_TCP,
    });

    expect(byCanonical).toBe(DEVICE_ASSIGNED_TO_BINDING_CODE);
    expect(byAlias).toBe(DEVICE_ASSIGNED_TO_BINDING_CODE);
    // #11641: even an idle broker binding's device is read-only, on the canonical device, without readiness.
    expect(readByAlias).toBe("ran");
    expect(h.reads).toEqual([EMULATOR]);
    expect(h.tools.runs).toEqual([]);
    expect(h.tools.deviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("an iOS id is passed through untouched and never probed", async () => {
    const simulator: BootedDevice = { deviceId: "IOS-UDID-1", name: "iPhone", platform: "ios" };
    const h = await harness({ pooledRows: [booted(USB)], iosRows: [simulator] });
    const probes = h.adbFactory.getCallCount();
    const scans = h.rawScans();

    const outcome = await h.outcome("controlProbe", { platform: "ios", deviceId: "IOS-UDID-1" });
    const untyped = await h.outcome("controlProbe", { deviceId: "IOS-UDID-1" });

    expect([outcome, untyped]).toEqual(["ran", "ran"]);
    expect(h.tools.runs.map((run) => run.deviceId)).toEqual(["IOS-UDID-1", "IOS-UDID-1"]);
    expect(h.adbFactory.getCallCount()).toBe(probes);
    expect(h.rawScans()).toBe(scans);
  });
});
