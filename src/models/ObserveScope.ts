import type { ElementBounds } from "./ElementBounds";

/**
 * Wire-data types for the `observe` progressive-disclosure scoping experiments
 * (issue #4344). Kept in `models/` (not the feature module) so `ObserveResult`
 * can carry `observeScope` without depending on `features/`. The transforms that
 * produce these live in `features/observe/output/ObserveScopeExperiments.ts`.
 */

/** A normalized crop box, each coordinate in [0, 1]; `(0,0)` is the top-left. */
export interface NormalizedRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A semantic anchor for FOCUS: match the first node by resource-id or text. */
export interface FocusAnchor {
  resourceId?: string;
  text?: string;
}

/**
 * Per-call scoping request carried on the `observe` tool input (`scope`). The
 * agent chooses where to zoom on THIS screen — env vars can't vary per call.
 * Each dimension is honored only when its server experiment flag is enabled.
 *
 *  - `focus`: `true` scopes to the foreground app; an anchor object scopes to the
 *    first node matching `resourceId`/`text`.
 *  - `region`: `true` crops to the inset content rectangle; a box crops to that
 *    normalized rectangle.
 *  - `overview`: `true` collapses to the container skeleton.
 */
export interface ObserveScopeInput {
  focus?: boolean | FocusAnchor;
  region?: boolean | NormalizedRegion;
  overview?: boolean;
}

/** Which scope transform ran, in application order. */
export type ObserveScopeKind = "focus" | "region" | "overview";

/** Measurement metadata attached to a scoped `ObserveResult` (`observeScope`). */
export interface ObserveScopeMetadata {
  /** Transforms that actually changed the tree, in application order. */
  applied: ObserveScopeKind[];
  /** Hierarchy node count before any scoping. */
  nodesBefore: number;
  /** Hierarchy node count after all scoping. */
  nodesAfter: number;
  /** The pixel rectangle REGION cropped to, when REGION applied. */
  regionPx?: ElementBounds;
  /** How FOCUS resolved its subtree, when FOCUS applied. */
  focus?: {
    by: "anchor" | "foreground-app";
    matched: boolean;
    packageName?: string;
  };
}
