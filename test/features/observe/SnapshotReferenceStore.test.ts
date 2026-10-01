import { afterEach, describe, expect, test } from "bun:test";
import {
  SnapshotReferenceStore,
  snapshotReferenceUnavailable,
} from "../../../src/features/observe/SnapshotReferenceStore";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { setDeviceIncarnationResolver } from "../../../src/utils/deviceIncarnation";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { loadIosFractionalObserve } from "../../fixtures/observe/observeFixture";

const captured = {
  display: { key: "main", role: "unknown", posture: "flat" },
  displayRevision: 4,
  screenSize: { width: 100, height: 200 },
  rotation: 0,
  activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
  viewHierarchy: { frameContext: "frame-1", nativeScale: 2, packageName: "com.example" },
} as ObserveResult;

function captureReference(
  store: SnapshotReferenceStore,
  deviceId: string,
  observation: ObserveResult,
) {
  const result = store.capture(deviceId, observation);
  expect(result.status).toBe("captured");
  if (result.status !== "captured") {
    throw new Error(`Missing: ${result.missing.join(", ")}`);
  }
  return result.reference;
}

const androidEpoch = "123e4567-e89b-42d3-a456-426614174000";
const nextEpoch = "123e4567-e89b-42d3-a456-426614174001";

describe("SnapshotReferenceStore", () => {
  afterEach(() => setDeviceIncarnationResolver(undefined));

  test("rejects device reassignment, restart, rotation, scale, bounds and window changes", () => {
    let incarnation = 1;
    setDeviceIncarnationResolver(() => incarnation);
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator("ref"));
    const ref = captureReference(store, "device-1", captured);
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
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        activeWindow: { ...captured.activeWindow!, activityName: ".Settings" },
      }),
    ).toContain("activityName");
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        activeWindow: { ...captured.activeWindow!, appId: "com.other" },
      }),
    ).toContain("appId");
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        viewHierarchy: { ...captured.viewHierarchy!, packageName: "com.other" },
      }),
    ).toContain("hierarchyPackage");
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        viewHierarchy: {
          ...captured.viewHierarchy!,
          windows: [{ id: 7, isFocused: true, packageName: "com.example" }],
        },
      }),
    ).toBeUndefined();
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        display: { ...captured.display, key: "cover" },
      }),
    ).toContain("displayKey");
  });

  test("reuses a reference when only event and observation counters advance", () => {
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "device-1", captured);
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...captured,
        observationId: "next-observation",
        updatedAt: 999,
        displayRevision: 4,
        activeWindow: { ...captured.activeWindow!, layoutSeqSum: 2 },
        viewHierarchy: { ...captured.viewHierarchy!, frameContext: "frame-2", captureSequence: 8 },
      }),
    ).toBeUndefined();
    expect(
      store.staleReason(ref.snapshotId, "device-1", { ...captured, displayRevision: 5 }),
    ).toBeUndefined();
  });

  test("treats unknown activity and a missing focused window as non-conflicting", () => {
    const withWindow: ObserveResult = {
      ...captured,
      activeWindow: { ...captured.activeWindow!, activityName: ".Main", type: "application" },
      viewHierarchy: {
        ...captured.viewHierarchy!,
        windows: [
          {
            id: 7,
            type: 1,
            isFocused: true,
            packageName: "com.example",
            bounds: { left: 0, top: 0, right: 100, bottom: 200 },
          },
        ],
      },
    };
    const unknown: ObserveResult = {
      ...withWindow,
      activeWindow: { ...withWindow.activeWindow!, activityName: "", type: undefined },
      viewHierarchy: { ...withWindow.viewHierarchy!, windows: undefined },
    };
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const named = captureReference(store, "device-1", withWindow);
    const bootstrap = captureReference(store, "device-1", unknown);
    expect(store.staleReason(named.snapshotId, "device-1", unknown)).toBeUndefined();
    expect(store.staleReason(bootstrap.snapshotId, "device-1", withWindow)).toBeUndefined();
    expect(
      store.staleReason(named.snapshotId, "device-1", {
        ...withWindow,
        activeWindow: { ...withWindow.activeWindow!, activityName: ".Settings" },
      }),
    ).toContain("activityName");
  });

  test("rejects each changed window and display fact when both captures provide it", () => {
    const original: ObserveResult = {
      ...captured,
      activeWindow: { ...captured.activeWindow!, type: "application" },
      viewHierarchy: {
        ...captured.viewHierarchy!,
        windows: [
          {
            id: 7,
            type: 1,
            isFocused: true,
            packageName: "com.example",
            bounds: { left: 0, top: 0, right: 100, bottom: 200 },
          },
        ],
      },
    };
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "device-1", original);
    for (const [field, next] of [
      [
        "focusedWindowId",
        {
          viewHierarchy: {
            ...original.viewHierarchy!,
            windows: [
              {
                ...original.viewHierarchy!.windows![0]!,
                id: 8,
              },
            ],
          },
        },
      ],
      [
        "focusedWindowBounds",
        {
          viewHierarchy: {
            ...original.viewHierarchy!,
            windows: [
              {
                ...original.viewHierarchy!.windows![0]!,
                bounds: { left: 1, top: 0, right: 100, bottom: 200 },
              },
            ],
          },
        },
      ],
      [
        "focusedWindowType",
        {
          viewHierarchy: {
            ...original.viewHierarchy!,
            windows: [
              {
                ...original.viewHierarchy!.windows![0]!,
                type: 2,
              },
            ],
          },
        },
      ],
      [
        "focusedWindowPackage",
        {
          viewHierarchy: {
            ...original.viewHierarchy!,
            windows: [
              {
                ...original.viewHierarchy!.windows![0]!,
                packageName: "com.other",
              },
            ],
          },
        },
      ],
      ["windowType", { activeWindow: { ...original.activeWindow!, type: "dialog" } }],
      ["displayRole", { display: { ...original.display, role: "outer" } }],
      ["displayPosture", { display: { ...original.display, posture: "closed" } }],
    ] as const) {
      expect(
        store.staleReason(ref.snapshotId, "device-1", { ...original, ...next } as ObserveResult),
      ).toContain(field);
    }
  });

  test("binds only the Android runner epoch, not its event counter", () => {
    const initial = {
      ...captured,
      viewHierarchy: { ...captured.viewHierarchy!, frameContext: `${androidEpoch}:1` },
    };
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "device-1", initial);
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...initial,
        viewHierarchy: { ...initial.viewHierarchy, frameContext: `${androidEpoch}:2` },
      }),
    ).toBeUndefined();
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...initial,
        viewHierarchy: { ...initial.viewHierarchy, frameContext: `${nextEpoch}:1` },
      }),
    ).toContain("runner restarted");
  });

  test("binds an iOS points capture to rotation, size and native scale", () => {
    const fixture = loadIosFractionalObserve();
    const ios: ObserveResult = {
      ...fixture,
      rotation: 0,
      viewHierarchy: {
        ...fixture.viewHierarchy!,
        frameContext: `${androidEpoch}:1:abc123`,
        nativeScale: 3,
        pixelWidth: 1179,
        pixelHeight: 2556,
        rotation: 0,
      },
    };
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "ios-device", ios);
    expect(ref.snapshotId).toBeTruthy();
    expect(store.staleReason(ref.snapshotId, "ios-device", ios)).toBeUndefined();
    expect(
      store.staleReason(ref.snapshotId, "ios-device", {
        ...ios,
        viewHierarchy: { ...ios.viewHierarchy!, frameContext: `${androidEpoch}:2:def456` },
      }),
    ).toBeUndefined();
    expect(
      store.staleReason(ref.snapshotId, "ios-device", {
        ...ios,
        viewHierarchy: { ...ios.viewHierarchy!, frameContext: `${nextEpoch}:1:abc123` },
      }),
    ).toContain("runner restarted");
    expect(store.staleReason(ref.snapshotId, "ios-device", { ...ios, rotation: 1 })).toContain(
      "rotation",
    );
    expect(
      store.staleReason(ref.snapshotId, "ios-device", {
        ...ios,
        screenSize: { width: 400, height: 852 },
      }),
    ).toContain("width");
    expect(
      store.staleReason(ref.snapshotId, "ios-device", {
        ...ios,
        viewHierarchy: { ...ios.viewHierarchy!, nativeScale: 2 },
      }),
    ).toContain("nativeScale");
  });

  test("expires at the deadline and bounds capacity", () => {
    const timer = new FakeTimer();
    const store = new SnapshotReferenceStore(timer, new CountingIdGenerator());
    const first = captureReference(store, "device-1", captured);
    for (let index = 0; index < 130; index++) {
      store.capture("device-1", captured);
    }
    expect(store.size).toBe(128);
    expect(store.staleReason(first.snapshotId, "device-1", captured)).toContain("evicted");
    const latest = captureReference(store, "device-1", captured);
    timer.advanceTime(300_000);
    expect(store.staleReason(latest.snapshotId, "device-1", captured)).toContain("expired");
    store.capture("device-1", captured);
    expect(store.size).toBe(1);
  });

  test.each([
    ["display", { ...captured, display: { ...captured.display, key: "" } }],
    ["screenSize", { ...captured, screenSize: { width: 0, height: 200 } }],
    ["rotation", { ...captured, rotation: undefined }],
    [
      "nativeScale",
      { ...captured, viewHierarchy: { ...captured.viewHierarchy!, nativeScale: undefined } },
    ],
    [
      "frameContext",
      { ...captured, viewHierarchy: { ...captured.viewHierarchy!, frameContext: undefined } },
    ],
  ] as const)("reports missing %s", (field, observation) => {
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    expect(snapshotReferenceUnavailable(observation)).toEqual([field]);
    expect(store.capture("device-1", observation)).toEqual({
      status: "unavailable",
      missing: [field],
    });
    expect(store.size).toBe(0);
  });

  test("keeps the existing numeric validity and hierarchy rotation fallback rules", () => {
    for (const screenSize of [
      { width: Infinity, height: 200 },
      { width: 100, height: NaN },
      { width: 100, height: -1 },
    ]) {
      expect(snapshotReferenceUnavailable({ ...captured, screenSize })).toEqual(["screenSize"]);
    }
    for (const rotation of [NaN, Infinity, 0.5]) {
      expect(snapshotReferenceUnavailable({ ...captured, rotation })).toEqual(["rotation"]);
    }
    for (const nativeScale of [NaN, Infinity, 0, -1]) {
      expect(
        snapshotReferenceUnavailable({
          ...captured,
          viewHierarchy: { ...captured.viewHierarchy!, nativeScale },
        }),
      ).toEqual(["nativeScale"]);
    }
    const fallback = {
      ...captured,
      rotation: undefined,
      viewHierarchy: { ...captured.viewHierarchy!, rotation: 0 },
    };
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    expect(snapshotReferenceUnavailable(fallback)).toEqual([]);
    const reference = captureReference(store, "device-1", fallback);
    expect(
      store.staleReason(reference.snapshotId, "device-1", {
        ...captured,
        rotation: undefined,
      }),
    ).toBe("Snapshot geometry or frame context is unavailable; re-observe.");
  });

  test("lists all missing preconditions in stable order", () => {
    const observation: ObserveResult = {
      ...captured,
      display: { ...captured.display, key: "" },
      screenSize: { width: NaN, height: 0 },
      rotation: undefined,
      viewHierarchy: undefined,
    };
    const missing = ["display", "screenSize", "rotation", "nativeScale", "frameContext"];
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    expect(snapshotReferenceUnavailable(observation)).toEqual(missing);
    expect(store.capture("device-1", observation)).toEqual({ status: "unavailable", missing });
  });

  test("captures complete geometry without mutating the observation", () => {
    const observation = { ...captured };
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator("ref"));
    expect(snapshotReferenceUnavailable(observation)).toEqual([]);
    expect(store.capture("device-1", observation)).toEqual({
      status: "captured",
      reference: { snapshotId: "ref-1", expiresAt: 300_000 },
    });
    expect(observation).not.toHaveProperty("snapshotReferenceUnavailable");
  });
});
