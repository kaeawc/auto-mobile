/**
 * The interactive half of the observe App spike (#17767): an element picker layered on the
 * read-only shell in `observeAppShellClient.ts`. It is served only when the
 * `observe-app-interactive` feature flag is on (off by default) and the client advertises MCP Apps.
 *
 * Like the shell client, every function here is serialised into the page's single inline
 * `<script>` (via `Function.prototype.toString`), so each may reference only its own arguments,
 * built-ins, the shell client functions and the other functions listed in
 * `OBSERVE_PICKER_CLIENT_FUNCTIONS`: no imports, no module state.
 *
 * What it adds over the read-only shell, and nothing else:
 * - one transparent hit target per element that has a selector, drawn smallest-on-top so a click
 *   picks the innermost element;
 * - a panel showing the picked element's `tapOn` selector as JSON (via `textContent`);
 * - a button that asks the HOST to run `tools/call tapOn { selector }`. The host decides whether to
 *   forward it (and whether to ask the user first); the page never talks to the server directly.
 *
 * It never sends any other request: no `resources/read`, `ui/message`, `ui/open-link` or
 * `ui/update-model-context`, and no tool other than `tapOn`.
 */
import { shellBoot, shellBoundsOf, shellCollectWith, shellLabelOf } from "./observeAppShellClient";
import type {
  ShellBox,
  ShellDocument,
  ShellMessageEvent,
  ShellNode,
  ShellWindow,
} from "./observeAppShellClient";

/** A `tapOn` selector: exactly one of `elementId` or `text`. */
type PickerSelector = { elementId: string } | { text: string };

interface PickerTarget extends ShellBox {
  selector: PickerSelector;
  /** Another visible element has the same selector, so `tapOn` could act on either one. */
  ambiguous: boolean;
}

/** The extra DOM operations the picker uses on top of the shell's. */
interface PickerNode extends ShellNode {
  addEventListener(type: "click", listener: () => void): void;
  removeAttribute(name: string): void;
}

interface PickerDocument extends ShellDocument {
  createElementNS(ns: string, name: string): PickerNode;
  getElementById(id: string): PickerNode | null;
}

/** Mutable page state, held in one object the boot function creates and passes around. */
interface PickerState {
  selected: PickerTarget | null;
  nextId: number;
  pending: Map<number, string>;
  deviceId: string;
  /** Panel key of the delivered observation (`structuredContent.display.key`), or "". */
  display: string;
}

/**
 * The `tapOn` selector for an element: its resource id when it has one (most stable), else its
 * visible text, else its content description (which `tapOn`'s `text` selector also matches).
 */
function pickerSelectorOf(node: Record<string, unknown>): PickerSelector | null {
  // This runs in the browser over a delivered (untrusted) result, so the server's element
  // resolver is not available; the key table mirrors `shellLabelOf`.
  const sources: Array<[string, "elementId" | "text"]> = [
    ["resource-id", "elementId"],
    ["text", "text"],
    ["content-desc", "text"],
    ["contentDescription", "text"],
  ];
  for (const [key, field] of sources) {
    const value = node[key];
    if (typeof value === "string" && value.trim() !== "" && value.length <= 500) {
      return field === "elementId" ? { elementId: value } : { text: value };
    }
  }
  return null;
}

/** A pickable target for [node], or null when it has no valid bounds or no selector. */
function pickerTargetOf(node: Record<string, unknown>): PickerTarget | null {
  const bounds = shellBoundsOf(node.bounds);
  const selector = pickerSelectorOf(node);
  return bounds && selector
    ? { ...bounds, label: shellLabelOf(node), selector, ambiguous: false }
    : null;
}

/** Every pickable element in a delivered `observe` result, largest first (so smallest draws on top). */
function pickerTargetsOf(result: unknown): PickerTarget[] {
  const structured = (result as Record<string, unknown> | null)?.structuredContent as
    | Record<string, unknown>
    | undefined;
  const hierarchy = structured?.viewHierarchy;
  if (typeof hierarchy !== "object" || hierarchy === null) {
    return [];
  }
  const area = (box: ShellBox) =>
    Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
  const targets = shellCollectWith(hierarchy, pickerTargetOf).boxes as PickerTarget[];
  const counts = new Map<string, number>();
  for (const target of targets) {
    const key = JSON.stringify(target.selector);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const target of targets) {
    target.ambiguous = (counts.get(JSON.stringify(target.selector)) ?? 0) > 1;
  }
  return targets.sort((a, b) => area(b) - area(a));
}

/** The selection panel's label; an ambiguous selector says why it cannot be tapped. */
function pickerLabelOf(target: PickerTarget | null): string {
  if (!target) {
    return "Select an element";
  }
  const label = target.label || "(unlabelled element)";
  return target.ambiguous
    ? `${label} (selector matches more than one element; not tappable)`
    : label;
}

/** Shows [target] as the current selection; enables the tap button only for a unique selector. */
function pickerSelect(doc: PickerDocument, state: PickerState, target: PickerTarget | null): void {
  state.selected = target;
  const selector = doc.getElementById("selector");
  const label = doc.getElementById("selection");
  const button = doc.getElementById("tap");
  if (selector) {
    selector.textContent = target ? JSON.stringify(target.selector) : "";
  }
  if (label) {
    label.textContent = pickerLabelOf(target);
  }
  if (button) {
    if (target && !target.ambiguous) {
      button.removeAttribute("disabled");
    } else {
      button.setAttribute("disabled", "");
    }
  }
}

/** Draws one transparent hit target per pickable element over the shell's rendered canvas. */
function pickerDecorate(doc: PickerDocument, state: PickerState, params: unknown): void {
  pickerSelect(doc, state, null);
  const canvas = doc.getElementById("canvas");
  const targets = pickerTargetsOf(params);
  const structured = (params as Record<string, unknown> | null)?.structuredContent as
    | Record<string, unknown>
    | undefined;
  state.deviceId = typeof structured?.deviceId === "string" ? structured.deviceId : "";
  // Taps must go to the panel the user picked from: without `display`, tapOn acts on the
  // default panel of a multi-display device.
  const display = structured?.display as Record<string, unknown> | undefined;
  state.display = typeof display?.key === "string" ? display.key : "";
  if (!canvas || targets.length === 0) {
    return;
  }
  const group = doc.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("id", "picks");
  for (const target of targets) {
    const rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "am-pick");
    rect.setAttribute("x", String(target.left));
    rect.setAttribute("y", String(target.top));
    rect.setAttribute("width", String(Math.max(0, target.right - target.left)));
    rect.setAttribute("height", String(Math.max(0, target.bottom - target.top)));
    rect.addEventListener("click", () => pickerSelect(doc, state, target));
    group.appendChild(rect);
  }
  canvas.appendChild(group);
}

/** The `tools/call` request for tapping [target]: the only request the picker ever sends. */
function pickerTapRequest(
  target: PickerTarget,
  id: number,
  deviceId: string,
  display = "",
): Record<string, unknown> {
  // "unique" makes the server refuse rather than tap the first of several matches, covering
  // elements this result did not show (e.g. off-screen rows).
  const args: Record<string, unknown> = { selector: target.selector, selectionStrategy: "unique" };
  // A text pick must not fall back to a substring match on a different element ("Remove" vs
  // "Remove all") once the picked one is gone; the server reports it as no longer present.
  if ("text" in target.selector) {
    args.exactText = true;
  }
  if (deviceId) {
    args.deviceId = deviceId;
  }
  if (display) {
    args.display = display;
  }
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "tapOn", arguments: args } };
}

/** Sends a `tapOn` for the current selection through the host. */
function pickerTap(win: ShellWindow, doc: PickerDocument, state: PickerState): void {
  const target = state.selected;
  const status = doc.getElementById("tap-status");
  if (!target || target.ambiguous) {
    return;
  }
  const id = state.nextId++;
  state.pending.set(id, target.label || JSON.stringify(target.selector));
  win.parent.postMessage(pickerTapRequest(target, id, state.deviceId, state.display), "*");
  if (status) {
    status.textContent = "Asked the host to tap…";
  }
}

/** Reports the host's reply to a pending `tapOn`; replies to anything else are ignored. */
function pickerOnReply(doc: PickerDocument, state: PickerState, message: Record<string, unknown>) {
  const id = message.id;
  if (typeof id !== "number" || !state.pending.has(id)) {
    return;
  }
  const label = state.pending.get(id);
  state.pending.delete(id);
  const status = doc.getElementById("tap-status");
  if (!status) {
    return;
  }
  const result = message.result as Record<string, unknown> | undefined;
  if (message.error !== undefined) {
    const error = message.error as Record<string, unknown> | null;
    const reason = typeof error?.message === "string" ? error.message.slice(0, 200) : "refused";
    status.textContent = `Host did not run tapOn: ${reason}`;
  } else if (result?.isError === true) {
    // tapOn's own message names the cause, e.g. that an exact-text pick is no longer present.
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const reason =
      typeof structured?.message === "string" ? `: ${structured.message.slice(0, 200)}` : "";
    status.textContent = `tapOn failed on ${label}${reason}`;
  } else {
    status.textContent = `Tapped ${label}. Run observe again to refresh.`;
  }
}

/**
 * Boots the read-only shell, then layers the picker on it. The shell's listener is registered
 * first, so it renders each result before the picker draws hit targets over it.
 */
function pickerBoot(win: ShellWindow, doc: PickerDocument): void {
  shellBoot(win, doc);
  const state: PickerState = {
    selected: null,
    nextId: 1000,
    pending: new Map(),
    deviceId: "",
    display: "",
  };
  doc.getElementById("tap")?.addEventListener("click", () => pickerTap(win, doc, state));
  win.addEventListener("message", (event: ShellMessageEvent) => {
    const message = event.data as Record<string, unknown> | null;
    if (event.source !== win.parent || typeof message !== "object" || message === null) {
      return;
    }
    if (message.jsonrpc !== "2.0") {
      return;
    }
    if (message.method === "ui/notifications/tool-result") {
      pickerDecorate(doc, state, message.params);
    } else if (message.method === undefined) {
      pickerOnReply(doc, state, message);
    }
  });
}

/** The picker functions, serialised after the shell's; dependencies first. */
export const OBSERVE_PICKER_CLIENT_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  pickerSelectorOf,
  pickerTargetOf,
  pickerTargetsOf,
  pickerLabelOf,
  pickerSelect,
  pickerDecorate,
  pickerTapRequest,
  pickerTap,
  pickerOnReply,
  pickerBoot,
];

export { pickerBoot, pickerSelectorOf, pickerTapRequest, pickerTargetsOf };
export type { PickerDocument, PickerNode, PickerSelector, PickerTarget };
