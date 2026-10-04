import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assignStableViewIds } from "../../../../src/features/observe/android/StableNodeIdentity";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/ios/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { getStructuredPayload } from "../../../../src/utils/toolUtils";
import { FakeTimer } from "../../../fakes/FakeTimer";

interface CaptureNode extends Record<string, unknown> {
  className?: string;
  text?: string;
  bounds?: [number, number, number, number];
  extras?: Record<string, string>;
  node?: CaptureNode | CaptureNode[];
  "view-id"?: string;
}

interface Capture {
  structuredContent: { viewHierarchy: { hierarchy: CaptureNode } };
}

const formsText = "Forms & Input, Text fields, pickers, and toggles";
const iosOptions = { excludeSdkInjectedNodes: true };
let injected: CaptureNode;
let notInjected: CaptureNode;

function childrenOf(node: CaptureNode): CaptureNode[] {
  return node.node ? (Array.isArray(node.node) ? node.node : [node.node]) : [];
}

function nodesOf(node: CaptureNode): CaptureNode[] {
  return [node, ...childrenOf(node).flatMap(nodesOf)];
}

function isInjected(node: CaptureNode): boolean {
  return node.extras?.["sdk.source"] === "sdkWalker";
}

function formsRow(root: CaptureNode): CaptureNode {
  const row = nodesOf(root).find(
    (node) => node.text === formsText && node.bounds?.[0] === 16 && node.bounds[2] === 386,
  );
  if (!row) {
    throw new Error("Real capture has no Forms & Input row at the expected bounds");
  }
  return row;
}

beforeAll(() => {
  function load(suffix: string): CaptureNode {
    const capture: Capture = JSON.parse(
      readFileSync(
        new URL(
          `../../../fixtures/ios/ios-demos-observe-full-sdk-nodes-${suffix}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const payload = getStructuredPayload<Capture["structuredContent"]>(capture);
    if (!payload) {
      throw new Error("Capture has no structured observe payload");
    }
    const root = payload.viewHierarchy.hierarchy;
    // Observe has already rewritten the runner UUIDs. Restore only those generated
    // identity slots; resource identifiers and SDK-only nodes stay as captured.
    nodesOf(root).forEach((node, index) => {
      if (node["view-id"]?.startsWith("s2-")) {
        node["view-id"] = `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      }
    });
    return root;
  }
  injected = load("injected");
  notInjected = load("not-injected");
});

describe("iOS SDK-injected stable identity (real batch-13 captures, #9260)", () => {
  test("keeps the Forms & Input row id across SDK-only child placement", () => {
    const a = structuredClone(injected);
    const b = structuredClone(notInjected);
    expect(childrenOf(formsRow(a)).some(isInjected)).toBe(true);
    expect(childrenOf(formsRow(b)).some(isInjected)).toBe(false);

    // The exported ingest pass accepts the raw iOS spelling (className, dashed
    // view-id, sibling extras) as well as the converter's $ attribute slot.
    assignStableViewIds(a, iosOptions);
    assignStableViewIds(b, iosOptions);

    expect(formsRow(a)["view-id"]).toBe(formsRow(b)["view-id"]);
    expect(formsRow(b)["view-id"]).toBe("s2-792852e3b847bb51");
  });

  test("reproduces main's two ids with the iOS gate disabled", () => {
    const a = structuredClone(injected);
    const b = structuredClone(notInjected);
    assignStableViewIds(a);
    assignStableViewIds(b);
    expect(formsRow(a)["view-id"]).toBe("s2-ad120f8efbc57ea1");
    expect(formsRow(b)["view-id"]).toBe("s2-792852e3b847bb51");
  });

  test("preserves ids without injected descendants and retains the entire captured tree", () => {
    for (const capture of [injected, notInjected]) {
      const baseline = structuredClone(capture);
      const fixed = structuredClone(capture);
      assignStableViewIds(baseline);
      assignStableViewIds(fixed, iosOptions);
      const baselineNodes = nodesOf(baseline);
      const fixedNodes = nodesOf(fixed);
      expect(fixedNodes.length).toBe(baselineNodes.length);
      baselineNodes.forEach((node, index) => {
        if (!nodesOf(node).some(isInjected)) {
          expect(fixedNodes[index]["view-id"]).toBe(node["view-id"]);
        }
      });
      expect(fixedNodes.filter(isInjected)).toEqual(baselineNodes.filter(isInjected));
    }
  });

  test("the explicit disabled option is byte-identical to the default", () => {
    const defaultTree = structuredClone(injected);
    const disabledTree = structuredClone(injected);
    const defaultMap = assignStableViewIds(defaultTree);
    const disabledMap = assignStableViewIds(disabledTree, { excludeSdkInjectedNodes: false });
    expect(JSON.stringify(disabledTree)).toBe(JSON.stringify(defaultTree));
    expect(disabledMap).toEqual(defaultMap);
  });

  test("injected peers do not shift real duplicate ordinals, even before the real siblings", () => {
    const label = nodesOf(injected).find((node) => node.text === "Forms & Input");
    if (!label) {
      throw new Error("Capture has no Forms & Input label");
    }
    const baseline = { node: [structuredClone(label), structuredClone(label)] };
    const marked = { ...structuredClone(label), extras: { "sdk.source": "sdkWalker" } };
    const withInjection = { node: [marked, ...structuredClone(baseline.node)] };
    assignStableViewIds(baseline, iosOptions);
    assignStableViewIds(withInjection, iosOptions);
    expect(withInjection.node.slice(1)).toEqual(baseline.node);
    expect(marked["view-id"]).toMatch(/^s2-[0-9a-f]{16}$/);
    expect(marked["view-id"]).not.toBe(baseline.node[0]["view-id"]);
    expect(baseline.node[0]["view-id"]).toEndWith("-1");
    expect(baseline.node[1]["view-id"]).toEndWith("-2");
  });

  test("SDK-only descendants cannot change a real duplicate's text suffix", () => {
    const row = formsRow(notInjected);
    const otherRow = nodesOf(notInjected).find((node) => node.text?.startsWith("Alerts & Sheets,"));
    if (!otherRow) {
      throw new Error("Capture has no Alerts & Sheets row");
    }
    // Table cells share a structural hash, and their row labels disambiguate them.
    const a = {
      className: "UITableViewCell",
      "view-id": row["view-id"],
      node: [structuredClone(row)],
    };
    const b = {
      className: "UITableViewCell",
      "view-id": otherRow["view-id"],
      node: [{ ...structuredClone(row), text: otherRow.text }],
    };
    const baseline = { node: [a, b] };
    const changed = structuredClone(baseline);
    const injectedBackground = childrenOf(formsRow(injected)).find(isInjected);
    if (!injectedBackground) {
      throw new Error("Capture has no injected row background");
    }
    changed.node[0].node.push({ ...structuredClone(injectedBackground), text: "SDK text tick 42" });
    assignStableViewIds(baseline, iosOptions);
    assignStableViewIds(changed, iosOptions);
    expect(changed.node.map((node) => node["view-id"])).toEqual(
      baseline.node.map((node) => node["view-id"]),
    );
    expect(a["view-id"]).toContain("~");
  });

  test("iOS conversion passes the gate and preserves sibling extras outside $", () => {
    const timer = new FakeTimer();
    const context: HierarchyDelegateContext = {
      timer,
      requestManager: new RequestManager(timer),
      getWebSocket: () => null,
      ensureConnected: async () => false,
      cancelScreenshotBackoff: () => {},
      cacheFreshTtlMs: 1000,
      getCachedHierarchy: () => null,
      setCachedHierarchy: () => {},
    };
    const subject = new CtrlProxyHierarchy(context);
    const sdkLabel = {
      className: "UILabel",
      text: "SDK-only content",
      viewId: "00000001-0000-4000-8000-000000000000",
      extras: { "sdk.source": "sdkWalker" },
    };
    const hierarchy = {
      packageName: "test.app",
      updatedAt: 0,
      hierarchy: {
        className: "UIButton",
        text: formsText,
        viewId: "00000002-0000-4000-8000-000000000000",
        node: [sdkLabel],
      },
    };
    const baseline = subject.convertToViewHierarchyResult({
      ...hierarchy,
      hierarchy: { ...hierarchy.hierarchy, node: [] },
    });
    const converted = subject.convertToViewHierarchyResult(hierarchy);
    expect(converted.hierarchy.node?.$?.["view-id"]).toBe(baseline.hierarchy.node?.$?.["view-id"]);
    const children = converted.hierarchy.node?.node;
    const child = Array.isArray(children) ? children[0] : children;
    expect(child?.extras).toEqual(sdkLabel.extras);
    expect(child?.$?.["view-id"]).toMatch(/^s2-[0-9a-f]{16}$/);
  });
});
