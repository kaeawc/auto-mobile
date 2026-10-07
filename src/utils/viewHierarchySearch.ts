import type { ViewHierarchyResult } from "../models";
import { serverConfig } from "./ServerConfig";

const RAW_VIEW_HIERARCHY_SYMBOL = Symbol.for("automobile.rawViewHierarchy");

type RawHierarchyCarrier = {
  [RAW_VIEW_HIERARCHY_SYMBOL]?: ViewHierarchyResult;
};

/** The uncleaned capture attached to a cleaned projection, independent of the raw-search flag. */
export const getRawViewHierarchy = (
  viewHierarchy: ViewHierarchyResult,
): ViewHierarchyResult | undefined => {
  return (viewHierarchy as RawHierarchyCarrier)[RAW_VIEW_HIERARCHY_SYMBOL];
};

export const attachRawViewHierarchy = (
  target: ViewHierarchyResult,
  raw: ViewHierarchyResult,
): void => {
  if (target === raw) {
    return;
  }
  const existing = getRawViewHierarchy(target);
  if (existing === raw) {
    return;
  }
  Object.defineProperty(target, RAW_VIEW_HIERARCHY_SYMBOL, {
    value: raw,
    enumerable: false,
    configurable: true,
  });
};

export const resolveViewHierarchyForSearch = (
  viewHierarchy: ViewHierarchyResult | null | undefined,
): ViewHierarchyResult | undefined => {
  if (!viewHierarchy) {
    return undefined;
  }
  if (!serverConfig.isRawElementSearchEnabled()) {
    return viewHierarchy;
  }
  return getRawViewHierarchy(viewHierarchy) ?? viewHierarchy;
};
