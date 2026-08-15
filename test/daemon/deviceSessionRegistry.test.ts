import { describe, expect, it } from "bun:test";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

function makeRegistry(scripted?: string[]) {
  const timer = new FakeTimer();
  const idGenerator = new FakeIdGenerator(scripted);
  const registry = new DeviceSessionRegistry(timer, idGenerator);
  return { registry, timer, idGenerator };
}

describe("DeviceSessionRegistry", () => {
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

    const first = registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });
    const second = registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });

    expect(second.deviceSessionUuid).toBe(first.deviceSessionUuid);
    // Only one uuid was consumed; the second scripted id is still pending.
    expect(idGenerator.pendingCount()).toBe(1);
  });

  it("retires the record on disconnect (lookups return undefined)", () => {
    const { registry } = makeRegistry(["uuid-a"]);
    const record = registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });

    registry.onDeviceDisconnected("emulator-5554");

    expect(registry.getByDeviceId("emulator-5554")).toBeUndefined();
    expect(registry.getByUuid(record.deviceSessionUuid)).toBeUndefined();
  });

  it("mints a NEW uuid on reconnect of the same serial (disconnect then connect)", () => {
    const { registry } = makeRegistry(["uuid-a", "uuid-b"]);

    const first = registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });
    registry.onDeviceDisconnected("emulator-5554");
    const second = registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 2 });

    expect(second.deviceSessionUuid).toBe("uuid-b");
    expect(second.deviceSessionUuid).not.toBe(first.deviceSessionUuid);
  });

  it("mints a NEW uuid on a fast same-serial restart (new incarnation without an intervening disconnect)", () => {
    const { registry } = makeRegistry(["uuid-a", "uuid-b"]);

    const first = registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });
    // Fast restart: the disconnect monitor never confirmed, but the pool bumped incarnation.
    const second = registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 2 });

    expect(second.deviceSessionUuid).not.toBe(first.deviceSessionUuid);
    // The superseded epoch's uuid no longer resolves.
    expect(registry.getByUuid(first.deviceSessionUuid)).toBeUndefined();
    expect(registry.getByDeviceId("emulator-5554")?.deviceSessionUuid).toBe(second.deviceSessionUuid);
  });

  it("supports bidirectional lookup", () => {
    const { registry } = makeRegistry(["uuid-a"]);
    const record = registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });

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
    expect(list.map(r => r.deviceId).sort()).toEqual(["00008030-001", "emulator-5554"]);
    expect(list.find(r => r.deviceId === "00008030-001")?.platform).toBe("ios");
  });
});
