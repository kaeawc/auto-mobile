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
import type { ElementSelectionStrategy } from "../../../src/models/ElementSelectionStrategy";

export interface ContractCapture {
  name: string;
  hierarchy: ViewHierarchyResult;
  platform: "android" | "ios";
  scopedQueries?: { query: ContractQuery; bounds: number[] }[];
}
export interface ContractQuery {
  kind: "elementId" | "text" | "testTag";
  value: string;
  index?: number;
  intent?: "tap" | "focus-input";
  container?: { elementId?: string; text?: string };
  sibling?: boolean;
  strategy?: ElementSelectionStrategy;
}
export interface ContractResolution {
  candidates: Element[];
  chosen: Element | null;
}
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
        Record<string, ViewHierarchyNode> & {
          contractScopedQueries?: { query: ContractQuery; bounds: number[] }[];
        };
      if (value.viewHierarchy) {
        return [
          {
            name: entry.name,
            hierarchy: value.viewHierarchy,
            platform: entry.name.startsWith("ios-") ? "ios" : "android",
            scopedQueries: value.contractScopedQueries,
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

export function observedRows(capture: ContractCapture): SkeletonElement[] {
  const elements = new DefaultObserveElementCollector().collect(
    capture.hierarchy,
    capture.platform,
  )!;
  return projectSkeleton(elements).skeleton;
}

export function contractCases(capture: ContractCapture): ContractCase[] {
  const skeleton = observedRows(capture);
  if (capture.scopedQueries) {
    return capture.scopedQueries.map(({ query, bounds }) => {
      const observed = skeleton.find((element) => element.bounds.join(",") === bounds.join(","));
      if (!observed) {
        throw new Error(`Scoped contract target missing from ${capture.name}: ${bounds.join(",")}`);
      }
      return {
        key: `${capture.name}:${JSON.stringify(query)}:${bounds.join(",")}`,
        capture,
        query,
        observed,
      };
    });
  }
  return skeleton.flatMap((observed, row) => {
    // The keyboard mode summary is deliberately not an addressable node.
    if (observed.elementId === "<ime>") {
      return [];
    }
    const queries: ContractQuery[] = [];
    if (observed.elementId) {
      queries.push({ kind: "elementId", value: observed.elementId, index: observed.index });
      if (observed.index === 0) {
        queries.push({ kind: "elementId", value: observed.elementId });
      }
    }
    if (observed.label) {
      const peers = skeleton.filter((entry) => entry.label === observed.label);
      const rankedPeers = [...peers].sort((a, b) => {
        const area = (entry: SkeletonElement) =>
          (entry.bounds[2] - entry.bounds[0]) * (entry.bounds[3] - entry.bounds[1]);
        return area(a) - area(b) || skeleton.indexOf(a) - skeleton.indexOf(b);
      });
      const index =
        peers.length > 1
          ? ((observed.elementId === undefined ? observed.index : undefined) ??
            rankedPeers.indexOf(observed))
          : undefined;
      queries.push({ kind: "text", value: observed.label, index });
      if (observed.affordances.includes("input")) {
        const inputPeers = skeleton.filter(
          (entry) => entry.label === observed.label && entry.affordances.includes("input"),
        );
        const focusIndex =
          inputPeers.length > 1
            ? skeleton
                .slice(0, row)
                .filter(
                  (entry) => entry.label === observed.label && entry.affordances.includes("input"),
                ).length
            : undefined;
        queries.push({
          kind: "text",
          value: observed.label,
          index: focusIndex,
          intent: "focus-input",
        });
        if (focusIndex === 0) {
          queries.push({ kind: "text", value: observed.label, intent: "focus-input" });
        }
      }
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
    if (
      testCase.query.kind !== "text" ||
      testCase.query.container ||
      testCase.query.sibling ||
      testCase.query.strategy
    ) {
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

export function boundsKey(element: Element | null): string | null {
  if (!element) {
    return null;
  }
  const { left, top, right, bottom } = element.bounds;
  return [left, top, right, bottom].join(",");
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
