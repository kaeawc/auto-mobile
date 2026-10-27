import { wireHierarchyFrom } from "../../../helpers/androidHierarchyConverter";
import { describe, expect, test } from "bun:test";
import {
  AndroidHierarchyUpdateHandler,
  compactifyNode,
  type AndroidHierarchyUpdateContext,
} from "../../../../src/features/observe/android/AndroidHierarchyUpdateHandler";
import type {
  AccessibilityHierarchy,
  CachedHierarchy,
} from "../../../../src/features/observe/android/types";
import { FakeTimer } from "../../../fakes/FakeTimer";

function frame(updatedAt: number): AccessibilityHierarchy {
  return wireHierarchyFrom({ updatedAt, packageName: "com.example", windows: [] });
}

function harness(cached: CachedHierarchy | null = null) {
  const calls: string[] = [];
  const state = { cached, foreground: null as string | null };
  const unused = (): never => {
    throw new Error("unused in this test");
  };
  const context: AndroidHierarchyUpdateContext = {
    timer: new FakeTimer(),
    deviceId: "emu",
    transientObserver: true,
    hierarchy: {
      resolvePendingHierarchy: () => {
        calls.push("resolve");
      },
      hasSeenCorrelatedFrames: () => false,
    },
    observerHierarchyRequestIds: new Map<string, boolean>(),
    hierarchyObservationStreamSuppressions: new Map(),
    sdkNavigationAppIds: new Set<string>(),
    get cachedHierarchy() {
      return state.cached;
    },
    set cachedHierarchy(value: CachedHierarchy | null) {
      state.cached = value;
    },
    get lastForegroundPackage() {
      return state.foreground;
    },
    set lastForegroundPackage(value: string | null) {
      state.foreground = value;
    },
    removeHierarchyObservationStreamSuppression: () => false,
    updateCachedScreenDimensions: () => {
      calls.push("dimensions");
    },
    pushHierarchyToObservationStream: () => {
      calls.push("push");
    },
    startScreenshotBackoff: () => {
      calls.push("backoff");
    },
    getNavigationGraphManager: unused,
    ensureBuildContext: unused,
    getHierarchyNavigationDetector: unused,
  };
  return {
    handler: new AndroidHierarchyUpdateHandler(context),
    calls,
    state,
  };
}

describe("AndroidHierarchyUpdateHandler", () => {
  test("a transient observer resolves its waiter but never touches the shared cache", () => {
    const { handler, calls, state } = harness();
    handler.handle(frame(5));
    expect(calls).toEqual(["resolve"]);
    expect(state.cached).toBeNull();
  });
});

describe("compactifyNode", () => {
  test("keeps only display properties and recurses into children", () => {
    expect(
      compactifyNode({
        className: "A",
        "resource-id": "id",
        text: "t",
        bounds: "x",
        scrollable: "true",
        node: [{ className: "B" }],
      } as never),
    ).toEqual({
      className: "A",
      "resource-id": "id",
      text: "t",
      scrollable: "true",
      node: [{ className: "B" }],
    });
  });
});
