import { describe, expect, test } from "bun:test";
import type { PrototypeEvent } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { InMemoryPrototypeStatusStore } from "../../../src/features/prototype/PrototypeStatusStore";
import { prototypeDeviceStatusOf } from "../../../src/features/prototype/prototypeDeviceStatusMirror";
import { event } from "../../helpers/prototypeTestEvent";
import { FakeTimer } from "../../fakes/FakeTimer";

function delivered(
  sequence: number,
  payload: PrototypeEvent["payload"],
  name = "prototype_platform_event",
): PrototypeEvent {
  return { ...event(sequence, "panel", "emit", name), payload };
}

describe("prototypeDeviceStatusOf", () => {
  test("reads each status module's changed values", () => {
    expect(
      prototypeDeviceStatusOf(
        delivered(1, { event: "battery.changed", data: { level: 10, state: "unplugged" } }),
      ),
    ).toEqual({ module: "battery", values: { level: 10, state: "unplugged" } });
    expect(
      prototypeDeviceStatusOf(
        delivered(2, {
          event: "power.changed",
          data: { saver: true, thermal: "serious" },
          simulated: true,
        }),
      ),
    ).toEqual({ module: "power", values: { saver: true, thermal: "serious" }, simulated: true });
    expect(
      prototypeDeviceStatusOf(
        delivered(3, {
          event: "audio.changed",
          data: { volume: 40, muted: false, route: "bluetooth", ringer: "vibrate" },
        }),
      ),
    ).toMatchObject({ module: "audio", values: { route: "bluetooth", ringer: "vibrate" } });
  });

  test("an absent key, such as an unknown iOS battery level, is not required", () => {
    expect(
      prototypeDeviceStatusOf(
        delivered(1, { event: "battery.changed", data: { state: "unknown" } }),
      ),
    ).toEqual({ module: "battery", values: { state: "unknown" } });
  });

  test("ignores other events and malformed or out-of-contract data", () => {
    const ignored: PrototypeEvent[] = [
      delivered(1, { event: "battery.changed", data: { level: 10 } }, "save"),
      delivered(2, { event: "connectivity.changed", data: { online: true } }),
      delivered(3, { event: "battery.other", data: { level: 10 } }),
      delivered(4, { event: "battery.changed", data: { level: 101 } }),
      delivered(5, { event: "battery.changed", data: { level: 1.5 } }),
      delivered(6, { event: "power.changed", data: { thermal: "hot" } }),
      delivered(7, { event: "power.changed", data: { saver: "yes" } }),
      delivered(8, { event: "audio.changed", data: { volume: 10, unknown: 1 } }),
      delivered(9, { event: "audio.changed", data: [1] }),
      delivered(10, { event: "audio.changed", data: { volume: 10 }, truncated: true }),
      delivered(11, { event: "audio.changed" }),
    ];
    expect(ignored.map(prototypeDeviceStatusOf)).toEqual(ignored.map(() => undefined));
  });
});

describe("prototypeDeviceStatusOf location", () => {
  test("a location.updated reading keeps only accuracy and approximate", () => {
    const reading = prototypeDeviceStatusOf(
      delivered(1, {
        event: "location.updated",
        data: {
          accuracyM: 12.5,
          approximate: false,
          latitude: 37.4,
          longitude: -122.1,
          altitudeM: 30,
          speedMps: 2,
          bearingDeg: 90,
          timestampMs: 5,
        },
        simulated: true,
      }),
    );
    expect(reading).toEqual({
      module: "location",
      values: { accuracyM: 12.5, approximate: false },
      simulated: true,
    });
    for (const key of ["latitude", "longitude", "altitudeM", "speedMps", "bearingDeg"]) {
      expect(reading?.values).not.toHaveProperty(key);
    }
  });

  test("ignores a location.updated without a valid summary", () => {
    const ignored: PrototypeEvent[] = [
      delivered(1, { event: "location.updated", data: { approximate: true } }),
      delivered(2, { event: "location.updated", data: { accuracyM: 5 } }),
      delivered(3, { event: "location.updated", data: { accuracyM: -1, approximate: true } }),
      delivered(4, { event: "location.updated", data: { accuracyM: "5", approximate: true } }),
      delivered(5, { event: "location.updated", data: [5, true] }),
      delivered(6, {
        event: "location.updated",
        data: { accuracyM: 5, approximate: true },
        truncated: true,
      }),
      delivered(
        7,
        { event: "location.updated", data: { accuracyM: 5, approximate: true } },
        "save",
      ),
    ];
    expect(ignored.map(prototypeDeviceStatusOf)).toEqual(ignored.map(() => undefined));
  });
});

describe("prototype status device status mirror", () => {
  test("mirrors the last location.updated as presence and accuracy only", () => {
    const timer = new FakeTimer();
    const store = new InMemoryPrototypeStatusStore(timer);
    const scope = { deviceId: "device" };
    timer.setCurrentTime(1000);
    store.recordEvent(
      scope,
      delivered(1, {
        event: "location.updated",
        data: { accuracyM: 30, approximate: true, latitude: 1, longitude: 2 },
      }),
    );
    store.recordEvent(
      scope,
      delivered(2, { event: "location.updated", data: { accuracyM: 4, approximate: false } }),
    );
    expect(store.status(scope).platformStatus).toEqual({
      location: { values: { accuracyM: 4, approximate: false }, timestamp: 2, receivedAt: 1000 },
    });
    expect(JSON.stringify(store.status(scope))).not.toMatch(/latitude|longitude/);
  });

  test("reports the last delivered values per module and copies them out", () => {
    const timer = new FakeTimer();
    const store = new InMemoryPrototypeStatusStore(timer);
    const scope = { deviceId: "device", sessionUuid: "one" };
    expect(store.status(scope)).not.toHaveProperty("platformStatus");
    timer.setCurrentTime(1000);
    store.recordEvent(
      scope,
      delivered(1, { event: "battery.changed", data: { level: 50, state: "charging" } }),
    );
    timer.setCurrentTime(2000);
    store.recordEvent(
      scope,
      delivered(2, { event: "battery.changed", data: { level: 10, state: "unplugged" } }),
    );
    store.recordEvent(
      scope,
      delivered(3, { event: "power.changed", data: { saver: true }, simulated: true }),
    );
    store.recordEvent(scope, delivered(4, { event: "power.changed", data: { thermal: "hot" } }));
    const status = store.status(scope);
    expect(status.platformStatus).toEqual({
      battery: { values: { level: 10, state: "unplugged" }, timestamp: 2, receivedAt: 2000 },
      power: { values: { saver: true }, timestamp: 3, receivedAt: 2000, simulated: true },
    });
    if (status.platformStatus?.battery) {
      status.platformStatus.battery.receivedAt = 0;
    }
    expect(store.status(scope).platformStatus?.battery?.receivedAt).toBe(2000);
    expect(store.status({ ...scope, sessionUuid: "two" })).not.toHaveProperty("platformStatus");
  });

  test("a replay grouped by prototype keeps the newest reading on the device clock", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    const scope = { deviceId: "device" };
    const battery = (sequence: number, id: string, level: number): PrototypeEvent => ({
      ...delivered(sequence, { event: "battery.changed", data: { level } }),
      id,
    });
    // Delivered A10, B10, A20, B20, A30; replayed grouped as A10, A20, A30, B10, B20.
    for (const replayed of [
      battery(1, "a", 10),
      battery(3, "a", 20),
      battery(5, "a", 30),
      battery(2, "b", 10),
      battery(4, "b", 20),
    ]) {
      store.recordEvent(scope, replayed);
    }
    expect(store.status(scope).platformStatus?.battery).toMatchObject({
      values: { level: 30 },
      timestamp: 5,
    });
  });

  test("a cleared device forgets its mirrored status", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    const scope = { deviceId: "device" };
    store.recordEvent(scope, delivered(1, { event: "audio.changed", data: { muted: true } }));
    store.clearDevice("device");
    expect(store.status(scope)).not.toHaveProperty("platformStatus");
  });
});
