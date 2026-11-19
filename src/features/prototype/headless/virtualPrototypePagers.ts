import type { PrototypeState } from "../../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "../prototypeNodeChildren";

/**
 * Each root pager's position, as `PrototypeRuntime.boundPages` derives it on a show: a numeric
 * value of its `stateKey` first, else the retained position, else 0, clamped to its pages.
 */
export function boundPages(
  spec: Record<string, unknown>,
  state: PrototypeState,
  previous: Record<string, number>,
): Record<string, number> {
  const pages: Record<string, number> = {};
  walkPrototypeNodes({ root: spec.root }, (node) => {
    if (node.type !== "pager" || typeof node.id !== "string") {
      return;
    }
    const last = Math.max(0, (Array.isArray(node.children) ? node.children.length : 0) - 1);
    const bound = typeof node.stateKey === "string" ? state[node.stateKey] : undefined;
    // An own-property read: a pager id such as `constructor` must not find Object.prototype's.
    const kept = Object.hasOwn(previous, node.id) ? previous[node.id] : undefined;
    const position = typeof bound === "number" ? Math.trunc(bound) : (kept ?? 0);
    pages[node.id] = Math.min(Math.max(position, 0), last);
  });
  return pages;
}

/**
 * `state` with each integral value bound to a pager clamped to its pages, as
 * `PrototypeRuntime.normalizePagerState` writes it back, so state and pages never disagree.
 */
export function normalizePagerState(
  spec: Record<string, unknown>,
  state: PrototypeState,
): PrototypeState {
  const normalized = { ...state };
  walkPrototypeNodes({ root: spec.root }, (node) => {
    if (node.type !== "pager" || typeof node.stateKey !== "string") {
      return;
    }
    const value = normalized[node.stateKey];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return;
    }
    const last = Math.max(0, (Array.isArray(node.children) ? node.children.length : 0) - 1);
    normalized[node.stateKey] = Math.min(Math.max(value, 0), last);
  });
  return normalized;
}
