import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import type { ElementSelectionResult } from "../../../src/models/ElementSelectionResult";
import type { ElementSelector } from "../../../src/utils/interfaces/ElementSelector";
import { getStructuredPayload } from "../../../src/utils/toolUtils";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import {
  ElementResolver,
  type ElementResolution,
} from "../../../src/features/utility/ElementResolver";
import {
  isElementCenterOffScreen,
  screenSizeForOffscreenCheck,
} from "../../../src/features/utility/ElementGeometry";
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

function compareInput(capture: ViewHierarchyResult, nodes: ViewHierarchyNode[], input: Input) {
  const finder = new DefaultElementFinder();
  const old = new DefaultElementSelector(finder);
  const recording = new RecordingResolver();
  const resolver = new ResolverElementSelector(recording);
  const oldFirst = select(old, capture, input);
  const resolverFirst = select(resolver, capture, input);
  const raw =
    input.kind === "id"
      ? finder.findElementsByResourceId(capture, input.value, null, false, false)
      : finder.findElementsByText(capture, input.value, null, true, false, false, true);
  const screen = screenSizeForOffscreenCheck(capture);
  const oldVisible = raw.filter((element) => !isElementCenterOffScreen(element.bounds, screen));
  const resolverCandidates = recording.last!.candidates.map((entry) =>
    elementRecord(entry.element ?? null, nodes),
  );
  const oldCandidates = oldVisible.map((element) => elementRecord(element, nodes));
  const candidateOrderAgrees = JSON.stringify(oldCandidates) === JSON.stringify(resolverCandidates);
  const indices: (number | undefined)[] = [
    undefined,
    ...Array.from(
      { length: Math.max(oldFirst.totalMatches, resolverFirst.totalMatches) },
      (_, index) => index,
    ),
  ];
  const rows = indices.map((index) => {
    const left = selectionRecord(
      index === undefined ? oldFirst : select(old, capture, input, index),
      nodes,
    );
    const right = selectionRecord(
      index === undefined ? resolverFirst : select(resolver, capture, input, index),
      nodes,
    );
    return {
      index: index ?? "first",
      old: left,
      resolver: right,
      agrees: candidateOrderAgrees && JSON.stringify(left) === JSON.stringify(right),
    };
  });
  return {
    ...input,
    rawCandidates: raw.map((element) => ({
      element: elementRecord(element, nodes),
      onScreen: !isElementCenterOffScreen(element.bounds, screen),
    })),
    oldCandidates,
    resolverCandidates,
    candidateOrderAgrees,
    rows,
  };
}

function compareFixture(name: string) {
  const capture = loadCapture(name);
  const nodes = captureNodes(capture);
  const inputs = inputsFrom(nodes).map((input) => compareInput(capture, nodes, input));
  const old = new DefaultElementSelector();
  const resolver = new ResolverElementSelector();
  const explore = extractNavigationElements(capture, new DefaultElementParser()).map((element) => {
    const left = tapSelectorFor(element, capture, old);
    const right = tapSelectorFor(element, capture, resolver);
    return {
      element: elementRecord(element, nodes),
      old: left,
      resolver: right,
      agrees: JSON.stringify(left) === JSON.stringify(right),
    };
  });
  const rows = inputs.flatMap((input) => input.rows);
  return {
    fixture: name,
    inputs,
    explore,
    summary: {
      inputs: inputs.length,
      rows: rows.length,
      differingRows: rows.filter((row) => !row.agrees).length,
      exploreRows: explore.length,
      differingExploreRows: explore.filter((row) => !row.agrees).length,
    },
  };
}

const reports = new Map<string, ReturnType<typeof compareFixture>>();
beforeAll(() => {
  // Load and enumerate captures once; comparison traces are asserted below without repeating expensive fixture setup.
  for (const name of fixtures) {
    reports.set(name, compareFixture(name));
  }
  const all = [...reports.values()];
  console.info(
    "Explore selector comparison:",
    JSON.stringify(all.map(({ fixture, summary }) => ({ fixture, ...summary }))),
  );
  if (process.env.EXPLORE_PARITY_REPORT) {
    writeFileSync(process.env.EXPLORE_PARITY_REPORT, JSON.stringify(all, null, 2));
  }
});

// Step 3: parity failed. Pin the complete observed traces and counts without changing either selector.
// Digests include raw/visible candidate identities and order, every first/index pick, and Explore args.
const observed = [
  [
    "android-focus/playground-text-field-pre-tap.json",
    159,
    159,
    9,
    9,
    "0f6cf6e93c9c470e67334326a0864469a8ca25c97795f9f34231bef3c8e95dc4",
  ],
  [
    "android-focus/playground-text-field-post-tap.json",
    606,
    372,
    51,
    9,
    "c41f6212902eaeb5422c9416e2e179809d65a531b774d02d46d75856d9ddd37d",
  ],
  [
    "identify-interactions/playground-tap-resource.json",
    223,
    208,
    13,
    8,
    "773bef6b33368d0c1c8da19aaf09c86a77bdc13153ffabe92317fd2bbe55f821",
  ],
  [
    "android-enabled/playground-disabled-control-api36.json",
    149,
    146,
    5,
    5,
    "d1bc4c7a697dc52eb10d970b2c548e4896fe7da82535755aa7919dd9e665b6a4",
  ],
  [
    "swipeon-auto-target/foldable.json",
    11,
    11,
    0,
    0,
    "35db75956116ba138c25dc4c0be795e521780a85623ed9c670fe230255eec812",
  ],
  [
    "swipeon-auto-target/landscape.json",
    11,
    11,
    0,
    0,
    "9f1bd903db4ca073fdb55887ccafcd1340882c7ef5bca014e367c544b59bc42a",
  ],
  [
    "android-launcher/launcher-folder-emulator-5600.json",
    119,
    107,
    2,
    0,
    "f064aaec7874944003988f71d7e201446bdc802fb4568cc73f94c76dcbeaf7fa",
  ],
  [
    "observe/ctrlproxy-headerless-two-notification-group-collapsed.json",
    106,
    106,
    0,
    0,
    "9677e0670524e8bd1fad91f677ca87fa850bb047083bb48cacdc1986a5feb9f4",
  ],
  [
    "observe/ctrlproxy-headerless-two-notification-group-expanded.json",
    131,
    131,
    0,
    0,
    "6babc611b52ea597e004265515948d52316a4d18581dff13df64c56ddd4a0f06",
  ],
  [
    "ios/ios-demos-observe-full-sdk-nodes-injected.json",
    177,
    91,
    39,
    1,
    "0086bac1ca825b5db0001a3c9b39fbc4d89e1664e3b3c100282e4709aa381ea2",
  ],
  [
    "ios/ios-demos-observe-full-sdk-nodes-not-injected.json",
    178,
    92,
    39,
    1,
    "5419824ff76c5cf08e2800e8da618512e1be2feea3f409f51063e9c4d59bbe44",
  ],
  [
    "observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json",
    177,
    66,
    63,
    2,
    "df74d7b64a73d4bb404b357f9494d989351b15e73f4bfd413e348e4d6e79744c",
  ],
  [
    "observe-output/ios-keyboard-states/ios-keyboard-minimized.raw.json",
    123,
    81,
    37,
    6,
    "c347c1162766662e31bbb8787d37833731244f043d10eda5a9bad07cc503946b",
  ],
] as const;

test.each(observed)(
  "documents selector divergence on %s",
  (name, rows, differences, exploreRows, exploreDifferences, digest) => {
    const report = reports.get(name)!;
    expect(report.summary).toEqual({
      inputs: report.inputs.length,
      rows,
      differingRows: differences,
      exploreRows,
      differingExploreRows: exploreDifferences,
    });
    expect(createHash("sha256").update(JSON.stringify(report)).digest("hex")).toBe(digest);
  },
);

test("captured Android Tap tab changes Explore occurrence from 1 to 0", () => {
  const report = reports.get("android-focus/playground-text-field-pre-tap.json")!;
  const row = report.explore.find(({ element }) => element?.text === "Tap")!;
  expect(row.old).toEqual({ text: "Tap", index: 1 });
  expect(row.resolver).toEqual({ text: "Tap", index: 0 });
});

test("captured iOS switch label changes Explore uniqueness", () => {
  const report = reports.get("observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json")!;
  const row = report.explore.find(({ element }) => element?.text === "Enable Notifications")!;
  expect(row.old).toEqual({ text: "Enable Notifications" });
  expect(row.resolver).toEqual({ text: "Enable Notifications", index: 0 });
});

test("captured off-screen iOS keyboard node has different totalMatches despite identical misses", () => {
  const report = reports.get("observe-output/ios-keyboard-states/ios-keyboard-minimized.raw.json")!;
  const input = report.inputs.find(
    ({ kind, value }) => kind === "id" && value === "SystemInputAssistantView",
  )!;
  expect(input.rawCandidates.map(({ onScreen }) => onScreen)).toEqual([false]);
  expect(input.rows.map(({ old }) => old)).toEqual([
    { totalMatches: 1, indexInMatches: -1, picked: null },
    { totalMatches: 1, indexInMatches: -1, picked: null },
  ]);
  expect(input.rows.map(({ resolver }) => resolver)).toEqual([
    { totalMatches: 0, indexInMatches: -1, picked: null },
    { totalMatches: 0, indexInMatches: -1, picked: null },
  ]);
});
