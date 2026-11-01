import { describe, expect, test } from "bun:test";
import { DefaultIosObservationCollector } from "../../../../src/features/observe/collectors/IosObservationCollector";
import type { IosSdkBridgeReader } from "../../../../src/features/observe/ios/IosSdkBridgeReader";
import type { IosSdkWebReader } from "../../../../src/features/observe/ios/IosSdkWebReader";
import type { IosSdkWebViewSnapshot } from "../../../../src/features/observe/ios/iosSdkWebMerge";
import type { ObserveResult, ViewHierarchyNode, ViewHierarchyResult } from "../../../../src/models";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { buildObserveResult } from "../../../helpers/observeFixture";

const noNativeBridge: IosSdkBridgeReader = { observe: async () => ({ kind: "none" }) };

class FakeWebReader implements IosSdkWebReader {
  reads = 0;
  constructor(private readonly snapshots_: IosSdkWebViewSnapshot[]) {}
  async snapshots(): Promise<IosSdkWebViewSnapshot[]> {
    this.reads += 1;
    return this.snapshots_;
  }
}

function hierarchy(withWebView: boolean): ViewHierarchyResult {
  const children: ViewHierarchyNode[] = [{ $: { class: "UIButton", text: "Native" } }];
  if (withWebView) {
    children.push({
      $: {
        class: "WKWebView",
        scrollable: "true",
        bounds: { left: 0, top: 100, right: 402, bottom: 800 },
      },
    });
  }
  return {
    packageName: "com.example.app",
    hierarchy: {
      node: {
        $: { class: "XCUIApplication", bounds: { left: 0, top: 0, right: 402, bottom: 874 } },
        node: children,
      },
    },
  };
}

async function collect(reader: FakeWebReader, withWebView: boolean): Promise<ObserveResult> {
  const collector = new DefaultIosObservationCollector({
    hierarchyCollector: () => new FakeHierarchyCollector(),
    viewHierarchy: () => new FakeViewHierarchy(),
    device: () => ({ deviceId: "sim-1", name: "iPhone", platform: "ios" }),
    sdkBridge: () => noNativeBridge,
    sdkWeb: () => reader,
  });
  const result = buildObserveResult({
    updatedAt: 0,
    screenSize: { width: 0, height: 0 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  await collector.collect({
    result,
    queryOptions: undefined,
    perf: new NoOpPerformanceTracker(),
    skipWaitForFresh: true,
    minTimestamp: 0,
    signal: undefined,
    readOnly: false,
    capturedHierarchy: hierarchy(withWebView),
    readOptions: undefined,
  });
  return result;
}

const checkout: IosSdkWebViewSnapshot = {
  webViewId: "checkout",
  snapshot: {
    snapshotId: "s1",
    url: "https://fixture.local/",
    elements: [
      {
        id: "e0",
        role: "button",
        label: "Pay",
        bounds: [10, 10, 80, 30],
        enabled: true,
        visible: true,
        focused: false,
      },
    ],
  },
};

function contentDescriptions(result: ObserveResult): string[] {
  return JSON.stringify(result.viewHierarchy).match(/"content-desc":"[^"]*"/g) ?? [];
}

describe("DefaultIosObservationCollector web-view merge (#5162)", () => {
  test("merges a web view's DOM elements and reports backend sdk", async () => {
    const result = await collect(new FakeWebReader([checkout]), true);
    expect(contentDescriptions(result)).toContain('"content-desc":"Pay"');
    expect(result.backend).toBe("sdk");
  });

  test("a screen without a WKWebView reads no snapshots and is unchanged", async () => {
    const reader = new FakeWebReader([checkout]);
    const result = await collect(reader, false);
    expect(reader.reads).toBe(0);
    expect(result.backend).toBeUndefined();
  });
});
