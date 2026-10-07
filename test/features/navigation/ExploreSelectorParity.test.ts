import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import type { ElementSelectionResult } from "../../../src/models/ElementSelectionResult";
import type { ElementSelector } from "../../../src/utils/interfaces/ElementSelector";
import { getStructuredPayload } from "../../../src/utils/toolUtils";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import {
  ElementResolver,
  type ElementResolution,
} from "../../../src/features/utility/ElementResolver";
import { getHierarchyNodeSource } from "../../../src/features/observe/output/elementProvenance";
import {
  extractNavigationElements,
  tapSelectorFor,
} from "../../../src/features/navigation/ExploreElementExtraction";

const fixtures = [
  "android-focus/playground-text-field-pre-tap.json",
  "android-focus/playground-text-field-post-tap.json",
  "identify-interactions/playground-tap-resource.json",
  "android-enabled/playground-disabled-control-api36.json",
  "swipeon-auto-target/foldable.json",
  "swipeon-auto-target/landscape.json",
  "android-launcher/launcher-folder-emulator-5600.json",
  "observe/ctrlproxy-headerless-two-notification-group-collapsed.json",
  "observe/ctrlproxy-headerless-two-notification-group-expanded.json",
  "ios/ios-demos-observe-full-sdk-nodes-injected.json",
  "ios/ios-demos-observe-full-sdk-nodes-not-injected.json",
  "observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json",
  "observe-output/ios-keyboard-states/ios-keyboard-minimized.raw.json",
] as const;

interface CaptureFile {
  hierarchy?: ViewHierarchyResult["hierarchy"];
  viewHierarchy?: ViewHierarchyResult;
  structuredContent?: unknown;
  content?: unknown;
  contents?: { text: string }[];
}

function loadCapture(name: string): ViewHierarchyResult {
  const file: CaptureFile = JSON.parse(
    readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8"),
  );
  if (file.viewHierarchy) {
    return file.viewHierarchy;
  }
  if (file.hierarchy) {
    const direct: ViewHierarchyResult = JSON.parse(
      readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8"),
    );
    return direct;
  }
  const resource: CaptureFile | undefined = file.contents?.[0]
    ? JSON.parse(file.contents[0].text)
    : undefined;
  const payload = resource ?? getStructuredPayload<{ viewHierarchy: ViewHierarchyResult }>(file);
  if (!payload?.viewHierarchy) {
    throw new Error(`Missing captured hierarchy: ${name}`);
  }
  return payload.viewHierarchy;
}

// Narrow recording seam around the pure resolver; no database, device, timer or I/O in selection.
class RecordingResolver implements Pick<ElementResolver, "resolve"> {
  private readonly delegate = new ElementResolver();
  last?: ElementResolution;

  resolve(...args: Parameters<ElementResolver["resolve"]>): ElementResolution {
    this.last = this.delegate.resolve(...args);
    return this.last;
  }
}

type Input = { kind: "id" | "text"; value: string };

function captureNodes(capture: ViewHierarchyResult): ViewHierarchyNode[] {
  const parser = new DefaultElementParser();
  const nodes = new Set<ViewHierarchyNode>();
  for (const root of [
    ...parser.extractRootNodes(capture),
    ...parser.extractWindowRootNodes(capture),
  ]) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => nodes.add(node));
  }
  return [...nodes];
}

function inputsFrom(nodes: ViewHierarchyNode[]): Input[] {
  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const node of nodes) {
    const properties = nodeAttributes(node);
    for (const field of ["resource-id", "text", "content-desc", "ios-accessibility-label"]) {
      const value = properties[field];
      if (typeof value === "string" && value.length > 0) {
        (field === "resource-id" ? ids : texts).add(value);
      }
    }
  }
  return [
    ...[...ids].map((value): Input => ({ kind: "id", value })),
    ...[...texts].map((value): Input => ({ kind: "text", value })),
  ];
}

function select(
  selector: ElementSelector,
  capture: ViewHierarchyResult,
  input: Input,
  index?: number,
) {
  // Exactly tapSelectorFor's options: Explore supplies no screenSizeOptions at either boundary.
  return input.kind === "id"
    ? selector.selectByResourceId(capture, input.value, { partialMatch: false, index })
    : selector.selectByText(capture, input.value, {
        partialMatch: true,
        caseSensitive: false,
        index,
      });
}

function elementRecord(element: Element | null, nodes: ViewHierarchyNode[]) {
  if (!element) {
    return null;
  }
  const source = getHierarchyNodeSource(element);
  return {
    sourceIndex: source ? nodes.indexOf(source) : -1,
    id: element["resource-id"] ?? null,
    text: element.text ?? null,
    description: element["content-desc"] ?? null,
    label: element["ios-accessibility-label"] ?? null,
    bounds: element.bounds,
  };
}

function selectionRecord(result: ElementSelectionResult, nodes: ViewHierarchyNode[]) {
  return {
    totalMatches: result.totalMatches,
    indexInMatches: result.indexInMatches,
    picked: elementRecord(result.element, nodes),
  };
}

function traceInput(capture: ViewHierarchyResult, nodes: ViewHierarchyNode[], input: Input) {
  const recording = new RecordingResolver();
  const resolver = new ResolverElementSelector(recording);
  const first = select(resolver, capture, input);
  const candidates = recording.last!.candidates.map((entry) =>
    elementRecord(entry.element ?? null, nodes),
  );
  const indexed = Array.from({ length: first.totalMatches }, (_, index) =>
    selectionRecord(select(resolver, capture, input, index), nodes),
  );
  return { ...input, candidates, first: selectionRecord(first, nodes), indexed };
}

function traceFixture(name: string) {
  const capture = loadCapture(name);
  const nodes = captureNodes(capture);
  const inputs = inputsFrom(nodes).map((input) => traceInput(capture, nodes, input));
  const resolver = new ResolverElementSelector();
  const explore = extractNavigationElements(capture, new DefaultElementParser()).map((element) => ({
    element: elementRecord(element, nodes),
    // Explore's production default, with no selector injected.
    selector: tapSelectorFor(element, capture),
    resolver: tapSelectorFor(element, capture, resolver),
  }));
  return { fixture: name, inputs, explore };
}

type Trace = ReturnType<typeof traceFixture>;
interface Report {
  explore: Trace["explore"];
  inputs: Trace["inputs"];
  digest: string;
}
const OFFSCREEN_PROBE = "SystemInputAssistantView";
const reports = new Map<string, Report>();
beforeAll(() => {
  // Load and enumerate captures once; the per-fixture assertions below only read the traces.
  // Keep only digests and the rows asserted below so the full traces are not retained.
  const traces = fixtures.map(traceFixture);
  for (const trace of traces) {
    reports.set(trace.fixture, {
      explore: trace.explore,
      inputs: trace.inputs.filter(({ kind, value }) => kind === "id" && value === OFFSCREEN_PROBE),
      digest: createHash("sha256").update(JSON.stringify(trace)).digest("hex"),
    });
  }
  if (process.env.EXPLORE_PARITY_REPORT) {
    writeFileSync(process.env.EXPLORE_PARITY_REPORT, JSON.stringify(traces, null, 2));
  }
});

// Explore adopted the resolver's semantics (#10268, owner decision on #10287). Each digest pins the
// resolver's candidate identities and order, every first/index pick, and every Explore selector.
const observed = [
  [
    "android-focus/playground-text-field-pre-tap.json",
    9,
    "809294289751f54b324df7dfa79b3174d3e2e5a84dd80454183bb639b8d166b9",
  ],
  [
    "android-focus/playground-text-field-post-tap.json",
    51,
    "ed7919e0ca9e34e97bda7cbbd9cbe7f6b4a23cb79dfb0b4029ddf3487bf554ea",
  ],
  [
    "identify-interactions/playground-tap-resource.json",
    13,
    "1f8fbd705a56ddd7f18439927b5680362b4860711be57770ba019a43b0defeb4",
  ],
  [
    "android-enabled/playground-disabled-control-api36.json",
    5,
    "a0a039a4b7ae06e4555cc340bfca9f6a1d09b0eec9ec10e0bc6685697b71f60e",
  ],
  [
    "swipeon-auto-target/foldable.json",
    0,
    "a13ffeedaa2f93cf8d692fc66ecf15692d09e8328e085ba56b00c0e4f248c34e",
  ],
  [
    "swipeon-auto-target/landscape.json",
    0,
    "0dfa717375673bfaaa959d85f5079ddf5cbb711c13e7b8d140f78e2bdcf0bd89",
  ],
  [
    "android-launcher/launcher-folder-emulator-5600.json",
    2,
    "797951caaaa65392a7574c24233504728b98ffa9c059b99e1aa728af51fb92fa",
  ],
  [
    "observe/ctrlproxy-headerless-two-notification-group-collapsed.json",
    0,
    "f3c6c045330e3defdde1bcb9add0a5c244ae7add125f8717368094bdc592ca35",
  ],
  [
    "observe/ctrlproxy-headerless-two-notification-group-expanded.json",
    0,
    "df04af2476497e079745672db711f01ff20a4cf887f26cc658f73acfd90c543a",
  ],
  [
    "ios/ios-demos-observe-full-sdk-nodes-injected.json",
    39,
    "b91d65da046a76625d054e357c6a07aa40cdaa885f5645638c9f49018f8c6213",
  ],
  [
    "ios/ios-demos-observe-full-sdk-nodes-not-injected.json",
    39,
    "e3dffd4e1326b01825f3f96a3e2eab3cc945c6bac858e1517556bb40ec534107",
  ],
  [
    "observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json",
    63,
    "e0b8a24a8b068ff4594420c0e0f41bed266f4f4e497a2fea23fb8afc5461ee32",
  ],
  [
    "observe-output/ios-keyboard-states/ios-keyboard-minimized.raw.json",
    37,
    "6aa2c630b78a5a197eea3fe90affcb605399a2cfa8b781666aef61f28bbe1011",
  ],
] as const;

test.each(observed)("Explore selects through the resolver on %s", (name, exploreRows, digest) => {
  const report = reports.get(name)!;
  expect(report.explore).toHaveLength(exploreRows);
  for (const row of report.explore) {
    expect(row.selector).toEqual(row.resolver);
  }
  expect(report.digest).toBe(digest);
});

function exploreSelector(fixture: string, text: string) {
  const report = reports.get(fixture)!;
  return report.explore.find(({ element }) => element?.text === text)!.selector;
}

test("a text match promotes to its actionable owner: the Android Tap tab is occurrence 0", () => {
  // The legacy selector also counted the actionless label, which made the tab occurrence 1.
  expect(exploreSelector("android-focus/playground-text-field-pre-tap.json", "Tap")).toEqual({
    text: "Tap",
    index: 0,
  });
});

test("an iOS switch and its labelled row are both counted, so the switch is pinned", () => {
  expect(
    exploreSelector(
      "observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json",
      "Enable Notifications",
    ),
  ).toEqual({ text: "Enable Notifications", index: 0 });
});

test("an IME key keeps its indexed resource-id rather than a label tapOn cannot match", () => {
  // Text selectors exclude IME keys, so the label has no match; zero matches is not unique.
  const id = "com.google.android.inputmethod.latin:id/key_pos_0_0";
  const report = reports.get("android-focus/playground-text-field-post-tap.json")!;
  const row = report.explore.find(({ element }) => element?.id === id)!;
  expect(row.selector).toEqual({ elementId: id, index: 0 });
});

test("an off-screen candidate is filtered before totals and indices", () => {
  const report = reports.get("observe-output/ios-keyboard-states/ios-keyboard-minimized.raw.json")!;
  const input = report.inputs.find(
    ({ kind, value }) => kind === "id" && value === "SystemInputAssistantView",
  )!;
  expect(input.candidates).toEqual([]);
  expect(input.first).toEqual({ totalMatches: 0, indexInMatches: -1, picked: null });
  expect(input.indexed).toEqual([]);
});
