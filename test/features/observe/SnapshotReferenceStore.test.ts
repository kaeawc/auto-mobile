import { resolveIosObserveRotation } from "../../../src/features/observe/iosObserveRotation";
import { afterEach, describe, expect, test } from "bun:test";
import {
  hasSameTapTargetingLayout,
  SnapshotReferenceStore,
  snapshotReferenceUnavailable,
} from "../../../src/features/observe/SnapshotReferenceStore";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { setDeviceIncarnationResolver } from "../../../src/utils/deviceIncarnation";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { observation } from "../../helpers/tapAtCoordinate";
import { loadDiffFixture, loadIosFractionalObserve } from "../../fixtures/observe/observeFixture";
import iosCapturedHierarchy from "../../fixtures/ios-duo/issue8379-demos-raw-hierarchy.json";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { flattenForDiff } from "../../../src/features/observe/output/resultOutput/hierarchy";
import { attachRawViewHierarchy } from "../../../src/utils/viewHierarchySearch";

const captured: ObserveResult = {
  observationId: "captured",
  updatedAt: 0,
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  display: { key: "main", role: "unknown", posture: "opened", generation: 0 },
  displayRevision: 4,
  screenSize: { width: 100, height: 200 },
  rotation: 0,
  activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
  viewHierarchy: {
    hierarchy: {},
    frameContext: "frame-1",
    nativeScale: 2,
    packageName: "com.example",
  },
};

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

function capturedAndroid(): ObserveResult {
  const fixture = loadDiffFixture("scroll-before");
  return {
    ...fixture,
    display: captured.display,
    viewHierarchy: { ...fixture.viewHierarchy!, nativeScale: 1, frameContext: "epoch:1" },
  };
}

function hostCappedObservation(location: "observation" | "hierarchy" | "window") {
  const complete = observation(100, 200, "frame-123", 0, {
    node: Array.from({ length: 70 }, (_, index) => ({
      class: "android.widget.Button",
      bounds: { left: 0, top: index * 2, right: 100, bottom: index * 2 + 2 },
      clickable: true,
    })),
  });
  const raw = complete.viewHierarchy!;
  raw.windows = [{ hierarchy: structuredClone(raw.hierarchy.node!) }];
  const rendered = structuredClone(complete);
  const hierarchy = rendered.viewHierarchy!;
  hierarchy.hierarchy.node!.node = hierarchy.hierarchy.node!.node!.slice(0, 64);
  hierarchy.windows![0].hierarchy!.node = hierarchy.windows![0].hierarchy!.node!.slice(0, 64);
  const reasons = ["max_children[node kept 64 of 70]"];
  if (location === "observation") {
    rendered.truncationReasons = reasons;
  } else if (location === "hierarchy") {
    hierarchy.truncationReasons = reasons;
  } else {
    hierarchy.windows![0].truncationReasons = reasons;
  }
  attachRawViewHierarchy(hierarchy, raw);
  return { rendered, raw, reasons };
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

  test("captures targeting layout by value and ignores volatile capture fields", () => {
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const original = observation(100, 200, "epoch:1", 0, {
      bounds: { left: 0, top: 0, right: 50, bottom: 50 },
      "view-id": "first",
      extras: { timestamp: 1 },
    });
    const ref = captureReference(store, "device-1", original);
    const identical = {
      ...observation(100, 200, "epoch:2", 0, {
        bounds: { left: 0, top: 0, right: 50, bottom: 50 },
        "view-id": "second",
        extras: { timestamp: 2 },
      }),
      observationId: "second",
      updatedAt: 2,
    };
    expect(store.staleReason(ref.snapshotId, "device-1", identical)).toBeUndefined();
    // Mutation after capture must not rewrite the stored targeting layout.
    original.systemInsets.top = 1;
    expect(store.staleReason(ref.snapshotId, "device-1", original)).toContain(
      "tap-targeting layout changed",
    );
    original.systemInsets.top = 0;
    original.viewHierarchy!.hierarchy.node!.bounds!.right = 90;
    expect(store.staleReason(ref.snapshotId, "device-1", original)).toBe(
      "Snapshot reference is stale (tap-targeting layout changed); re-observe.",
    );
  });

  test("accepts captured Android clock and battery updates across a minute boundary", () => {
    const original = capturedAndroid();
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "android", original);
    const refreshed = structuredClone(original);
    const nodes = flattenForDiff(refreshed).map(({ source }) => source);
    const clock = nodes.find((node) => node["resource-id"] === "com.android.systemui:id/clock")!;
    const battery = nodes.find(
      (node) => node["resource-id"] === "com.android.systemui:id/battery",
    )!;
    expect(clock.text).toBe("9:02");
    expect(battery["content-desc"]).toBe("Battery 100 percent.");
    clock.text = "9:03";
    clock["content-desc"] = "9:03 PM";
    battery["content-desc"] = "Battery 99 percent.";
    expect(store.staleReason(ref.snapshotId, "android", refreshed)).toBeUndefined();
    // Chrome can reflow or add/remove icons without retargeting app coordinates.
    clock.bounds!.right += 10;
    battery.node = [];
    const { top, bottom, left, right } = refreshed.systemInsets;
    refreshed.systemInsets = { bottom, right, top, left };
    expect(store.staleReason(ref.snapshotId, "android", refreshed)).toBeUndefined();
  });

  test("ignores captured app labels, values, state and screen identity keys", () => {
    const original = capturedAndroid();
    original.screenIdentity = {
      platform: "android",
      source: "sdk",
      confidence: "high",
      key: "first",
      components: {},
    };
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "android", original);
    const refreshed = structuredClone(original);
    for (const { source } of flattenForDiff(refreshed)) {
      Object.assign(source, {
        text: "00:42",
        "content-desc": "Progress 42%",
        value: "42",
        selected: true,
        checked: true,
        "state-description": "playing",
      });
    }
    refreshed.screenIdentity!.key = "second";
    expect(store.staleReason(ref.snapshotId, "android", refreshed)).toBeUndefined();
  });

  test.each([
    "bounds",
    "structure",
    "className",
    "role",
    "clickable",
    "enabled",
    "visible-to-user",
    "actions",
    "scrollable",
    "resource-id",
  ] as const)("rejects captured Android %s changes with the same frame geometry", (field) => {
    const original = capturedAndroid();
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "android", original);
    const refreshed = structuredClone(original);
    const target = flattenForDiff(refreshed).find(
      ({ source }) => source["resource-id"] === "navigation.HomeDestination",
    )!.source;
    if (field === "bounds") {
      target.bounds!.right -= 100;
    } else if (field === "structure") {
      target.node = [];
    } else if (field === "visible-to-user") {
      Object.assign(target, { "visible-to-user": false });
    } else if (field === "actions") {
      target.actions = ["click", "focus"];
    } else if (field === "scrollable") {
      target.scrollable = !target.scrollable;
    } else {
      Object.assign(target, {
        [field]: field === "clickable" || field === "enabled" ? false : "changed",
      });
    }
    expect(store.staleReason(ref.snapshotId, "android", refreshed)).toContain(
      "tap-targeting layout changed",
    );
  });

  test("accepts reordered actions without mutating the captured array", () => {
    const original = observation(100, 200, "frame-123", 0, { actions: ["focus", "click"] });
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "device-1", original);
    expect(original.viewHierarchy!.hierarchy.node!.actions).toEqual(["focus", "click"]);
    const refreshed = structuredClone(original);
    refreshed.viewHierarchy!.hierarchy.node!.actions = ["click", "focus"];
    expect(store.staleReason(ref.snapshotId, "device-1", refreshed)).toBeUndefined();
    expect(original.viewHierarchy!.hierarchy.node!.actions).toEqual(["focus", "click"]);
  });

  test("rejects pinch-style bounds changes in a captured iOS hierarchy", () => {
    const original: ObserveResult = {
      ...captured,
      screenSize: {
        width: iosCapturedHierarchy.screenWidth,
        height: iosCapturedHierarchy.screenHeight,
      },
      viewHierarchy: structuredClone(iosCapturedHierarchy) as ViewHierarchyResult,
    };
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "ios", original);
    const refreshed = structuredClone(original);
    const target = flattenForDiff(refreshed).find(({ source }) => source.role === "text")!.source;
    target.bounds!.right += 12.5;
    expect(store.staleReason(ref.snapshotId, "ios", refreshed)).toContain(
      "tap-targeting layout changed",
    );
  });

  test.each(["observation", "hierarchy", "window"] as const)(
    "issues and validates a reference with only %s host-output truncation",
    (location) => {
      const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
      const { rendered: complete, raw, reasons } = hostCappedObservation(location);
      expect(snapshotReferenceUnavailable(complete)).toEqual([]);
      const ref = captureReference(store, "device-1", complete);
      const refreshed = structuredClone(complete);
      attachRawViewHierarchy(refreshed.viewHierarchy!, structuredClone(raw));
      expect(store.staleReason(ref.snapshotId, "device-1", refreshed)).toBeUndefined();
      expect(hasSameTapTargetingLayout(complete, refreshed)).toBe(true);
      reasons.push("max_children");
      expect(store.capture("device-1", complete)).toEqual({
        status: "unavailable",
        missing: ["completeHierarchy"],
      });
      expect(store.staleReason(ref.snapshotId, "device-1", complete)).toContain(
        "hierarchy capture was incomplete",
      );
    },
  );

  test.each(["tree", "windows"] as const)(
    "rejects changes beyond the host cap in the raw %s",
    (section) => {
      const { rendered, raw } = hostCappedObservation("hierarchy");
      const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
      const ref = captureReference(store, "device-1", rendered);
      const refreshed = structuredClone(rendered);
      const refreshedRaw = structuredClone(raw);
      attachRawViewHierarchy(refreshed.viewHierarchy!, refreshedRaw);
      expect(store.staleReason(ref.snapshotId, "device-1", refreshed)).toBeUndefined();
      const root =
        section === "tree" ? refreshedRaw.hierarchy.node! : refreshedRaw.windows![0].hierarchy!;
      root.node![69].bounds!.right -= 10;
      expect(store.staleReason(ref.snapshotId, "device-1", refreshed)).toContain(
        "tap-targeting layout changed",
      );
    },
  );

  test.each(["observation", "hierarchy", "window"] as const)(
    "fails closed for %s host-output truncation without a raw carrier",
    (location) => {
      const { rendered } = hostCappedObservation(location);
      const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
      const ref = captureReference(store, "device-1", rendered);
      const withoutRaw = structuredClone(rendered);
      expect(snapshotReferenceUnavailable(withoutRaw)).toEqual(["completeHierarchy"]);
      expect(store.capture("device-1", withoutRaw)).toEqual({
        status: "unavailable",
        missing: ["completeHierarchy"],
      });
      expect(store.staleReason(ref.snapshotId, "device-1", withoutRaw)).toContain(
        "hierarchy capture was incomplete",
      );
    },
  );

  test("hashes the rendered projection when there is no host-output truncation", () => {
    const { rendered, raw } = hostCappedObservation("hierarchy");
    delete rendered.viewHierarchy!.truncationReasons;
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const ref = captureReference(store, "device-1", rendered);
    const refreshed = structuredClone(rendered);
    const refreshedRaw = structuredClone(raw);
    refreshedRaw.hierarchy.node!.node![69].bounds!.right -= 10;
    attachRawViewHierarchy(refreshed.viewHierarchy!, refreshedRaw);
    expect(store.staleReason(ref.snapshotId, "device-1", refreshed)).toBeUndefined();
    refreshed.viewHierarchy!.hierarchy.node!.node![0].bounds!.right -= 10;
    expect(store.staleReason(ref.snapshotId, "device-1", refreshed)).toContain(
      "tap-targeting layout changed",
    );
  });

  test.each(["observation", "hierarchy", "window"])(
    "does not issue a reference for %s truncation",
    (location) => {
      const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
      const truncated = observation(100, 200);
      if (location === "observation") {
        truncated.truncationReasons = ["max_nodes"];
      } else if (location === "hierarchy") {
        truncated.viewHierarchy!.truncationReasons = ["max_depth"];
      } else {
        truncated.viewHierarchy!.windows = [{ truncationReasons: ["max_nodes"] }];
      }
      expect(store.capture("device-1", truncated)).toEqual({
        status: "unavailable",
        missing: ["completeHierarchy"],
      });
      expect(store.size).toBe(0);
    },
  );

  test("rejects a previously complete reference when the current hierarchy is truncated", () => {
    const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
    const complete = observation(100, 200);
    const ref = captureReference(store, "device-1", complete);
    expect(
      store.staleReason(ref.snapshotId, "device-1", {
        ...complete,
        truncationReasons: ["max_nodes"],
      }),
    ).toBe(
      "Snapshot layout is unavailable. The hierarchy capture was incomplete; observe again, or use a selector or coordinates without a snapshotId.",
    );
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

test("iOS size fallback mints references without synthesizing hierarchy rotation", () => {
  const fixture = loadIosFractionalObserve();
  const ios = {
    ...fixture,
    rotation: resolveIosObserveRotation(undefined, fixture.screenSize),
    viewHierarchy: {
      ...fixture.viewHierarchy!,
      rotation: undefined,
      nativeScale: 3,
      frameContext: `${androidEpoch}:1:abc`,
    },
  };
  const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator());
  expect(snapshotReferenceUnavailable(ios)).toEqual([]);
  const ref = captureReference(store, "ios-fallback", ios);
  expect(store.staleReason(ref.snapshotId, "ios-fallback", ios)).toBeUndefined();
  expect(store.staleReason(ref.snapshotId, "ios-fallback", { ...ios, rotation: 1 })).toContain(
    "rotation",
  );
  expect(ios.viewHierarchy.rotation).toBeUndefined();
});
