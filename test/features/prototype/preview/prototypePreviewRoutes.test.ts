import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ActionableError } from "../../../../src/models/ActionableError";
import {
  parsePrototypePreviewRoute,
  PROTOTYPE_PREVIEW_SHELL_SCRIPT,
  prototypePreviewResponse,
} from "../../../../src/features/prototype/preview/prototypePreviewRoutes";
import { FakePreviewPageSource } from "./previewFakes";

describe("parsePrototypePreviewRoute", () => {
  test("maps paths to routes", () => {
    expect(parsePrototypePreviewRoute("/")).toEqual({ kind: "index" });
    expect(parsePrototypePreviewRoute("/p/check%20out")).toEqual({
      kind: "shell",
      id: "check out",
    });
    expect(parsePrototypePreviewRoute("/p/a/page?variant=b&frame=f&generation=3")).toEqual({
      kind: "page",
      id: "a",
      variant: "b",
      frame: "f",
    });
    expect(parsePrototypePreviewRoute("/p/a/events")).toEqual({ kind: "events", id: "a" });
  });

  test("anything else, or a malformed escape, is notFound", () => {
    ["/p", "/p/", "/p/a/other", "/x", "/p/%E0%A4%A"].forEach((path) =>
      expect(parsePrototypePreviewRoute(path)).toEqual({ kind: "notFound" }),
    );
  });
});

describe("prototypePreviewResponse", () => {
  test("the shell pins its own script by hash and points at the page and stream", async () => {
    const response = await prototypePreviewResponse(
      { kind: "shell", id: "a/b", variant: "v" },
      new FakePreviewPageSource(),
    );
    const hash = createHash("sha256").update(PROTOTYPE_PREVIEW_SHELL_SCRIPT).digest("base64");
    expect(response.headers["content-security-policy"]).toContain(`script-src 'sha256-${hash}'`);
    expect(response.body).toContain(`<script>${PROTOTYPE_PREVIEW_SHELL_SCRIPT}</script></body>`);
    expect(response.body).toContain('data-page="/p/a%2Fb/page?variant=v"');
    expect(response.body).not.toContain(" src=");
    expect(response.body).toContain('data-events="/p/a%2Fb/events"');
  });

  test("an unknown id gets a waiting page; a bad query a 400", async () => {
    const source = new FakePreviewPageSource();
    const waiting = await prototypePreviewResponse({ kind: "page", id: "<x>" }, source);
    expect(waiting.status).toBe(404);
    expect(waiting.body).toContain("&lt;x&gt;");
    source.change("a");
    source.failPage = new ActionableError('Unknown frame "z"');
    const bad = await prototypePreviewResponse({ kind: "page", id: "a", frame: "z" }, source);
    expect(bad).toMatchObject({ status: 400, body: 'Unknown frame "z"' });
  });

  test("a kept variant that left the group falls back to the page's own", async () => {
    const source = new FakePreviewPageSource();
    source.change("a");
    source.groups.set("a", ["a", "b"]);
    const kept = await prototypePreviewResponse({ kind: "page", id: "a", variant: "b" }, source);
    expect(kept.body).toBe("<page a b ->");
    source.groups.set("a", ["a"]);
    const stale = await prototypePreviewResponse({ kind: "page", id: "a", variant: "b" }, source);
    expect(stale).toMatchObject({ status: 200, body: "<page a - ->" });
  });

  test("the page is the source's HTML unchanged; the index lists ids", async () => {
    const source = new FakePreviewPageSource();
    source.change("a");
    const page = await prototypePreviewResponse({ kind: "page", id: "a" }, source);
    expect(page.body).toBe("<page a - ->");
    expect(page.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    const index = await prototypePreviewResponse({ kind: "index" }, source);
    expect(index.body).toContain('<a href="/p/a">a</a>');
    const missing = await prototypePreviewResponse({ kind: "notFound" }, source);
    expect(missing.status).toBe(404);
  });
});

/** The shell's DOM and EventSource, enough for its script to run outside a browser. */
class FakeShellFrame {
  readonly dataset = { page: "/p/a/page" };
  src: string | undefined;
  contentDocument: { querySelector: (selector: string) => { value: string } | null } | null = null;
  getAttribute(name: string): string | null {
    return name === "src" ? (this.src ?? null) : null;
  }
}

class FakeShellEvents {
  static last: FakeShellEvents | undefined;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: { data: string }) => void>();
  constructor(readonly url: string) {
    FakeShellEvents.last = this;
  }
  addEventListener(name: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(name, listener);
  }
  emit(name: string, data: object): void {
    this.listeners.get(name)?.({ data: JSON.stringify(data) });
  }
}

function runShell(): {
  frame: FakeShellFrame;
  events: FakeShellEvents;
  status: { textContent: string };
} {
  const frame = new FakeShellFrame();
  const status = { textContent: "Connecting" };
  const document = {
    body: { dataset: { events: "/p/a/events" } },
    querySelector: (selector: string) => (selector.startsWith("iframe") ? frame : status),
  };
  new Function("document", "EventSource", "location", PROTOTYPE_PREVIEW_SHELL_SCRIPT)(
    document,
    FakeShellEvents,
    { href: "http://127.0.0.1:1/p/a" },
  );
  return { frame, events: FakeShellEvents.last!, status };
}

describe("PROTOTYPE_PREVIEW_SHELL_SCRIPT", () => {
  test("loads the page only on the first ready, after the stream is subscribed", () => {
    const { frame, events, status } = runShell();
    expect(events.url).toBe("/p/a/events");
    expect(frame.src).toBeUndefined();
    // A change landing before the stream opens shows up as the first ready's generation.
    events.emit("ready", { generation: 2 });
    expect(frame.src).toBe("/p/a/page");
    expect(status.textContent).toBe("Live");
    events.emit("reload", { id: "a", generation: 3 });
    expect(frame.src).toBe("/p/a/page?generation=3");
  });

  test("a reconnect reloads only when its generation moved", () => {
    const { frame, events } = runShell();
    events.emit("ready", { generation: 1 });
    events.onerror?.();
    events.emit("ready", { generation: 1 });
    expect(frame.src).toBe("/p/a/page");
    frame.contentDocument = { querySelector: () => ({ value: "b" }) };
    events.emit("ready", { generation: 4 });
    expect(frame.src).toBe("/p/a/page?variant=b&generation=4");
  });

  test("a stream that fails before ready still loads the page, then reconciles", () => {
    const { frame, events, status } = runShell();
    events.onerror?.();
    expect(status.textContent).toBe("Reconnecting");
    expect(frame.src).toBe("/p/a/page");
    events.emit("ready", { generation: 0 });
    expect(frame.src).toBe("/p/a/page?generation=0");
  });
});
