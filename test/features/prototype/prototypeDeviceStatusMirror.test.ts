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

describe("prototype status device status mirror", () => {
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
      battery: { values: { level: 10, state: "unplugged" }, receivedAt: 2000 },
      power: { values: { saver: true }, receivedAt: 2000, simulated: true },
    });
    if (status.platformStatus?.battery) {
      status.platformStatus.battery.receivedAt = 0;
    }
    expect(store.status(scope).platformStatus?.battery?.receivedAt).toBe(2000);
    expect(store.status({ ...scope, sessionUuid: "two" })).not.toHaveProperty("platformStatus");
  });

  test("a cleared device forgets its mirrored status", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    const scope = { deviceId: "device" };
    store.recordEvent(scope, delivered(1, { event: "audio.changed", data: { muted: true } }));
    store.clearDevice("device");
    expect(store.status(scope)).not.toHaveProperty("platformStatus");
  });
});
