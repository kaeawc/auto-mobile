import type { ResolutionAction } from "../../models/ResolutionAction";
import type { ResolverSelector } from "../../models/elementSelectorSchemas";
import type { SearchableEntry } from "./SearchableNode";
import type { ElementBounds } from "../../models/ElementBounds";

export type MatchMode = "exact" | "contains" | "regex";

export interface ResolverSnapshot {
  id: string;
  nodes: readonly SearchableEntry[];
  /** Optional search/ID-namespace subset; `nodes` retains the original ancestry indexes. */
  searchedNodes?: readonly SearchableEntry[];
}

export interface ElementReference {
  snapshotId: string;
  nodeKey: string;
  bounds?: ElementBounds;
  label?: string;
  nativeId?: string;
}

export interface ResolutionIntent {
  action: ResolutionAction;
  /** Preserve tap ranking while inspect keeps bounded inert labels addressable. */
  preferTap?: boolean;
  /** Prefer bounded checkable matches and their checkable descendants. */
  preferToggle?: boolean;
  /**
   * Leave the soft keyboard's keys out of the search and out of `index` numbering,
   * as `observe` folds them into one `<ime>` row (issue #10225).
   */
  excludeImeKeys?: boolean;
  /** An action lookup cannot use an unbounded ID match as its target. */
  requireBounds?: boolean;
  viewport?: { width: number; height: number };
  requireResourceId?: boolean;
  negative?: boolean;
  /** Action targets may use Android editable hints only after primary text misses. */
  allowHintFallback?: boolean;
  matchMode?: MatchMode;
  ref?: ElementReference;
}

export type MatchKind =
  | "native-id-exact"
  | "node-key-exact"
  | "id-namespace"
  | "text-exact"
  | "test-tag-exact"
  | "test-tag-resource-id"
  | "contains"
  | "regex"
  | "class-exact"
  | "all";

export interface ContainerFailure {
  level: number;
  reason: "not-found" | "ambiguous";
  selector: ResolverSelector;
}

export interface ResolvedScope {
  selector: ResolverSelector;
  node: SearchableEntry;
  matchCount: number;
}

export interface ElementResolution {
  chosen: SearchableEntry | null;
  snapshotNodes?: readonly SearchableEntry[];
  indexInMatches?: number;
  candidates: SearchableEntry[];
  matches: {
    node: SearchableEntry;
    kind: MatchKind;
    sourceNodes?: SearchableEntry[];
    textOrigin?: "raw" | "displayed";
  }[];
  matchMode: MatchMode;
  scope?: SearchableEntry;
  scopeChain?: ResolvedScope[];
  containerFailure?: ContainerFailure;
  error?: string;
  /** Typed failure classification, set where selection fails. */
  failureReason?: ContainerFailure["reason"];
}

export type { ResolutionAction } from "../../models/ResolutionAction";
