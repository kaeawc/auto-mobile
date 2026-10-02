import { describe, expect, it, spyOn } from "bun:test";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { logger } from "../../src/utils/logger";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

function makeRegistry(scripted?: string[]) {
  const timer = new FakeTimer();
  const idGenerator = new FakeIdGenerator(scripted);
  const registry = new DeviceSessionRegistry(timer, idGenerator);
  return { registry, timer, idGenerator };
}

describe("DeviceSessionRegistry", () => {
  it("restore retires with reason before starting the successor and records a tombstone", () => {
    const { registry } = makeRegistry(["old", "new"]);
    const events: unknown[] = [];
    const observedDuringEnd: string[] = [];
    registry.onDeviceConnected({ deviceId: "d", platform: "android", incarnation: 1 });
    registry.setLifecycleListener({
      onSessionStarted: (record) => events.push(["started", record.deviceSessionUuid]),
      onSessionEnded: (record, options) => {
        events.push(["ended", record.deviceSessionUuid, options]);
        observedDuringEnd.push(registry.getByDeviceId("d")!.deviceSessionUuid);
        // A readiness callback re-entering the registry cannot double-mint.
        if (observedDuringEnd.length === 1) {
          observedDuringEnd.push(
            registry.onDeviceConnected({ deviceId: "d", platform: "android", incarnation: 2 })
              .deviceSessionUuid,
          );
        }
      },
    });
    registry.onDeviceConnected({
      deviceId: "d",
      platform: "android",
      incarnation: 2,
      retireReason: "superseded-by-restore",
    });
    expect(events).toEqual([
      ["ended", "old", { successorSessionUuid: "new", reason: "superseded-by-restore" }],
      ["started", "new"],
    ]);
    expect(registry.getByUuid("old")).toBeUndefined();
    expect(observedDuringEnd).toEqual(["new", "new"]);
    expect(registry.getRetiredByUuid("old")).toEqual({
      deviceId: "d",
      successorSessionUuid: "new",
      reason: "superseded-by-restore",
    });
  });

  it("bounds restore tombstones to 256 and clears them on disconnect", () => {
    const { registry } = makeRegistry();
    const connect = (incarnation: number) =>
      registry.onDeviceConnected({
        deviceId: "d",
        platform: "android",
        incarnation,
        retireReason: "superseded-by-restore",
      });
    const first = connect(0);
    const second = connect(1);
    for (let incarnation = 2; incarnation <= 257; incarnation++) {
      connect(incarnation);
    }
    expect(registry.getRetiredByUuid(first.deviceSessionUuid)).toBeUndefined();
    expect(registry.getRetiredByUuid(second.deviceSessionUuid)).toBeDefined();
    registry.onDeviceDisconnected("d");
    expect(registry.getRetiredByUuid(second.deviceSessionUuid)).toBeUndefined();
  });

  it("never mints backwards or twice when reconnect follows a restore incarnation", () => {
    const { registry, idGenerator } = makeRegistry(["old", "new", "unused"]);
    registry.onDeviceConnected({ deviceId: "d", platform: "android", incarnation: 1 });
    const restored = registry.onDeviceConnected({
      deviceId: "d",
      platform: "android",
      incarnation: 3,
      retireReason: "superseded-by-restore",
    });
    expect(registry.onDeviceConnected({ deviceId: "d", platform: "android", incarnation: 3 })).toBe(
      restored,
    );
    expect(registry.onDeviceConnected({ deviceId: "d", platform: "android", incarnation: 2 })).toBe(
      restored,
    );
    expect(idGenerator.pendingCount()).toBe(1);
  });

  it("mints a deviceSessionUuid on device-connect via the injected IdGenerator", () => {
    const { registry } = makeRegistry(["uuid-a"]);

    const record = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 1,
    });

    expect(record.deviceSessionUuid).toBe("uuid-a");
    expect(record.deviceId).toBe("emulator-5554");
    expect(record.platform).toBe("android");
  });

  it("stamps epochStartedAt from the injected timer", () => {
    const { registry, timer } = makeRegistry(["uuid-a"]);
    timer.setCurrentTime(12345);

    const record = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 1,
    });

    expect(record.epochStartedAt).toBe(12345);
  });

  it("is idempotent for a repeated connect of the same incarnation (no new uuid)", () => {
    const { registry, idGenerator } = makeRegistry(["uuid-a", "uuid-b"]);

    const first = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 1,
    });
    const second = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 1,
    });

    expect(second.deviceSessionUuid).toBe(first.deviceSessionUuid);
    // Only one uuid was consumed; the second scripted id is still pending.
    expect(idGenerator.pendingCount()).toBe(1);
  });

  it("retires the record on disconnect (lookups return undefined)", () => {
    const { registry } = makeRegistry(["uuid-a"]);
    const record = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 1,
    });

    registry.onDeviceDisconnected("emulator-5554");

    expect(registry.getByDeviceId("emulator-5554")).toBeUndefined();
    expect(registry.getByUuid(record.deviceSessionUuid)).toBeUndefined();
  });

  it("mints a NEW uuid on reconnect of the same serial (disconnect then connect)", () => {
    const { registry } = makeRegistry(["uuid-a", "uuid-b"]);

    const first = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 1,
    });
    registry.onDeviceDisconnected("emulator-5554");
    const second = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 2,
    });

    expect(second.deviceSessionUuid).toBe("uuid-b");
    expect(second.deviceSessionUuid).not.toBe(first.deviceSessionUuid);
  });

  it("mints a NEW uuid on a fast same-serial restart (new incarnation without an intervening disconnect)", () => {
    const { registry } = makeRegistry(["uuid-a", "uuid-b"]);

    const first = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 1,
    });
    // Fast restart: the disconnect monitor never confirmed, but the pool bumped incarnation.
    const second = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 2,
    });

    expect(second.deviceSessionUuid).not.toBe(first.deviceSessionUuid);
    // The superseded epoch's uuid no longer resolves.
    expect(registry.getByUuid(first.deviceSessionUuid)).toBeUndefined();
    expect(registry.getByDeviceId("emulator-5554")?.deviceSessionUuid).toBe(
      second.deviceSessionUuid,
    );
  });

  it("supports bidirectional lookup", () => {
    const { registry } = makeRegistry(["uuid-a"]);
    const record = registry.onDeviceConnected({
      deviceId: "emulator-5554",
      platform: "android",
      incarnation: 1,
    });

    expect(registry.getByDeviceId("emulator-5554")).toEqual(record);
    expect(registry.getByUuid("uuid-a")).toEqual(record);
    expect(registry.getByDeviceId("unknown")).toBeUndefined();
    expect(registry.getByUuid("unknown")).toBeUndefined();
  });

  it("lists all live device sessions across multiple devices", () => {
    const { registry } = makeRegistry(["uuid-a", "uuid-b"]);
    registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });
    registry.onDeviceConnected({ deviceId: "00008030-001", platform: "ios", incarnation: 1 });

    const list = registry.list();

    expect(list).toHaveLength(2);
    expect(list.map((r) => r.deviceId).sort()).toEqual(["00008030-001", "emulator-5554"]);
    expect(list.find((r) => r.deviceId === "00008030-001")?.platform).toBe("ios");
  });

  describe("lifecycle listener", () => {
    type Event = {
      kind: "started" | "ended";
      uuid: string;
      deviceId: string;
      platform: string;
      successorSessionUuid?: string;
    };

    function withListener(scripted?: string[]) {
      const { registry, timer, idGenerator } = makeRegistry(scripted);
      const events: Event[] = [];
      registry.setLifecycleListener({
        onSessionStarted: (record) =>
          events.push({
            kind: "started",
            uuid: record.deviceSessionUuid,
            deviceId: record.deviceId,
            platform: record.platform,
          }),
        onSessionEnded: (record, options) =>
          events.push({
            kind: "ended",
            uuid: record.deviceSessionUuid,
            deviceId: record.deviceId,
            platform: record.platform,
            ...options,
          }),
      });
      return { registry, timer, idGenerator, events };
    }

    it("emits session_started with correct identity on a fresh connect", () => {
      const { events } = (() => {
        const ctx = withListener(["uuid-a"]);
        ctx.registry.onDeviceConnected({
          deviceId: "emulator-5554",
          platform: "android",
          incarnation: 1,
        });
        return ctx;
      })();

      expect(events).toEqual([
        { kind: "started", uuid: "uuid-a", deviceId: "emulator-5554", platform: "android" },
      ]);
    });

    it("does NOT emit for an idempotent repeat connect (same incarnation)", () => {
      const { registry, events } = withListener(["uuid-a", "uuid-b"]);
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });

      expect(events).toEqual([
        { kind: "started", uuid: "uuid-a", deviceId: "emulator-5554", platform: "android" },
      ]);
    });

    it("emits session_ended on disconnect with the retired identity", () => {
      const { registry, events } = withListener(["uuid-a"]);
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });
      registry.onDeviceDisconnected("emulator-5554");

      expect(events).toEqual([
        { kind: "started", uuid: "uuid-a", deviceId: "emulator-5554", platform: "android" },
        { kind: "ended", uuid: "uuid-a", deviceId: "emulator-5554", platform: "android" },
      ]);
    });

    it("does NOT emit session_ended when disconnecting an unknown serial", () => {
      const { registry, events } = withListener(["uuid-a"]);
      registry.onDeviceDisconnected("never-seen");
      expect(events).toEqual([]);
    });

    it("emits ended(old) then started(new) on a same-serial reincarnation", () => {
      const { registry, events } = withListener(["uuid-a", "uuid-b"]);
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 2,
      });

      expect(events).toEqual([
        { kind: "started", uuid: "uuid-a", deviceId: "emulator-5554", platform: "android" },
        {
          kind: "ended",
          uuid: "uuid-a",
          deviceId: "emulator-5554",
          platform: "android",
          successorSessionUuid: "uuid-b",
        },
        { kind: "started", uuid: "uuid-b", deviceId: "emulator-5554", platform: "android" },
      ]);
    });

    it("warns on listener faults and preserves identity across a reincarnation", () => {
      const { registry } = makeRegistry(["uuid-a", "uuid-b"]);
      const failure = new Error("stream push failed");
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      registry.setLifecycleListener({
        onSessionStarted: () => {
          throw failure;
        },
        onSessionEnded: () => {
          throw failure;
        },
      });

      try {
        const first = registry.onDeviceConnected({
          deviceId: "emulator-5554",
          platform: "android",
          incarnation: 1,
        });
        expect(registry.getByDeviceId("emulator-5554")).toEqual(first);
        expect(registry.getByUuid("uuid-a")).toEqual(first);

        const second = registry.onDeviceConnected({
          deviceId: "emulator-5554",
          platform: "android",
          incarnation: 2,
        });
        expect(registry.getByUuid("uuid-a")).toBeUndefined();
        expect(registry.getByDeviceId("emulator-5554")).toEqual(second);
        expect(registry.getByUuid("uuid-b")).toEqual(second);

        registry.onDeviceDisconnected("emulator-5554");
        expect(registry.getByDeviceId("emulator-5554")).toBeUndefined();
        expect(registry.getByUuid("uuid-b")).toBeUndefined();
        expect(warnSpy.mock.calls.map(([message]) => message)).toEqual([
          "[DeviceSessionRegistry] onSessionStarted listener threw: Error: stream push failed",
          "[DeviceSessionRegistry] onSessionEnded listener threw: Error: stream push failed",
          "[DeviceSessionRegistry] onSessionStarted listener threw: Error: stream push failed",
          "[DeviceSessionRegistry] onSessionEnded listener threw: Error: stream push failed",
        ]);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
