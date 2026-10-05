import {
  recordObservationRead,
  wasHierarchyReadDuringCall,
  withObservationReadScope,
} from "../../../src/features/observe/observationReadScope";
import { ViewHierarchyCaptureReader } from "../../../src/features/observe/ViewHierarchyCaptureReader";
import { projectActionableHierarchy } from "../../../src/features/observe/HierarchyNormalization";
import { RealSettleObserve } from "../../../src/features/observe/SettleObserve";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { describe, expect, test } from "bun:test";
import {
  DefaultHierarchyCapture,
  getHierarchySnapshot,
  identifyObservedHierarchy,
  inheritHierarchySnapshot,
  type HierarchyCaptureReader,
} from "../../../src/features/observe/HierarchyCapture";
import type { ViewHierarchyResult } from "../../../src/models";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  attachRawViewHierarchy,
  resolveViewHierarchyForSearch,
} from "../../../src/features/utility/viewHierarchySearch";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";

const hierarchy = (left: number): ViewHierarchyResult => ({
  updatedAt: 100 + left,
  hierarchy: { node: { text: "Target", clickable: true, bounds: [left, 0, left + 10, 10] } },
});
class FakeReader implements HierarchyCaptureReader {
  calls: string[] = [];
  cached = hierarchy(0);
  fresh = hierarchy(50);
  async readCached() {
    this.calls.push("cached-ok");
    return this.cached;
  }
  async readFresh() {
    this.calls.push("fresh");
    return this.fresh;
  }
  async readSettled() {
    this.calls.push("settled");
    return this.fresh;
  }
  projectVisible(value: ViewHierarchyResult) {
    return { ...value };
  }
}

describe("hierarchy capture freshness policy", () => {
  test("fresh requests cannot consume earlier cached coordinates and have distinct identity", async () => {
    const reader = new FakeReader();
    const capture = new DefaultHierarchyCapture(
      "ios",
      reader,
      new FakeTimer(),
      new CountingIdGenerator(),
    );
    const cached = await capture.capture({ freshness: "cached-ok" });
    const fresh = await capture.capture({ freshness: "fresh" });
    expect(reader.calls).toEqual(["cached-ok", "fresh"]);
    expect(cached.nodes[0].bounds?.left).toBe(0);
    expect(fresh.nodes[0].bounds?.left).toBe(50);
    expect(fresh.captureId).not.toBe(cached.captureId);
    expect(fresh.updatedAt).toBe(150);
  });
  test("settled requests use an explicit settlement adapter", async () => {
    const reader = new FakeReader();
    const capture = new DefaultHierarchyCapture(
      "ios",
      reader,
      new FakeTimer(),
      new CountingIdGenerator(),
    );
    await capture.capture({ freshness: "settled" });
    expect(reader.calls).toEqual(["settled"]);
  });
  test("reusing one cached capture retains identity and memoized nodes", async () => {
    const capture = new DefaultHierarchyCapture(
      "ios",
      new FakeReader(),
      new FakeTimer(),
      new CountingIdGenerator(),
    );
    const first = await capture.capture({ freshness: "cached-ok" });
    const second = await capture.capture({ freshness: "cached-ok" });
    expect(second.captureId).toBe(first.captureId);
    expect(second.nodes).toBe(first.nodes);
  });
  test("the actionable snapshot never exposes an attached raw hierarchy", async () => {
    const reader = new FakeReader();
    attachRawViewHierarchy(reader.cached, hierarchy(5000));
    const capture = new DefaultHierarchyCapture(
      "ios",
      reader,
      new FakeTimer(),
      new CountingIdGenerator(),
    );
    const result = await capture.capture({ freshness: "cached-ok" });
    expect(result.nodes[0].bounds?.left).toBe(0);
    expect(resolveViewHierarchyForSearch(result.hierarchy)).toBe(result.hierarchy);
  });
  test("iOS raw mode keeps the same visible candidates and bounds", async () => {
    const reader = new FakeReader();
    reader.fresh = {
      screenWidth: 100,
      screenHeight: 100,
      hierarchy: {
        node: [
          { text: "Visible", bounds: [10, 10, 30, 30], clickable: true },
          { text: "Hidden", bounds: [10, 500, 30, 520], clickable: true },
        ],
      },
    };
    attachRawViewHierarchy(reader.fresh, hierarchy(5000));
    reader.projectVisible = (value) => projectActionableHierarchy("ios", value);
    const capture = new DefaultHierarchyCapture(
      "ios",
      reader,
      new FakeTimer(),
      new CountingIdGenerator(),
    );
    const visible = await capture.capture({ freshness: "fresh" });
    const rawRequested = await capture.capture({ freshness: "fresh", searchRaw: true });
    expect(rawRequested.nodes).toBe(visible.nodes);
    expect(rawRequested.nodes.map((node) => [node.label, node.bounds?.left])).toEqual([
      ["Visible", 10],
    ]);
    expect(rawRequested.searchRaw).toBe(false);
  });
  test("diagnostic raw search projects attached nodes without widening actionable snapshots", async () => {
    const reader = new FakeReader();
    attachRawViewHierarchy(reader.fresh, hierarchy(5000));
    const capture = new DefaultHierarchyCapture(
      "android",
      reader,
      new FakeTimer(),
      new CountingIdGenerator(),
    );
    serverConfig.setRawElementSearchEnabled(true);
    try {
      const diagnostic = await capture.capture({ freshness: "fresh", searchRaw: true });
      expect(
        new ResolverElementSelector().selectByText(diagnostic.hierarchy, "Target", {
          intentAction: "drag",
        }).element?.bounds.left,
      ).toBe(5000);
      const actionable = await capture.capture({ freshness: "fresh" });
      expect(diagnostic.nodes[0].bounds?.left).toBe(5000);
      expect(actionable.nodes[0].bounds?.left).toBe(50);
      expect(resolveViewHierarchyForSearch(actionable.hierarchy)).toBe(actionable.hierarchy);
    } finally {
      serverConfig.setRawElementSearchEnabled(false);
    }
  });
});

test("settled capture uses the existing poll loop and returns its terminal hierarchy", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observe = new FakeObserveScreen();
  observe.setObserveSequence(
    [0, 50, 50].map((left, index) => ({
      updatedAt: 10 + index * 10,
      screenSize: { width: 100, height: 100 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example", activityName: "Main", layoutSeqSum: 1 },
      viewHierarchy: { ...hierarchy(left), updatedAt: 10 + index * 10 },
    })),
  );
  const reader = new ViewHierarchyCaptureReader(
    { getViewHierarchy: async () => hierarchy(0), filterOffscreenNodes: (value) => value },
    async () => hierarchy(0),
    (value) => value,
    new RealSettleObserve(observe, timer),
  );
  const capture = new DefaultHierarchyCapture("android", reader, timer, new CountingIdGenerator());
  const snapshot = await capture.capture({ freshness: "settled", timeoutMs: 2500 });
  expect(snapshot.nodes[0].bounds?.left).toBe(50);
  expect(snapshot.updatedAt).toBe(30);
});

test("a fresh response older than the device timestamp floor is rejected", async () => {
  const capture = new DefaultHierarchyCapture(
    "ios",
    new FakeReader(),
    new FakeTimer(),
    new CountingIdGenerator(),
  );
  await expect(capture.capture({ freshness: "fresh", minTimestamp: 151 })).rejects.toThrow(
    "timestamp floor",
  );
});

test("settlement timeout is never presented as a settled capture", async () => {
  const reader = new ViewHierarchyCaptureReader(
    { getViewHierarchy: async () => hierarchy(0), filterOffscreenNodes: (value) => value },
    async () => hierarchy(0),
    (value) => value,
    {
      execute: async () => ({
        observation: { viewHierarchy: hierarchy(0) } as any,
        settled: false,
        polls: 1,
        waitMs: 10,
        terminalReason: "timeout",
      }),
    },
  );
  const capture = new DefaultHierarchyCapture(
    "ios",
    reader,
    new FakeTimer(),
    new CountingIdGenerator(),
  );
  await expect(capture.capture({ freshness: "settled" })).rejects.toThrow(
    "did not settle: timeout",
  );
});

test("cached reader wrappers keep device frame identity separate from host acquisition identity", async () => {
  const source = { ...hierarchy(0), frameContext: "same-device-frame" };
  const reader = new ViewHierarchyCaptureReader(
    { getViewHierarchy: async () => ({ ...source }), filterOffscreenNodes: (value) => value },
    async () => source,
    (value) => value,
  );
  const capture = new DefaultHierarchyCapture(
    "ios",
    reader,
    new FakeTimer(),
    new CountingIdGenerator(),
  );
  const first = await capture.capture({ freshness: "cached-ok" });
  const second = await capture.capture({ freshness: "cached-ok" });
  expect(first.captureId).not.toBe(second.captureId);
  expect(first.hierarchy.frameContext).toBe(second.hierarchy.frameContext);
  expect(first.updatedAt).toBe(second.updatedAt);
});

test("capture provenance is available on direct output without serialized metadata", async () => {
  const reader = new FakeReader();
  const capture = new DefaultHierarchyCapture(
    "ios",
    reader,
    new FakeTimer(),
    new CountingIdGenerator(),
  );
  const snapshot = await capture.capture({ freshness: "fresh" });
  expect(getHierarchySnapshot(snapshot.hierarchy)).toBe(snapshot);
  expect(JSON.stringify(snapshot.hierarchy)).not.toContain("captureId");
});

test("observed provenance retains identity across visible projection and excludes raw nodes", () => {
  const source = hierarchy(0);
  attachRawViewHierarchy(source, hierarchy(5000));
  const snapshot = identifyObservedHierarchy(
    "android",
    source,
    "cached-ok",
    new FakeTimer(),
    new CountingIdGenerator(),
  );
  expect(snapshot.nodes[0].bounds?.left).toBe(0);
  expect(resolveViewHierarchyForSearch(snapshot.hierarchy)).toBe(snapshot.hierarchy);
  const projected = hierarchy(20);
  inheritHierarchySnapshot(source, projected);
  expect(getHierarchySnapshot(projected)?.captureId).toBe(snapshot.captureId);
  expect(getHierarchySnapshot(projected)?.nodes[0].bounds?.left).toBe(20);
});

test("a missing device timestamp cannot satisfy a requested floor", async () => {
  const reader = new FakeReader();
  reader.fresh = { hierarchy: reader.fresh.hierarchy };
  const capture = new DefaultHierarchyCapture(
    "ios",
    reader,
    new FakeTimer(),
    new CountingIdGenerator(),
  );
  await expect(capture.capture({ freshness: "fresh", minTimestamp: 1 })).rejects.toThrow(
    "timestamp floor",
  );
});

describe("observation read provenance", () => {
  test("a read in an earlier call does not authorize a cache hit", async () => {
    const hierarchy = { hierarchy: { node: {} } };
    await withObservationReadScope(async () => {
      recordObservationRead({ viewHierarchy: hierarchy });
      expect(wasHierarchyReadDuringCall(hierarchy)).toBe(true);
    });
    await withObservationReadScope(async () => {
      expect(wasHierarchyReadDuringCall(hierarchy)).toBe(false);
    });
  });

  test("concurrent read scopes do not share authority", async () => {
    const hierarchy = { hierarchy: { node: {} } };
    await Promise.all([
      withObservationReadScope(async () => {
        recordObservationRead({ viewHierarchy: hierarchy });
        await Promise.resolve();
        expect(wasHierarchyReadDuringCall(hierarchy)).toBe(true);
      }),
      withObservationReadScope(async () => {
        await Promise.resolve();
        expect(wasHierarchyReadDuringCall(hierarchy)).toBe(false);
      }),
    ]);
  });
});
