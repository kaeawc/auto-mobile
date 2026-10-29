import { describe, expect, test } from "bun:test";
import { DefaultIosObservationCollector } from "../../../../src/features/observe/collectors/IosObservationCollector";
import type {
  IosSdkBridgeObservation,
  IosSdkBridgeReader,
} from "../../../../src/features/observe/ios/IosSdkBridgeReader";
import type { ObserveResult, ViewHierarchyResult } from "../../../../src/models";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { buildObserveResult } from "../../../helpers/observeFixture";

const appHierarchy = (): ViewHierarchyResult => ({
  packageName: "com.example.app",
  screenWidth: 402,
  screenHeight: 874,
  hierarchy: {
    node: {
      $: { class: "XCUIApplication", bounds: { left: 0, top: 0, right: 402, bottom: 874 } },
      node: [
        {
          $: {
            class: "UIButton",
            text: "Native",
            clickable: "true",
            bounds: { left: 10, top: 10, right: 90, bottom: 40 },
          },
        },
      ],
    },
  },
});

class FakeBridgeReader implements IosSdkBridgeReader {
  appIds: string[] = [];
  constructor(private readonly outcome: IosSdkBridgeObservation) {}
  async observe(appId: string): Promise<IosSdkBridgeObservation> {
    this.appIds.push(appId);
    return this.outcome;
  }
}

async function collect(
  outcome: IosSdkBridgeObservation,
): Promise<{ result: ObserveResult; reader: FakeBridgeReader }> {
  const reader = new FakeBridgeReader(outcome);
  const collector = new DefaultIosObservationCollector({
    hierarchyCollector: () => new FakeHierarchyCollector(),
    viewHierarchy: () => new FakeViewHierarchy(),
    device: () => ({ deviceId: "sim-1", name: "iPhone", platform: "ios" }),
    sdkBridge: () => reader,
  });
  const result: ObserveResult = buildObserveResult({
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
    capturedHierarchy: appHierarchy(),
    readOptions: undefined,
  });
  return { result, reader };
}

function texts(result: ObserveResult): string[] {
  const out: string[] = [];
  const walk = (node: { $?: Record<string, unknown>; node?: unknown } | undefined) => {
    if (!node) {
      return;
    }
    const label = node.$?.["content-desc"] ?? node.$?.text;
    if (typeof label === "string") {
      out.push(label);
    }
    for (const child of (Array.isArray(node.node)
      ? node.node
      : node.node
        ? [node.node]
        : []) as Array<{
      $?: Record<string, unknown>;
      node?: unknown;
    }>) {
      walk(child);
    }
  };
  walk(result.viewHierarchy?.hierarchy.node);
  return out;
}

describe("DefaultIosObservationCollector SDK bridge merge (#5159)", () => {
  test("merges the bridge snapshot and reports backend sdk", async () => {
    const { result, reader } = await collect({
      kind: "observation",
      observation: {
        captureIdentity: 7,
        orientation: "portrait",
        coordinateSpace: "screen",
        bounds: { left: 0, top: 0, right: 402, bottom: 874 },
        root: {
          id: "save",
          role: "button",
          label: "Save",
          bounds: { left: 10, top: 100, right: 90, bottom: 140 },
          enabled: true,
          visible: true,
          focused: false,
          children: [],
        },
        capabilities: [],
      },
    });
    expect(reader.appIds).toEqual(["com.example.app"]);
    expect(result.backend).toBe("sdk");
    expect(result.fallbackReason).toBeUndefined();
    expect(texts(result)).toEqual(expect.arrayContaining(["Native", "Save"]));
  });

  test("a bridge that did not answer reports xctest with fallbackReason unavailable", async () => {
    const { result } = await collect({ kind: "unavailable", detail: "bridge_unavailable" });
    expect(result.backend).toBe("xctest");
    expect(result.fallbackReason).toBe("unavailable");
    expect(texts(result)).toEqual(["Native"]);
  });

  test("an app without a bridge observes exactly as before", async () => {
    const { result } = await collect({ kind: "none" });
    expect(result.backend).toBeUndefined();
    expect(result.fallbackReason).toBeUndefined();
    expect(texts(result)).toEqual(["Native"]);
  });
});
