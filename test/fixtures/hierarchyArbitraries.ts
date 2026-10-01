import fc from "fast-check";
import type {
  ElementBounds,
  NodeAttributes,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../src/models";

export interface LogicalNode {
  attrs: NodeAttributes;
  bounds?: ElementBounds;
  children: LogicalNode[];
}

const ATTRIBUTE_KEYS = [
  "class",
  "text",
  "resource-id",
  "content-desc",
  "test-tag",
  "clickable",
  "long-clickable",
  "enabled",
  "focusable",
  "scrollable",
  "actions",
] as const;

const attributeValueArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constant("true"),
  fc.constant(true),
  fc.constant(""),
);

export const viewIdArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 10 }).map((name) => `com.example:id/${name}`),
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.uuid(),
  fc.stringMatching(/^[0-9a-f]{16}$/).map((hex) => `s2-${hex}`),
  fc
    .tuple(fc.stringMatching(/^[0-9a-f]{16}$/), fc.integer({ min: 0, max: 20 }))
    .map(([hex, ordinal]) => `s2-${hex}-${ordinal}`),
  fc.stringMatching(/^[0-9a-f]{15}$/).map((hex) => `s2-${hex}`),
  fc.constant("s-a"),
);

export const boundsArb: fc.Arbitrary<ElementBounds> = fc.record({
  left: fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
  ),
  top: fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
  ),
  right: fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
  ),
  bottom: fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
  ),
});

export const logicalNodeArb: fc.Arbitrary<LogicalNode> = fc.letrec<{ node: LogicalNode }>(
  (tie) => ({
    node: fc.record({
      attrs: fc
        .dictionary(fc.constantFrom(...ATTRIBUTE_KEYS), attributeValueArb, { maxKeys: 6 })
        .chain((attrs) =>
          fc.option(viewIdArb, { nil: undefined }).map((viewId) => ({
            ...attrs,
            ...(viewId !== undefined ? { "view-id": viewId } : {}),
          })),
        ),
      bounds: fc.option(boundsArb, { nil: undefined }),
      children: fc.oneof(
        { maxDepth: 3, depthSize: "small" },
        fc.constant<LogicalNode[]>([]),
        fc.array(tie("node"), { maxLength: 3 }),
      ),
    }),
  }),
).node;

export function encodeAndroidFlat(node: LogicalNode): ViewHierarchyNode {
  return {
    ...node.attrs,
    ...(node.bounds ? { bounds: node.bounds } : {}),
    ...(node.children.length > 0 ? { node: node.children.map(encodeAndroidFlat) } : {}),
  } as ViewHierarchyNode;
}

export function encodeIosDollar(node: LogicalNode): ViewHierarchyNode {
  return {
    $: { ...node.attrs },
    ...(node.bounds ? { bounds: node.bounds } : {}),
    ...(node.children.length > 0 ? { node: node.children.map(encodeIosDollar) } : {}),
  };
}

export function encodeCleanedRoot(node: LogicalNode): ViewHierarchyResult {
  return { hierarchy: { hierarchy: encodeAndroidFlat(node) } as ViewHierarchyResult["hierarchy"] };
}

export function withWindows(
  hierarchy: ViewHierarchyResult,
  roots: ViewHierarchyNode[] = [
    hierarchy.hierarchy.node ?? (hierarchy.hierarchy as ViewHierarchyNode),
  ],
): ViewHierarchyResult {
  return {
    ...hierarchy,
    windows: roots.map((root, index) => ({ windowLayer: index, hierarchy: { node: root } })),
  };
}
