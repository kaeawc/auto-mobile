import { ActionableError } from "../../models/ActionableError";
import type { WatchHierarchy, WatchHierarchyNode } from "./WatchHierarchy";

/** A node read from one `XCUIElement.debugDescription` subtree line, before it gets bounds. */
export interface XcuiDebugLine {
  depth: number;
  type: string;
  frame?: WatchHierarchyNode["bounds"];
  identifier?: string;
  label?: string;
  value?: string;
}

const SUBTREE_HEADER = "Element subtree:";
const FRAME = /\{\{(-?[\d.]+), (-?[\d.]+)\}, \{(-?[\d.]+), (-?[\d.]+)\}\}/;
// Quoted values end at the closing quote followed by another known field or the end of the line,
// so a label holding an apostrophe or ", " still reads whole.
const NEXT_FIELD =
  "(?=$|, (?:identifier|label|value|placeholderValue|Selected|Disabled|Focused)\\b)";
const QUOTED_FIELDS = ["identifier", "label", "value"] as const;
const TAPPABLE_TYPES = new Set(["Button", "Cell", "Link", "Switch", "Key"]);

function readQuoted(fields: string, key: (typeof QUOTED_FIELDS)[number]): string | undefined {
  return new RegExp(`, ${key}: '(.*?)'${NEXT_FIELD}`).exec(fields)?.[1];
}

function readFrame(fields: string): WatchHierarchyNode["bounds"] | undefined {
  const match = FRAME.exec(fields);
  if (!match) {
    return undefined;
  }
  const [x, y, width, height] = match.slice(1).map(Number);
  return { left: x, top: y, right: x + width, bottom: y + height };
}

/** Parse one subtree line (`  Cell, 0x1, {{x, y}, {w, h}}, identifier: '…'`); undefined if not a node. */
export function parseXcuiDebugLine(line: string): XcuiDebugLine | undefined {
  const match = /^(\s*)(?:→)?([A-Za-z]+)((?:,.*)?)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const [, indent, type, fields] = match;
  const node: XcuiDebugLine = { depth: indent.length, type, frame: readFrame(fields) };
  for (const key of QUOTED_FIELDS) {
    const value = readQuoted(fields, key);
    if (value !== undefined) {
      node[key] = value;
    }
  }
  return node;
}

/** The indented node lines of the `Element subtree:` section, which ends at the next unindented line. */
function subtreeLines(dump: string): XcuiDebugLine[] {
  const lines = dump.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === SUBTREE_HEADER);
  if (start < 0) {
    return [];
  }
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .map(parseXcuiDebugLine)
    .filter((node): node is XcuiDebugLine => node !== undefined);
}

function toNode(line: XcuiDebugLine, inherited: WatchHierarchyNode["bounds"]): WatchHierarchyNode {
  return {
    className: line.type,
    // XCUI omits a frame on some lines; the parent frame keeps the node inside its container.
    bounds: line.frame ?? inherited,
    accessibilityIdentifier: line.identifier,
    accessibilityLabel: line.label ?? line.value,
    hasTapTarget: TAPPABLE_TYPES.has(line.type),
    children: [],
  };
}

function buildTree(
  lines: XcuiDebugLine[],
  screen: WatchHierarchyNode["bounds"],
): WatchHierarchyNode {
  const root = toNode(lines[0], screen);
  const stack: Array<{ depth: number; node: WatchHierarchyNode }> = [
    { depth: lines[0].depth, node: root },
  ];
  for (const line of lines.slice(1)) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= line.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].node;
    const node = toNode(line, parent.bounds);
    parent.children!.push(node);
    stack.push({ depth: line.depth, node });
  }
  return root;
}

/**
 * Parse an `XCUIApplication.debugDescription` dump into the watch runner's hierarchy envelope,
 * so it normalizes through `normalizeWatchHierarchy` like a runner-supplied tree. Bounds stay in
 * points; the screen size is the first window's frame.
 */
export function parseXcuiDebugDescription(
  dump: string,
  options: { bundleId: string; timestamp: number },
): WatchHierarchy {
  const lines = subtreeLines(dump);
  const screen = lines.find((line) => line.type === "Window" && line.frame)?.frame;
  if (lines.length === 0 || !screen) {
    throw new ActionableError(
      "The watch XCUI dump has no element subtree with a window frame; capture it again.",
    );
  }
  return {
    timestamp: options.timestamp,
    screenWidth: screen.right - screen.left,
    screenHeight: screen.bottom - screen.top,
    screenScale: 1,
    bundleId: options.bundleId,
    root: buildTree(lines, screen),
  };
}
