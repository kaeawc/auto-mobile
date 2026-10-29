import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs the WKWebView bridge's injected page script (#5162, #15877) against a small fake DOM, so its
 * snapshot rules are pinned without WebKit: unique element ids, computed visibility, main-frame
 * only snapshots, and a fresh snapshot after scrolling or a focus change.
 */

const SOURCE = join(
  import.meta.dir,
  "../../../../ios/auto-mobile-sdk/Sources/AutoMobileSDK/WebKit/AutoMobileWebViewBridge.swift",
);

function pageScript(): string {
  const match = /private static let script = #"""\n([\s\S]*?)\n\s*"""#/.exec(
    // A Windows checkout has CRLF line endings.
    readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n"),
  );
  if (!match) {
    throw new Error("bridge page script not found");
  }
  return match[1];
}

interface FakeElement {
  tagName: string;
  value?: string;
  dataset: Record<string, string>;
  textContent: string;
  disabled: boolean;
  hidden: boolean;
  rect: { x: number; y: number; width: number; height: number };
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  checkVisibility(): boolean;
}

function element(tagName: string, text: string): FakeElement {
  return {
    tagName: tagName.toUpperCase(),
    dataset: {},
    textContent: text,
    disabled: false,
    hidden: false,
    rect: { x: 0, y: 0, width: 80, height: 30 },
    getAttribute: () => null,
    getBoundingClientRect() {
      return this.rect;
    },
    checkVisibility() {
      return !this.hidden;
    },
  };
}

interface Posted {
  name: string;
  elements?: Array<{
    id: string;
    label: string;
    value: string | null;
    visible: boolean;
    bounds: number[];
  }>;
}

function page(options: { mainFrame?: boolean } = {}) {
  const elements: FakeElement[] = [];
  const posted: Posted[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const timers: Array<() => void> = [];
  const observers: Array<() => void> = [];
  const window: Record<string, unknown> = {
    webkit: {
      messageHandlers: { automobile: { postMessage: (message: Posted) => posted.push(message) } },
    },
    fetch: () => Promise.resolve(),
    WebSocket: class {},
  };
  window.top = options.mainFrame === false ? {} : window;
  const document = { querySelectorAll: () => elements, activeElement: null as FakeElement | null };
  const globals: Record<string, unknown> = {
    window,
    document,
    location: { href: "https://fixture.local/" },
    history: { pushState: () => undefined, replaceState: () => undefined },
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    crypto: { randomUUID: () => "uuid" },
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout: (callback: () => void) => timers.push(callback),
    addEventListener: (name: string, callback: () => void) => {
      (listeners[name] ??= []).push(callback);
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
    },
    XMLHttpRequest: class {},
    WebSocket: class {},
    fetch: () => Promise.resolve(),
  };
  new Function(...Object.keys(globals), pageScript())(...Object.values(globals));
  const snapshots = () => posted.filter((message) => message.name === "snapshot");
  return {
    elements,
    document,
    snapshots,
    fire: (name: string) => listeners[name]?.forEach((listener) => listener()),
    mutate: () => observers.forEach((observer) => observer()),
    flushTimers: () => timers.splice(0).forEach((timer) => timer()),
  };
}

describe("WKWebView bridge page script (#15877)", () => {
  test("an element inserted before an existing one gets a new id, not the existing one's", () => {
    const p = page();
    p.elements.push(element("button", "Original"));
    p.fire("load");
    p.elements.unshift(element("button", "Inserted"));
    p.mutate();
    const latest = p.snapshots().at(-1)?.elements ?? [];
    const ids = latest.map((entry) => `${entry.label}:${entry.id}`);
    expect(ids).toEqual(["Inserted:e1", "Original:e0"]);
  });

  test("a CSS-hidden element with a layout box is reported invisible", () => {
    const p = page();
    const hidden = element("button", "Hidden");
    hidden.hidden = true;
    p.elements.push(hidden, element("button", "Shown"));
    p.fire("load");
    expect(
      p
        .snapshots()
        .at(-1)
        ?.elements?.map((entry) => entry.visible),
    ).toEqual([false, true]);
  });

  test("a frame other than the main frame posts no snapshot", () => {
    const p = page({ mainFrame: false });
    p.elements.push(element("button", "In frame"));
    p.fire("load");
    p.mutate();
    expect(p.snapshots()).toEqual([]);
  });

  test("scrolling or a focus change posts a fresh snapshot, coalescing a burst", () => {
    const p = page();
    const button = element("button", "Pay");
    p.elements.push(button);
    p.fire("load");
    button.rect = { ...button.rect, y: -400 };
    p.fire("scroll");
    p.fire("scroll");
    p.fire("focusin");
    expect(p.snapshots()).toHaveLength(1);
    p.flushTimers();
    expect(p.snapshots()).toHaveLength(2);
    expect(p.snapshots().at(-1)?.elements?.[0].bounds[1]).toBe(-400);
  });

  test("typing or committing a value posts a fresh snapshot with it", () => {
    const p = page();
    const field = element("input", "");
    p.elements.push(field);
    p.fire("load");
    expect(p.snapshots().at(-1)?.elements?.[0].value).toBeNull();
    // Assigning a value changes no DOM attribute, so only the input event announces it.
    field.value = "typed";
    p.fire("input");
    p.fire("change");
    p.flushTimers();
    expect(p.snapshots()).toHaveLength(2);
    expect(p.snapshots().at(-1)?.elements?.[0].value).toBe("typed");
  });
});
