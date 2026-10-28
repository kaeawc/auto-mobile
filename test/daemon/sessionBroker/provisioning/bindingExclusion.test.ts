import { logger } from "../../../../src/utils/logger";
import { BindingRegistryUpgradePendingError } from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  currentBindingReconciler,
  refreshAllocationBindingExclusion,
  bindingRefusal,
  RegistryBindingExclusion,
  runAsBindingReconciler,
} from "../../../../src/daemon/sessionBroker/provisioning/exclusion";
import {
  DEVICE_ASSIGNED_TO_BINDING_CODE,
  DeviceAssignedToBindingError,
  BindingRegistrySchemaUnsupportedError,
  BINDING_DISCOVERY_INCOMPLETE_CODE,
  BindingDiscoveryIncompleteError,
} from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import type { BindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { assignBindingDevice } from "./bindingFixtures";

describe("RegistryBindingExclusion", () => {
  let timer: FakeTimer;
  let registry: FakeBindingRegistry;
  let opens: number;

  const exclusionOver = (open: () => Promise<BindingRegistry>) =>
    new RegistryBindingExclusion(open, timer);

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    registry = new FakeBindingRegistry(timer);
    opens = 0;
  });

  const openFake = async (): Promise<BindingRegistry> => {
    opens++;
    return registry;
  };

  test("unknown migrations use files only, warn once per path, and stay degraded until restart", async () => {
    const error = new BindingRegistrySchemaUnsupportedError("/fake/files-only.sqlite", [
      "2026_10_26_014_device_claims",
      "2026_10_27_015_device_claims_metadata",
    ]);
    const open = async (): Promise<BindingRegistry> => {
      opens++;
      throw error;
    };
    const exclusion = exclusionOver(open);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await exclusion.refresh();
      await exclusion.refresh({ fresh: true });
      await exclusionOver(open).refresh();
      expect(opens).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(error.unknownMigrations.join(", "));
      expect(warn.mock.calls[0]?.[0]).toContain("allocation claim files decide ownership");
      expect(warn.mock.calls[0]?.[0]).toContain(error.remedy);
      expect(exclusion.lastReadFailed()).toBe(false);
      expect(exclusion.holderOf({ platform: "ios", stableIds: ["BROKER"] })).toBeUndefined();
      expect([...exclusion.stableIdsFor("ios")]).toEqual([]);
      expect(exclusion.degraded()).toEqual({
        code: error.code,
        retryable: false,
        mode: "files_only",
        dbPath: error.dbPath,
        unknownMigrations: error.unknownMigrations,
        remedy: error.remedy,
      });
      for (const options of [
        { requireCurrent: true },
        { refuseUpgradePending: true },
        { requireCurrent: true, maxAgeMs: 60_000 },
        { refuseUpgradePending: true, maxAgeMs: 60_000 },
      ]) {
        await expect(exclusion.refresh(options)).rejects.toBe(error);
      }
      expect(opens).toBe(2);
      const otherError = new BindingRegistrySchemaUnsupportedError(
        "/fake/other-files-only.sqlite",
        ["other-future"],
      );
      await exclusionOver(async () => {
        throw otherError;
      }).refresh();
      expect(warn).toHaveBeenCalledTimes(2);
      // A restarted view re-evaluates the registry rather than inheriting a terminal snapshot.
      const restarted = exclusionOver(openFake);
      await restarted.refresh();
      expect(restarted.degraded()).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("concurrent generic and strict refreshes share the open but keep separate outcomes", async () => {
    const opened = Promise.withResolvers<BindingRegistry>();
    const exclusion = exclusionOver(() => opened.promise);
    const generic = exclusion.refresh();
    const strict = exclusion.refresh({ requireCurrent: true });
    const error = new BindingRegistrySchemaUnsupportedError("/fake/concurrent.sqlite", ["future"]);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      opened.reject(error);
      const strictResult = expect(strict).rejects.toBe(error);
      await generic;
      await strictResult;
      expect(exclusion.degraded()?.mode).toBe("files_only");
      expect(exclusion.lastReadFailed()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test.each(["requireCurrent", "refuseUpgradePending"] as const)(
    "%s propagates unsupported schema even with a retained readable snapshot",
    async (option) => {
      await assignBindingDevice(registry, "ios", "BROKER");
      const exclusion = exclusionOver(openFake);
      await exclusion.refresh();
      const error = new BindingRegistrySchemaUnsupportedError(`/fake/${option}.sqlite`, ["future"]);
      registry.snapshotManagedDevices = async () => {
        throw error;
      };
      await expect(exclusion.refresh({ [option]: true })).rejects.toBe(error);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await refreshAllocationBindingExclusion(exclusion, { maxAgeMs: 60_000 });
        expect(exclusion.degraded()?.code).toBe(error.code);
        expect(exclusion.holderOf({ platform: "ios", stableIds: ["BROKER"] })).toBeUndefined();
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("pending upgrade warns once, remains absent, and re-probes on every refresh", async () => {
    let pending = true;
    const exclusion = exclusionOver(async () => {
      opens++;
      if (pending) {
        throw new BindingRegistryUpgradePendingError("retirement refused");
      }
      return registry;
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await exclusion.refresh({ requireCurrent: true });
      await exclusion.refresh({ requireCurrent: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(exclusion.lastReadFailed()).toBe(false);
      expect(opens).toBe(2);
      pending = false;
      await assignBindingDevice(registry, "ios", "BROKER");
      await exclusion.refresh({ requireCurrent: true });
      expect(exclusion.holderOf({ platform: "ios", stableIds: ["BROKER"] })).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("refuseUpgradePending refuses a pending upgrade retryably, then reads the upgraded registry", async () => {
    let pending = true;
    const exclusion = exclusionOver(async () => {
      if (pending) {
        throw new BindingRegistryUpgradePendingError("retirement refused");
      }
      return registry;
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(
        exclusion.refresh({ fresh: true, refuseUpgradePending: true }),
      ).rejects.toMatchObject({ code: BINDING_DISCOVERY_INCOMPLETE_CODE, retryable: true });
      // A young pending-upgrade snapshot is still refused, never reused as "nothing managed".
      await expect(
        exclusion.refresh({ maxAgeMs: 60_000, refuseUpgradePending: true }),
      ).rejects.toBeInstanceOf(BindingDiscoveryIncompleteError);
      pending = false;
      await assignBindingDevice(registry, "ios", "BROKER");
      await exclusion.refresh({ fresh: true, refuseUpgradePending: true });
      expect([...exclusion.stableIdsFor("ios")]).toEqual(["BROKER"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("holds every assigned device, idle or not, by any of its stable ids", async () => {
    const binding = await assignBindingDevice(registry, "android", "binding-avd");
    const exclusion = exclusionOver(openFake);
    await exclusion.refresh();

    expect(
      exclusion.holderOf({
        platform: "android",
        stableIds: [undefined, "emulator-5554", "binding-avd"],
      }),
    ).toMatchObject({ holder: "session_broker", scopeKey: binding.scopeKey, bindingIndex: 0 });
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["binding-avd"] })).toBeUndefined();
    expect(exclusion.holderOf({ platform: "android", stableIds: ["spare-avd"] })).toBeUndefined();
    expect([...exclusion.stableIdsFor("android")]).toEqual(["binding-avd"]);
    expect([...exclusion.stableIdsFor("ios")]).toEqual([]);
  });

  test("a registry never read refuses with a retryable discovery_incomplete, then recovers", async () => {
    let fail = true;
    const exclusion = exclusionOver(async () => {
      opens++;
      if (fail) {
        throw new Error("disk I/O error");
      }
      return registry;
    });

    const error = await exclusion.refresh().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BindingDiscoveryIncompleteError);
    expect((error as BindingDiscoveryIncompleteError).toPayload()).toEqual({
      code: BINDING_DISCOVERY_INCOMPLETE_CODE,
      retryable: true,
      retryAfterMs: 2_000,
    });

    fail = false;
    await assignBindingDevice(registry, "ios", "UDID-1");
    await exclusion.refresh();
    expect(opens).toBe(2);
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toBeDefined();
  });

  test("an unreadable registry keeps the last good snapshot instead of freeing assignments", async () => {
    await assignBindingDevice(registry, "ios", "UDID-1");
    const exclusion = exclusionOver(openFake);
    await exclusion.refresh();
    registry.snapshotManagedDevices = async () => {
      throw new Error("database is locked");
    };

    await exclusion.refresh();

    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toBeDefined();
  });

  test("required refresh rejects a failed read, retains known devices, then recovers", async () => {
    await assignBindingDevice(registry, "ios", "UDID-1");
    const exclusion = exclusionOver(openFake);
    await exclusion.refresh();
    const read = registry.snapshotManagedDevices.bind(registry);
    registry.snapshotManagedDevices = async () => {
      throw new Error("locked");
    };
    await expect(exclusion.refresh({ requireCurrent: true })).rejects.toMatchObject({
      code: BINDING_DISCOVERY_INCOMPLETE_CODE,
      retryable: true,
    });
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toBeDefined();
    registry.snapshotManagedDevices = read;
    await assignBindingDevice(registry, "ios", "UDID-2", "runner-b");
    await exclusion.refresh({ requireCurrent: true });
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-2"] })).toBeDefined();
  });

  test("a young good snapshot satisfies a required refresh without reading", async () => {
    const exclusion = exclusionOver(openFake);
    await exclusion.refresh();
    let reads = 0;
    registry.snapshotManagedDevices = async () => {
      reads++;
      throw new Error("locked");
    };
    await exclusion.refresh({ maxAgeMs: 1_000, requireCurrent: true });
    expect(reads).toBe(0);
  });

  test.each([false, true])(
    "shared failed load has per-caller strictness (fresh %s)",
    async (fresh) => {
      const exclusion = exclusionOver(openFake);
      await exclusion.refresh();
      const pending =
        Promise.withResolvers<Awaited<ReturnType<BindingRegistry["snapshotManagedDevices"]>>>();
      let reads = 0;
      registry.snapshotManagedDevices = () => {
        reads++;
        return pending.promise;
      };
      const tolerant = exclusion.refresh();
      const required = exclusion.refresh({ requireCurrent: true, fresh });
      const refused = required.then(
        () => undefined,
        (error: unknown) => error,
      );
      pending.reject(new Error("locked"));
      await tolerant;
      expect(await refused).toBeInstanceOf(BindingDiscoveryIncompleteError);
      expect(reads).toBe(fresh ? 2 : 1);
    },
  );

  test("maxAgeMs reuses a young snapshot; the default always re-reads", async () => {
    const exclusion = exclusionOver(openFake);
    await exclusion.refresh();
    await assignBindingDevice(registry, "ios", "UDID-1");

    await exclusion.refresh({ maxAgeMs: 1_000 });
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toBeUndefined();

    timer.advanceTime(1_000);
    await exclusion.refresh({ maxAgeMs: 1_000 });
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toBeDefined();

    await assignBindingDevice(registry, "ios", "UDID-2", "runner-b");
    await exclusion.refresh();
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-2"] })).toBeDefined();
    expect(opens).toBe(1);
  });
});

describe("bindingRefusal", () => {
  test("refuses everyone but the binding's recorded execution session, with binding evidence", async () => {
    const timer = new FakeTimer();
    const registry = new FakeBindingRegistry(timer);
    const binding = await assignBindingDevice(registry, "ios", "UDID-1", "runner-a", "exec-1");
    const exclusion = new RegistryBindingExclusion(async () => registry, timer);
    await exclusion.refresh();
    const device = { platform: "ios" as const, stableIds: ["UDID-1"] };

    for (const requesterSessionUuid of [undefined, "generic-session"]) {
      const refusal = bindingRefusal(exclusion, {
        action: "killDevice",
        deviceId: "UDID-1",
        device,
        requesterSessionUuid,
      });
      expect(refusal).toBeInstanceOf(DeviceAssignedToBindingError);
      expect(refusal?.toPayload()).toEqual({
        code: DEVICE_ASSIGNED_TO_BINDING_CODE,
        deviceId: "UDID-1",
        platform: "ios",
        stableId: "UDID-1",
        scopeKey: binding.scopeKey,
        declaredBinding: 0,
        retryable: false,
      });
    }
    expect(
      bindingRefusal(exclusion, {
        action: "killDevice",
        deviceId: "UDID-1",
        device,
        requesterSessionUuid: "exec-1",
      }),
    ).toBeUndefined();
    expect(
      bindingRefusal(undefined, { action: "killDevice", deviceId: "UDID-1", device }),
    ).toBeUndefined();
  });
});

describe("binding reconciler bypass (#11173)", () => {
  test("the binding's own reconciler may act on its device; no other binding's, and only inside the run", async () => {
    const timer = new FakeTimer();
    const registry = new FakeBindingRegistry(timer);
    const mine = await assignBindingDevice(registry, "android", "mine-avd", "runner-a");
    await assignBindingDevice(registry, "android", "other-avd", "runner-b");
    const exclusion = new RegistryBindingExclusion(async () => registry, timer);
    await exclusion.refresh();
    const refusalFor = (stableId: string) =>
      bindingRefusal(exclusion, {
        action: "provisionDevice",
        deviceId: stableId,
        device: { platform: "android", stableIds: [stableId] },
      });

    const inside = await runAsBindingReconciler(mine, async () => {
      await Promise.resolve();
      return {
        current: currentBindingReconciler(),
        mine: refusalFor("mine-avd"),
        other: refusalFor("other-avd"),
      };
    });

    expect(inside.current).toEqual(mine);
    expect(inside.mine).toBeUndefined();
    expect(inside.other).toBeInstanceOf(DeviceAssignedToBindingError);
    expect(currentBindingReconciler()).toBeUndefined();
    expect(refusalFor("mine-avd")).toBeInstanceOf(DeviceAssignedToBindingError);
  });
});
