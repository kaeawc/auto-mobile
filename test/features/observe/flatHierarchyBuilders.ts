import type {
  Hierarchy,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";

/**
 * Android and cleaned iOS nodes are flat: attributes such as `text` and `resource-id` sit
 * directly on the node (see `nodeAttributes`). The production node type only names the
 * structural keys, so fixtures that carry flat attributes use this open-ended extension.
 */
export interface FlatHierarchyNode extends ViewHierarchyNode {
  [attribute: string]: unknown;
  node?: FlatHierarchyNode[];
}

export type FlatHierarchyResult = Omit<ViewHierarchyResult, "hierarchy"> & {
  hierarchy: Omit<Hierarchy, "node"> & { node?: FlatHierarchyNode };
};

/** Typed identity: a flat-attribute capture is assignable to the production result type. */
export function createFlatHierarchyForTest(fixture: FlatHierarchyResult): ViewHierarchyResult {
  return fixture;
}

export type ObserveResultOverrides = Omit<Partial<ObserveResult>, "viewHierarchy"> & {
  viewHierarchy?: FlatHierarchyResult;
};

/** A complete observation with neutral defaults; each test overrides only what it exercises. */
export function createObserveResultForTest(overrides: ObserveResultOverrides = {}): ObserveResult {
  return {
    observationId: "test-observation",
    updatedAt: 1_700_000_000_000,
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    screenSize: { width: 1080, height: 2400 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  };
}

/**
 * Reads an output node's flat attributes (`enabled`, `resource-id`, ...). The production node type
 * names only structural keys, so this returns a copy of the node's own entries as an open record.
 */
export function flatNodeAttributes(node: object | undefined): Record<string, unknown> {
  return node === undefined ? {} : Object.fromEntries(Object.entries(node));
}
