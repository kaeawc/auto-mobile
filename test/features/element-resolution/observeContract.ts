import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Element } from "../../../src/models/Element";
import type {
  ObserveResult,
  SkeletonElement,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import { stableNodeSelectorForElement } from "../../../src/features/talkback/TalkBackTapStrategy";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";

export interface ContractCapture {
  name: string;
  hierarchy: ViewHierarchyResult;
  platform: "android" | "ios";
}
export interface ContractQuery {
  kind: "elementId" | "text" | "testTag";
  value: string;
  index?: number;
}
export interface ContractResolution {
  candidates: Element[];
  chosen: Element | null;
}
/** S2 supplies a real resolver adapter here; legacy is only the reference side. */
export interface ContractResolver {
  resolve(capture: ContractCapture, query: ContractQuery): ContractResolution;
}
export interface ContractCase {
  key: string;
  capture: ContractCapture;
  query: ContractQuery;
  observed: SkeletonElement;
}

export function loadContractCaptures(directory: string): ContractCapture[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.isDirectory()) {
        return loadContractCaptures(join(directory, entry.name)).map((capture) => ({
          ...capture,
          name: `${entry.name}/${capture.name}`,
        }));
      }
      if (!entry.name.endsWith(".json")) {
        return [];
      }
      const value = JSON.parse(readFileSync(join(directory, entry.name), "utf8")) as ObserveResult &
        Record<string, ViewHierarchyNode>;
      if (value.viewHierarchy) {
        return [
          {
            name: entry.name,
            hierarchy: value.viewHierarchy,
            platform: entry.name.startsWith("ios-") ? "ios" : "android",
          },
        ];
      }
      // The compact notification fixture contains named raw capture roots, not ObserveResults.
      if (entry.name === "ctrlproxy-notification-group-compact-bounds.json") {
        return Object.entries(value).map(([name, node]) => ({
          name: `${entry.name}/${name}`,
          hierarchy: { hierarchy: { node } },
          platform: "android" as const,
        }));
      }
      throw new Error(`Unsupported observe fixture: ${entry.name}`);
    });
}

export function contractCases(capture: ContractCapture): ContractCase[] {
  const elements = new DefaultObserveElementCollector().collect(
    capture.hierarchy,
    capture.platform,
  )!;
  const skeleton = projectSkeleton(elements).skeleton;
  return skeleton.flatMap((observed, row) => {
    // The keyboard mode summary is deliberately not an addressable node.
    if (observed.elementId === "<ime>") {
      return [];
    }
    const queries: ContractQuery[] = [];
    if (observed.elementId) {
      queries.push({ kind: "elementId", value: observed.elementId, index: observed.index });
    }
    if (observed.label) {
      const peers = skeleton.filter((entry) => entry.label === observed.label);
      const index =
        peers.length > 1
          ? skeleton.slice(0, row).filter((entry) => entry.label === observed.label).length
          : undefined;
      queries.push({ kind: "text", value: observed.label, index });
    }
    if (observed.testTag) {
      const peers = skeleton.filter((entry) => entry.testTag === observed.testTag);
      const index =
        peers.length > 1
          ? skeleton.slice(0, row).filter((entry) => entry.testTag === observed.testTag).length
          : undefined;
      queries.push({ kind: "testTag", value: observed.testTag, index });
      if (peers.length > 1 && index === 0) {
        queries.push({ kind: "testTag", value: observed.testTag });
      }
    }
    return queries.map((query) => ({
      key: `${capture.name}:${JSON.stringify(query)}:${observed.bounds.join(",")}`,
      capture,
      query,
      observed,
    }));
  });
}

/** Public default text queries, separate from indexed per-row roundtrip obligations. */
export function publicTextCases(cases: ContractCase[]): ContractCase[] {
  const unique = new Map<string, ContractCase>();
  for (const testCase of cases) {
    if (testCase.query.kind !== "text") {
      continue;
    }
    const identity = JSON.stringify([testCase.capture.name, testCase.query.value]);
    if (unique.has(identity)) {
      continue;
    }
    const query: ContractQuery = { kind: "text", value: testCase.query.value };
    unique.set(identity, {
      ...testCase,
      query,
      key: `${testCase.capture.name}:${JSON.stringify(query)}:${testCase.observed.bounds.join(",")}`,
    });
  }
  return [...unique.values()];
}

export class LegacyContractResolver implements ContractResolver {
  private readonly finder = new DefaultElementFinder();
  private readonly selector = new DefaultElementSelector(this.finder, () => 0);
  resolve({ hierarchy }: ContractCapture, query: ContractQuery): ContractResolution {
    const options = { partialMatch: false, index: query.index };
    if (query.kind === "elementId") {
      return {
        candidates: this.finder.findElementsByResourceId(
          hierarchy,
          query.value,
          null,
          false,
          query.index !== undefined,
        ),
        chosen: this.selector.selectByResourceId(hierarchy, query.value, options).element,
      };
    }
    if (query.kind === "testTag") {
      return {
        candidates: this.finder.findElementsByTestTag(
          hierarchy,
          query.value,
          null,
          query.index !== undefined,
        ),
        chosen: this.selector.selectByTestTag(hierarchy, query.value, options).element,
      };
    }
    return {
      candidates: this.finder.findElementsByText(
        hierarchy,
        query.value,
        null,
        true,
        false,
        query.index !== undefined,
        query.index === undefined,
        "tap",
      ),
      chosen: this.selector.selectByText(hierarchy, query.value, {
        ...options,
        partialMatch: true,
        caseSensitive: false,
        selectionIntent: "tap",
      }).element,
    };
  }
}

export function boundsKey(element: Element | null): string | null {
  if (!element) {
    return null;
  }
  const { left, top, right, bottom } = element.bounds;
  return [left, top, right, bottom].join(",");
}

/** Compare chosen target AND ordered candidate identity, so matching counts cannot hide drift. */
export function compareResolvers(
  cases: ContractCase[],
  reference: ContractResolver,
  candidate: ContractResolver,
): string[] {
  return cases
    .filter(({ capture, query }) => {
      const signature = (resolver: ContractResolver) => {
        const result = resolver.resolve(capture, query);
        const identity = (element: Element | null) =>
          element
            ? [
                element["resource-id"],
                element["view-id"],
                boundsKey(element),
                element.text,
                element["content-desc"],
                element["ios-accessibility-label"],
                element.value,
                element.class ?? element.className,
                element["test-tag"],
                stableNodeSelectorForElement(element),
                element.clickable,
                element["long-clickable"],
                element.longClickable,
                element.actions,
              ]
            : null;
        return JSON.stringify({
          chosen: identity(result.chosen),
          candidates: result.candidates.map(identity),
        });
      };
      return signature(reference) !== signature(candidate);
    })
    .map(({ key }) => key);
}

/** Finding-keyed exact cases, never whole-fixture exemptions. Stale entries must be removed. */
export function ratchetFailures(
  actual: string[],
  allowed: Record<string, string[]>,
): { unexpected: string[]; stale: string[] } {
  const entries = Object.values(allowed).flat();
  return {
    unexpected: actual.filter((key) => !entries.includes(key)),
    stale: entries.filter((key) => !actual.includes(key)),
  };
}
