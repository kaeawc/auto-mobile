import {
  TapTargetUnavailableError,
  selectionHierarchyFor,
  type TapFocusFailure,
} from "./tapTargetSupport";
import type { HierarchyLayer } from "../../models/HierarchyLayer";
import type { Element, TapOnElementResult, ViewHierarchyResult } from "../../models";
import { hasOwnPrototype, scopeHierarchyToLayer } from "../observe/hierarchyLayer";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { DefaultElementParser } from "../utility/ElementParser";

/** Internal focus evidence; symbol keys never enter JSON tool output. */
export const tapFocusFailure: unique symbol = Symbol("tapFocusFailure");
export const tapResolvedLayer: unique symbol = Symbol("tapResolvedLayer");
export type { TapFocusFailure };
/** Classify the already resolved node in the captured window scopes, without another read. */
export function resolvedElementLayer(
  hierarchy: ViewHierarchyResult,
  element: Element,
  platform: "android" | "ios",
): HierarchyLayer | undefined {
  if (!hasOwnPrototype(hierarchy)) {
    return undefined;
  }
  hierarchy = selectionHierarchyFor(element, hierarchy, platform);
  const source = getHierarchyNodeSource(element);
  if (!source) {
    return undefined;
  }
  const parser = new DefaultElementParser();
  for (const layer of ["prototype", "app"] as const) {
    const entries = parser.flattenViewHierarchy(scopeHierarchyToLayer(hierarchy, layer), {
      includeWindows: true,
    });
    if (entries.some((entry) => getHierarchyNodeSource(entry.element) === source)) {
      return layer;
    }
  }
  return undefined;
}

export type TapOnFocusResult = TapOnElementResult & {
  [tapFocusFailure]?: TapFocusFailure;
  [tapResolvedLayer]?: HierarchyLayer;
};
/** Keep routing metadata available to internal callers without exposing it in MCP payloads. */
export function withResolvedLayer<T extends TapOnFocusResult>(
  result: T,
  layer: HierarchyLayer | undefined,
): T {
  if (layer !== undefined) {
    Object.defineProperty(result, tapResolvedLayer, {
      value: layer,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function markFocusFailure(
  action: string,
  result: TapOnElementResult,
  error: unknown,
): TapOnFocusResult {
  if (action === "focus" && error instanceof TapTargetUnavailableError) {
    Object.defineProperty(result, tapFocusFailure, { value: error.reason });
  }
  return result;
}
