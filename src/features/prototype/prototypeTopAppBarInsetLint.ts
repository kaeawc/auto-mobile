/**
 * Advisory lint for a fullscreen `topAppBar` that never clears the status bar (#18394). Neither
 * renderer insets a bar on its own, so without top `safeAreaPadding` on the bar or an ancestor the
 * bar is drawn under the status bar. This reads the spec only and never refuses a show.
 */

import { expandPrototypeComponents } from "./prototypeComponents";
import { prototypeNodeChildren } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

/** Reports are capped so a spec with many screens stays one readable warning each. */
const MAX_TOP_APP_BAR_INSET_FINDINGS = 10;

/**
 * True when the node pads its top edge by an inset that includes the status bar. Absent `types`
 * counts as the default system-bars inset; a list without `systemBars` (e.g. `ime` or `cutout`
 * alone) never clears the status bar.
 */
function padsTop(node: Record<string, unknown>): boolean {
  const padding = record(node.safeAreaPadding);
  const edges = padding?.edges;
  if (!Array.isArray(edges) || !edges.includes("top")) {
    return false;
  }
  const types = padding?.types;
  return types === undefined || (Array.isArray(types) && types.includes("systemBars"));
}

/** True when the window is fullscreen and has no host dismiss bar clearing the status bar. */
function lintsWindow(window: Record<string, unknown> | undefined): boolean {
  const chrome = window?.chrome ?? (window?.persistence === "device" ? "bar" : "none");
  return record(window?.placement)?.type === "fullscreen" && chrome !== "bar";
}

/**
 * The spec paths of every `topAppBar` in a fullscreen window with no top system-bars
 * `safeAreaPadding` on itself or any ancestor. A sheet or floating window, or one with the host dismiss bar (`chrome:
 * "bar"`, the default with `persistence: "device"`, which already clears the status bar), reports
 * nothing.
 */
export function lintPrototypeTopAppBarInsets(spec: unknown): string[] {
  const data = record(spec);
  const root = record(data?.root);
  if (!root || !lintsWindow(record(data?.window))) {
    return [];
  }
  const paths: string[] = [];
  const pending: { node: Record<string, unknown>; path: string; padded: boolean }[] = [
    { node: root, path: "root", padded: false },
  ];
  while (pending.length > 0) {
    const { node, path, padded } = pending.pop()!;
    const clears = padded || padsTop(node);
    if (node.type === "topAppBar" && !clears) {
      paths.push(path);
    }
    const children = prototypeNodeChildren(node);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = record(children[index]!.value);
      if (child) {
        pending.push({ node: child, path: `${path}${children[index]!.suffix}`, padded: clears });
      }
    }
  }
  return paths;
}

/** One warning per uncleared bar, at its authored path (components are linted expanded). */
export function prototypeTopAppBarInsetWarnings(spec: unknown): string[] {
  const expansion = expandPrototypeComponents(spec);
  const linted = expansion.success ? expansion.spec : spec;
  const locate = expansion.success ? expansion.locate : (path: string) => path;
  return lintPrototypeTopAppBarInsets(linted)
    .slice(0, MAX_TOP_APP_BAR_INSET_FINDINGS)
    .map(
      (path) =>
        `${locate(path)}: topAppBar in a fullscreen window has no top safeAreaPadding on it or an ancestor, so it is drawn under the status bar. Add safeAreaPadding {"edges":["top"],"types":["systemBars"]} to the bar or its screen.`,
    );
}
