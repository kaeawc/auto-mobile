/**
 * The browser half of the live observe App shell (#4682). Every function here is serialised into
 * the shell's single inline `<script>` by `observeAppShell.ts` (via `Function.prototype.toString`),
 * so each one may reference only its own arguments, built-ins and the other functions listed in
 * `OBSERVE_SHELL_CLIENT_FUNCTIONS`: no imports, no module state. Tests run the same functions
 * against a fake window and document.
 *
 * Security posture (reviewed with the CSP in `observeAppShell.ts`):
 * - read-only: the shell only RECEIVES `ui/notifications/tool-result` and host context; it never
 *   sends `tools/call`, `resources/read`, `ui/message`, `ui/open-link` or any request except the
 *   mandatory `ui/initialize` handshake, so it cannot drive a device;
 * - it only accepts messages whose `source` is its own parent window;
 * - delivered data is untrusted: it is shape-checked, size-capped, and written with DOM
 *   `textContent`/`setAttribute` only (never `innerHTML`, `eval` or inline `style`);
 * - the screenshot is accepted only as base64 PNG/JPEG/WebP and shown through an SVG `<image>`
 *   whose `href` is a `data:` URI the CSP's `img-src data:` allows.
 */

// Caps on a delivered (untrusted) result, written as literals because the functions below are
// serialised on their own: 4000 boxes, 200,000 visited nodes, 80 levels of nesting, 160-character
// labels and 12,000,000 base64 characters of screenshot.

interface ShellBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  label: string;
}

interface ShellModel {
  boxes: ShellBox[];
  width: number;
  height: number;
  imageUri: string | null;
  deviceId: string;
  observationId: string;
  truncated: boolean;
}

interface ShellNode {
  setAttribute(name: string, value: string): void;
  appendChild(child: ShellNode): unknown;
  textContent: string | null;
  replaceChildren(...children: ShellNode[]): void;
}

interface ShellDocument {
  createElementNS(ns: string, name: string): ShellNode;
  getElementById(id: string): ShellNode | null;
  documentElement: ShellNode & { scrollWidth?: number; scrollHeight?: number };
}

interface ShellWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: "message", listener: (event: ShellMessageEvent) => void): void;
}

interface ShellMessageEvent {
  source: unknown;
  data: unknown;
}

/** Bounds of a finite-number `[left, top, right, bottom]` tuple, else null. */
function shellTupleBounds(
  value: unknown[],
): { left: number; top: number; right: number; bottom: number } | null {
  const [left, top, right, bottom] = value;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return value.length === 4 && finite(left) && finite(top) && finite(right) && finite(bottom)
    ? { left, top, right, bottom }
    : null;
}

/** Finite-number bounds from a compact `[l, t, r, b]` tuple or a `{left, top, right, bottom}` object. */
function shellBoundsOf(
  value: unknown,
): { left: number; top: number; right: number; bottom: number } | null {
  if (Array.isArray(value)) {
    return shellTupleBounds(value);
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { left, top, right, bottom } = value as Record<string, unknown>;
  return shellTupleBounds([left, top, right, bottom]);
}

/** The first non-empty string among an element's text, description, id and class, capped. */
function shellLabelOf(node: Record<string, unknown>): string {
  for (const key of ["text", "content-desc", "contentDescription", "resource-id", "className"]) {
    const value = node[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.slice(0, 160);
    }
  }
  return "";
}

/** The box for [node] when its `bounds` are valid; the label is display text only. */
function shellBoxOf(node: Record<string, unknown>): ShellBox | null {
  const bounds = shellBoundsOf(node.bounds);
  return bounds ? { ...bounds, label: shellLabelOf(node) } : null;
}

/** Walks any nesting of objects and arrays, collecting every node that carries valid bounds. */
function shellCollectBoxes(root: unknown): { boxes: ShellBox[]; truncated: boolean } {
  const boxes: ShellBox[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let truncated = false;
  let visited = 0;
  // Capped visits as well as boxes: a huge delivered payload with few bounds must not freeze the view.
  while (pending.length > 0 && boxes.length < 4000 && visited++ < 200_000) {
    const { value, depth } = pending.pop()!;
    if (typeof value !== "object" || value === null) {
      continue;
    }
    if (depth > 80) {
      truncated = true;
      continue;
    }
    const box = Array.isArray(value) ? null : shellBoxOf(value as Record<string, unknown>);
    if (box) {
      boxes.push(box);
    }
    const children: unknown[] = Array.isArray(value) ? value : Object.values(value);
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ value: children[index], depth: depth + 1 });
    }
  }
  return { boxes, truncated: truncated || pending.length > 0 };
}

/** A base64 PNG/JPEG/WebP content block as a `data:` URI, or null for anything else or too large. */
function shellImageUri(content: unknown): string | null {
  for (const block of Array.isArray(content) ? (content as unknown[]) : []) {
    const item = block as Record<string, unknown> | null;
    if (
      item &&
      item.type === "image" &&
      typeof item.mimeType === "string" &&
      /^image\/(?:png|jpeg|webp)$/.test(item.mimeType) &&
      typeof item.data === "string" &&
      item.data.length <= 12_000_000 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(item.data)
    ) {
      return `data:${item.mimeType};base64,${item.data}`;
    }
  }
  return null;
}

/** The structured observe payload (`structuredContent`); free-form text is never parsed. */
function shellPayloadOf(result: Record<string, unknown>): Record<string, unknown> | null {
  const structured = result.structuredContent;
  return typeof structured === "object" && structured !== null && !Array.isArray(structured)
    ? (structured as Record<string, unknown>)
    : null;
}

/** The screen's coordinate space: reported size first, else the extent of the boxes. */
function shellScreenSize(
  payload: Record<string, unknown>,
  boxes: ShellBox[],
): { width: number; height: number } {
  const positive = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  const screen = payload.screenSize as Record<string, unknown> | undefined;
  if (screen && positive(screen.width) && positive(screen.height)) {
    return { width: screen.width, height: screen.height };
  }
  const hierarchy = payload.viewHierarchy as Record<string, unknown> | undefined;
  if (hierarchy && positive(hierarchy.screenWidth) && positive(hierarchy.screenHeight)) {
    return { width: hierarchy.screenWidth, height: hierarchy.screenHeight };
  }
  return {
    width: boxes.reduce((max, box) => Math.max(max, box.right), 0) || 1,
    height: boxes.reduce((max, box) => Math.max(max, box.bottom), 0) || 1,
  };
}

/** The renderable model of one delivered `observe` tool result, or null when it has no hierarchy. */
function shellModelOf(result: unknown): ShellModel | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }
  const payload = shellPayloadOf(result as Record<string, unknown>);
  if (!payload || typeof payload.viewHierarchy !== "object" || payload.viewHierarchy === null) {
    return null;
  }
  const { boxes, truncated } = shellCollectBoxes(payload.viewHierarchy);
  const { width, height } = shellScreenSize(payload, boxes);
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : "");
  return {
    boxes,
    width,
    height,
    imageUri: shellImageUri((result as Record<string, unknown>).content),
    deviceId: text(payload.deviceId),
    observationId: text(payload.observationId),
    truncated,
  };
}

/** Draws [model] into the shell's canvas with DOM calls only: no markup parsing, no inline style. */
function shellRender(doc: ShellDocument, model: ShellModel): void {
  const svgNs = "http://www.w3.org/2000/svg";
  const canvas = doc.getElementById("canvas");
  const status = doc.getElementById("status");
  if (!canvas || !status) {
    return;
  }
  const children: ShellNode[] = [];
  if (model.imageUri) {
    const image = doc.createElementNS(svgNs, "image");
    image.setAttribute("href", model.imageUri);
    image.setAttribute("x", "0");
    image.setAttribute("y", "0");
    image.setAttribute("width", String(model.width));
    image.setAttribute("height", String(model.height));
    image.setAttribute("preserveAspectRatio", "none");
    children.push(image);
  }
  for (const box of model.boxes) {
    const rect = doc.createElementNS(svgNs, "rect");
    rect.setAttribute("class", "am-box");
    rect.setAttribute("x", String(box.left));
    rect.setAttribute("y", String(box.top));
    rect.setAttribute("width", String(Math.max(0, box.right - box.left)));
    rect.setAttribute("height", String(Math.max(0, box.bottom - box.top)));
    if (box.label) {
      const title = doc.createElementNS(svgNs, "title");
      title.textContent = box.label;
      rect.appendChild(title);
    }
    children.push(rect);
  }
  canvas.setAttribute("viewBox", `0 0 ${model.width} ${model.height}`);
  canvas.replaceChildren(...children);
  const notes = [`${model.boxes.length} elements`];
  if (!model.imageUri) {
    notes.push("no screenshot in this result");
  }
  if (model.truncated) {
    notes.push("hierarchy truncated");
  }
  status.textContent = notes.join(" · ");
  canvas.setAttribute("data-device-id", model.deviceId);
  canvas.setAttribute("data-observation-id", model.observationId);
}

/** Empties the canvas when a delivered result cannot be drawn, so a stale capture never looks current. */
function shellClear(doc: ShellDocument): void {
  const canvas = doc.getElementById("canvas");
  const status = doc.getElementById("status");
  if (canvas) {
    canvas.replaceChildren();
  }
  if (status) {
    status.textContent = "The latest result has no view hierarchy to show";
  }
}

/** Posts a JSON-RPC message to the embedding host; the shell never addresses any other window. */
function shellSend(win: ShellWindow, message: Record<string, unknown>): void {
  // The origin is opaque inside a sandboxed iframe, so "*" is the only possible target; the
  // messages sent here (handshake, sizes, empty replies) carry no data.
  win.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
}

/** Applies the host's light or dark theme to the document; any other value is ignored. */
function shellApplyContext(doc: ShellDocument, context: unknown): void {
  const theme = (context as Record<string, unknown> | null)?.theme;
  if (theme === "light" || theme === "dark") {
    doc.documentElement.setAttribute("data-theme", theme);
  }
}

/** Renders a delivered tool result and tells the host the new size. */
function shellOnToolResult(win: ShellWindow, doc: ShellDocument, params: unknown): void {
  const model = shellModelOf(params);
  if (!model) {
    shellClear(doc);
    return;
  }
  shellRender(doc, model);
  shellSend(win, {
    method: "ui/notifications/size-changed",
    params: {
      width: doc.documentElement.scrollWidth ?? 0,
      height: doc.documentElement.scrollHeight ?? 0,
    },
  });
}

/** Handles one message from the host: notifications update the view, requests get a reply. */
function shellOnMessage(win: ShellWindow, doc: ShellDocument, message: Record<string, unknown>) {
  if (message.id === 1 && "result" in message) {
    shellApplyContext(doc, (message.result as Record<string, unknown> | null)?.hostContext);
    shellSend(win, { method: "ui/notifications/initialized" });
  } else if (message.method === "ui/notifications/tool-result") {
    shellOnToolResult(win, doc, message.params);
  } else if (message.method === "ui/notifications/host-context-changed") {
    shellApplyContext(doc, message.params);
  } else if (message.method === "ui/resource-teardown" && message.id !== undefined) {
    shellSend(win, { id: message.id, result: {} });
  } else if (typeof message.method === "string" && message.id !== undefined) {
    shellSend(win, { id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

/**
 * Wires the MCP Apps handshake and delivery over `postMessage`. The only message the shell ever
 * sends besides replies is the `ui/initialize` request and the `initialized` and `size-changed`
 * notifications.
 */
function shellBoot(win: ShellWindow, doc: ShellDocument): void {
  win.addEventListener("message", (event) => {
    const message = event.data as Record<string, unknown> | null;
    // Only the embedding host may talk to the shell; any other frame or window is ignored.
    if (event.source !== win.parent || typeof message !== "object" || message === null) {
      return;
    }
    if (message.jsonrpc === "2.0") {
      shellOnMessage(win, doc, message);
    }
  });
  shellSend(win, {
    id: 1,
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      appInfo: { name: "AutoMobile observe", version: "1" },
      appCapabilities: {},
    },
  });
}

/** Everything the serialised script contains, dependencies first. */
export const OBSERVE_SHELL_CLIENT_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  shellTupleBounds,
  shellBoundsOf,
  shellLabelOf,
  shellBoxOf,
  shellCollectBoxes,
  shellImageUri,
  shellPayloadOf,
  shellScreenSize,
  shellModelOf,
  shellRender,
  shellClear,
  shellSend,
  shellApplyContext,
  shellOnToolResult,
  shellOnMessage,
  shellBoot,
];

export { shellBoot, shellBoundsOf, shellCollectBoxes, shellImageUri, shellModelOf, shellRender };
export type { ShellBox, ShellDocument, ShellMessageEvent, ShellModel, ShellNode, ShellWindow };
