import { expect, test } from "bun:test";
import {
  InMemoryDeviceHealthMarkers,
  NotifyingDeviceHealthMarkers,
} from "../../src/daemon/deviceHealthMarkers";
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

test("#12112 list returns all current markers oldest first and reflects reason clearing", () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(1234);
  const markers = new InMemoryDeviceHealthMarkers(timer);
  const oldest = markers.mark("device", 2, "app-cleanup");
  timer.setCurrentTime(2345);
  const newest = markers.mark("device", 2, "network-condition");
  expect(markers.list("device", 2)).toEqual([oldest, newest]);
  expect(markers.get("device", 2)).toEqual(markers.list("device", 2)[0]);
  expect(markers.list("device", 1)).toEqual([]);
  expect(markers.list("unknown", 2)).toEqual([]);
  expect(markers.list("device", 2)).toEqual([oldest, newest]);
  markers.clear("device", 2, "app-cleanup");
  expect(markers.list("device", 2)).toEqual([newest]);
  expect(markers.list("device", 3)).toEqual([]);
  expect(markers.list("device", 2)).toEqual([]);
});

test("#12112 notifying list delegates without a notification even when dropping stale markers", () => {
  const inner = new InMemoryDeviceHealthMarkers(new FakeTimer());
  const oldest = inner.mark("device", 2, "clock");
  const newest = inner.mark("device", 2, "network-condition");
  const notifications: string[] = [];
  const markers = new NotifyingDeviceHealthMarkers(inner, (id) => notifications.push(id));
  expect(markers.list("device", 2)).toEqual([oldest, newest]);
  expect(markers.list("device", 1)).toEqual([]);
  expect(markers.list("unknown", 2)).toEqual([]);
  markers.clear("device", 2, "clock");
  expect(notifications).toEqual(["device"]);
  expect(markers.list("device", 2)).toEqual([newest]);
  expect(markers.list("device", 3)).toEqual([]);
  expect(inner.get("device", 2)).toBeUndefined();
  expect(notifications).toEqual(["device"]);
});
