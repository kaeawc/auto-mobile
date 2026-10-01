import { afterEach, describe, expect, test } from "bun:test";
import { SnapshotReferenceStore } from "../../../src/features/observe/SnapshotReferenceStore";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { setDeviceIncarnationResolver } from "../../../src/utils/deviceIncarnation";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

const captured = {
  display: { key: "main", role: "unknown", posture: "flat" },
  displayRevision: 4,
  screenSize: { width: 100, height: 200 },
  rotation: 0,
  viewHierarchy: { frameContext: "frame-1", nativeScale: 2 },
} as ObserveResult;

describe("SnapshotReferenceStore", () => {
  afterEach(() => setDeviceIncarnationResolver(undefined));

  test("rejects device reassignment, restart, rotation, scale, bounds, revision and frame changes", () => {
    let incarnation = 1;
    setDeviceIncarnationResolver(() => incarnation);
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator("ref"));
    const ref = store.capture("device-1", captured)!;
    expect(store.staleReason(ref.snapshotId, "device-1", captured)).toBeUndefined();
    expect(store.staleReason(ref.snapshotId, "device-2", captured)).toContain("deviceId");
    incarnation = 2;
    expect(store.staleReason(ref.snapshotId, "device-1", captured)).toContain("incarnation");
    incarnation = 1;
    expect(store.staleReason(ref.snapshotId, "device-1", { ...captured, rotation: 1 })).toContain(
      "rotation",
    );
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        viewHierarchy: { ...captured.viewHierarchy!, nativeScale: 3 },
      }),
    ).toContain("nativeScale");
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        screenSize: { width: 110, height: 200 },
      }),
    ).toContain("width");
    expect(
      store.staleReason(ref.snapshotId, "device-1", { ...captured, displayRevision: 5 }),
    ).toContain("displayRevision");
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        viewHierarchy: { ...captured.viewHierarchy!, frameContext: "frame-2" },
      }),
    ).toContain("frameContext");
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        display: { ...captured.display, key: "cover" },
      }),
    ).toContain("displayKey");
  });

  test("expires at the deadline and bounds capacity", () => {
    const timer = new FakeTimer();
    const store = new SnapshotReferenceStore(timer, new CountingIdGenerator());
    const first = store.capture("device-1", captured)!;
    for (let index = 0; index < 130; index++) {
      store.capture("device-1", captured);
    }
    expect(store.size).toBe(128);
    expect(store.staleReason(first.snapshotId, "device-1", captured)).toContain("evicted");
    const latest = store.capture("device-1", captured)!;
    timer.advanceTime(300_000);
    expect(store.staleReason(latest.snapshotId, "device-1", captured)).toContain("expired");
    store.capture("device-1", captured);
    expect(store.size).toBe(1);
  });

  test("does not mint a reference without verifiable geometry or frame context", () => {
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    expect(store.capture("device-1", { ...captured, viewHierarchy: undefined })).toBeUndefined();
    expect(
      store.capture("device-1", {
        ...captured,
        viewHierarchy: { ...captured.viewHierarchy!, nativeScale: undefined },
      }),
    ).toBeUndefined();
    expect(
      store.capture("device-1", { ...captured, screenSize: { width: 0, height: 200 } }),
    ).toBeUndefined();
  });
});
