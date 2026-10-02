import { expect, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { FakeTimer } from "../fakes/FakeTimer";

test("health reasons are incarnation scoped, timestamped, and cleared independently", () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(1234);
  const markers = new InMemoryDeviceHealthMarkers(timer);
  markers.mark("device", 1, "clock");
  timer.setCurrentTime(2345);
  markers.mark("device", 1, "network-condition");
  expect(markers.get("device", 1)).toEqual({ reason: "clock", since: 1234 });
  markers.clear("device", 1, "clock");
  expect(markers.get("device", 1)).toEqual({ reason: "network-condition", since: 2345 });
  expect(markers.get("device", 2)).toBeUndefined();
  expect(markers.get("device", 1)).toBeUndefined();
  markers.mark("device", 2, "biometric-enrollment");
  expect(markers.get("device", 1)).toBeUndefined();
  markers.mark("device", 1, "clock");
  expect(markers.get("device", 2)?.reason).toBe("biometric-enrollment");
  markers.clear("device");
  expect(markers.get("device", 2)).toBeUndefined();
});
