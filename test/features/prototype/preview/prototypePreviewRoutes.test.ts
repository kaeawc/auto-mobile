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
    expect(response.body).toContain('src="/p/a%2Fb/page?variant=v"');
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
