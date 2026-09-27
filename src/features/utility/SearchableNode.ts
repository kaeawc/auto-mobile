import { foldSearchableLabels, inheritsOwnerLabel } from "./SearchableLabels";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "./ElementParser";
import type { Element } from "../../models/Element";
import { isTruthy } from "../../models/Element";
import type { ElementBounds } from "../../models/ElementBounds";
import type { Affordance } from "../../models/ObserveResult";
import { parseBounds } from "../../utils/bounds";
import {
  getToggleContentDescription,
  hasAccessibilityAction,
  isClickableElementProperties,
  isCollectionElementProperties,
  isEditableElementProperties,
} from "../../utils/elementProperties";

/** Capture fields shared by observation and resolution; promotion is action-dependent. */
export interface SearchableNode {
  nativeId?: string;
  nodeKey?: string;
  elementId?: string;
  label?: string;
  textFields: readonly string[];
  textSources: Readonly<Record<string, string>>;
  accessibleLabel?: string;
  testTag?: string;
  className?: string;
  focusable: boolean;
  collection: boolean;
  bounds?: ElementBounds;
  actionable: boolean;
  affordances: Affordance[];
  categoryText?: string;
  categories: { clickable: boolean; scrollable: boolean; text: boolean };
}

type SearchableProperties = Omit<Partial<Element>, "bounds"> & { bounds?: unknown };

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function deriveAffordances(properties: SearchableProperties): Affordance[] {
  const editable = isEditableElementProperties(properties);
  const affordances: Affordance[] = [];
  if (isTruthy(properties.clickable) || hasAccessibilityAction(properties.actions, "click")) {
    affordances.push("tap");
  }
  if (
    isTruthy(properties["long-clickable"]) ||
    isTruthy(properties.longClickable) ||
    hasAccessibilityAction(properties.actions, "long_click")
  ) {
    affordances.push("long-press");
  }
  if (editable) {
    affordances.push("input");
  }
  if (isTruthy(properties.scrollable)) {
    affordances.push("scroll");
  }
  if (isTruthy(properties.checkable)) {
    affordances.push("toggle");
  }
  return affordances;
}

/** Derive identity, display label and selector fields once, without dropping unbounded nodes. */
export function toSearchable(properties: SearchableProperties): SearchableNode {
  const nativeId = nonEmptyString(properties["resource-id"]);
  const nodeKey = nonEmptyString(properties["view-id"]);
  const text = nonEmptyString(properties.text);
  const description = nonEmptyString(properties["content-desc"]);
  const accessibleLabel = nonEmptyString(properties["ios-accessibility-label"]);
  const editable = isEditableElementProperties(properties);
  const value = editable ? nonEmptyString(properties.value) : undefined;
  const label = [
    getToggleContentDescription(properties),
    value,
    text,
    description,
    accessibleLabel,
  ].find(Boolean);
  const parsedBounds = parseBounds(properties.bounds);
  const bounds =
    parsedBounds && Object.values(parsedBounds).every(Number.isFinite) ? parsedBounds : undefined;
  const affordances = deriveAffordances(properties);
  // Preserve the full observe text category even when the skeleton prefers an editable value.
  const categoryText = text ?? description ?? accessibleLabel;
  return {
    nativeId,
    nodeKey,
    elementId: nativeId ?? nodeKey,
    label,
    accessibleLabel,
    textSources: Object.fromEntries(
      Object.entries({
        text,
        "content-desc": description,
        "ios-accessibility-label": accessibleLabel,
        value,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    textFields: [
      ...new Set(
        [label, value, text, description, accessibleLabel].filter(
          (field): field is string => field !== undefined,
        ),
      ),
    ],
    testTag: nonEmptyString(properties["test-tag"]),
    className: [properties.class, properties.className].map(nonEmptyString).find(Boolean),
    focusable: isTruthy(properties.focusable),
    collection: isCollectionElementProperties(properties),
    bounds,
    actionable: bounds !== undefined && affordances.length > 0,
    affordances,
    categoryText,
    categories: {
      clickable: isClickableElementProperties(properties) || isTruthy(properties.checkable),
      scrollable: isTruthy(properties.scrollable),
      text: nonEmptyString(categoryText) !== undefined,
    },
  };
}

export interface SearchableEntry extends SearchableNode {
  source: ViewHierarchyNode;
  properties: Element;
  element?: Element;
  depth: number;
  index: number;
  parentIndex?: number;
  rootGroup: number;
  windowRank: number;
}

/** One immutable capture's flattened nodes. The capture object is the cache identity. */
export class SearchableHierarchy {
  private readonly captures = new WeakMap<ViewHierarchyResult, readonly SearchableEntry[]>();

  constructor(private readonly parser: ElementParser = new DefaultElementParser()) {}

  project(capture: ViewHierarchyResult): readonly SearchableEntry[] {
    const cached = this.captures.get(capture);
    if (cached) {
      return cached;
    }
    const windows = this.parser.extractWindowRootGroups(capture, "topmost-first");
    let rootGroup = 0;
    const roots = [
      ...this.parser
        .extractRootNodes(capture)
        .map((root) => ({ root, group: 0, rank: windows.length })),
      ...windows.flatMap((windowRoots, rank) =>
        windowRoots.map((root) => ({ root, group: ++rootGroup, rank })),
      ),
    ];
    const entries: SearchableEntry[] = [];
    for (const { root, group, rank } of roots) {
      const ancestors: SearchableEntry[] = [];
      this.parser.traverseNode(root, (source, depth) => {
        while (ancestors.length && ancestors[ancestors.length - 1].depth >= depth) {
          ancestors.pop();
        }
        const properties = this.parser.extractNodeProperties(source);
        const element = this.parser.parseNodeBounds(source) ?? undefined;
        const raw = toSearchable(properties);
        const entry: SearchableEntry = {
          ...toSearchable(element ?? properties),
          categories: raw.categories,
          categoryText: raw.categoryText,
          source,
          properties,
          element,
          depth,
          index: entries.length,
          parentIndex: ancestors.at(-1)?.index,
          rootGroup: group,
          windowRank: rank,
        };
        entries.push(entry);
        ancestors.push(entry);
      });
    }
    hoistSearchableLabels(entries);
    attributeSearchableLabels(entries);
    this.captures.set(capture, entries);
    return entries;
  }
}

function hoistSearchableLabels(entries: SearchableEntry[]): void {
  const groups = new Map<SearchableEntry, SearchableEntry[]>();
  for (const entry of entries) {
    if (entry.label === undefined || entry.affordances.length > 0 || !entry.bounds) {
      continue;
    }
    let parent = entry.parentIndex;
    while (parent !== undefined) {
      const ancestor = entries[parent];
      if (ancestor.affordances.includes("tap") && ancestor.bounds) {
        const texts = groups.get(ancestor) ?? [];
        texts.push(entry);
        groups.set(ancestor, texts);
        break;
      }
      parent = ancestor.parentIndex;
    }
  }
  for (const [row, texts] of groups) {
    texts.sort((a, b) => a.bounds!.top - b.bounds!.top || a.bounds!.left - b.bounds!.left);
    const parts = [
      ...new Set(texts.map((text) => text.label!).filter((label) => label !== row.label)),
    ];
    const folded = foldSearchableLabels(row, parts);
    row.label = folded.label?.trim();
    row.textFields = [
      ...new Set(
        [row.label, ...row.textFields, ...parts].filter(
          (field): field is string => field !== undefined,
        ),
      ),
    ];
  }
}

/** Snapshot labelled owners so inherited labels never chain between controls. */
function attributeSearchableLabels(entries: SearchableEntry[]): void {
  const labelled = new Set(entries.filter((entry) => entry.label !== undefined && entry.bounds));
  for (const entry of entries) {
    if (entry.label !== undefined || !inheritsOwnerLabel(entry.affordances)) {
      continue;
    }
    let parent = entry.parentIndex;
    while (parent !== undefined) {
      const ancestor = entries[parent];
      if (labelled.has(ancestor)) {
        entry.label = ancestor.label;
        entry.textFields = [...entry.textFields, ancestor.label!];
        break;
      }
      parent = ancestor.parentIndex;
    }
  }
}
