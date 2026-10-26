import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  OBSERVE_APP_SHELL_META,
  OBSERVE_APP_SHELL_STYLE,
  observeAppShellCsp,
  observeAppShellScript,
  renderObserveAppShellHtml,
} from "../../src/server/observeAppShell";
import {
  shellBoot,
  shellBoundsOf,
  shellCollectBoxes,
  shellImageUri,
  shellModelOf,
  shellRender,
} from "../../src/server/observeAppShellClient";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { FakeShellDocument, FakeShellWindow } from "../fakes/FakeShellDom";

const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const toolResult = (structuredContent: unknown, content: unknown[] = []) => ({
  content,
  structuredContent,
});
const hierarchy = {
  hierarchy: {
    node: [
      {
        text: "Root",
        bounds: [0, 0, 1080, 2400],
        node: [
          { "resource-id": "app:id/ok", bounds: { left: 10, top: 20, right: 110, bottom: 220 } },
          { text: "bad", bounds: [1, 2, 3] },
        ],
      },
    ],
  },
};

describe("bounds and boxes", () => {
  test("accept compact tuples and objects, reject anything else", () => {
    expect(shellBoundsOf([1, 2, 3, 4])).toEqual({ left: 1, top: 2, right: 3, bottom: 4 });
    expect(shellBoundsOf({ left: 1, top: 2, right: 3, bottom: 4 })).toEqual({
      left: 1,
      top: 2,
      right: 3,
      bottom: 4,
    });
    for (const bad of [
      [1, 2, 3],
      [1, 2, 3, "4"],
      [1, 2, 3, Infinity],
      null,
      "x",
      {},
      { left: 1 },
    ]) {
      expect(shellBoundsOf(bad)).toBeNull();
    }
  });

  test("collects nested nodes with labels and skips malformed bounds", () => {
    const { boxes, truncated } = shellCollectBoxes(hierarchy);
    expect(truncated).toBe(false);
    expect(boxes.map((box) => box.label).sort()).toEqual(["Root", "app:id/ok"]);
  });

  test("bounds the work on a huge payload that has few boxes", () => {
    const filler = { items: Array.from({ length: 250_000 }, () => 1) };
    const { boxes, truncated } = shellCollectBoxes({ ...filler, bounds: [0, 0, 1, 1] });
    expect(boxes.length).toBeLessThanOrEqual(1);
    expect(truncated).toBe(true);
  });

  test("caps the box count and the nesting depth", () => {
    const many = { items: Array.from({ length: 4500 }, () => ({ bounds: [0, 0, 1, 1] })) };
    const capped = shellCollectBoxes(many);
    expect(capped.boxes).toHaveLength(4000);
    expect(capped.truncated).toBe(true);
    let deep: Record<string, unknown> = { bounds: [0, 0, 1, 1] };
    for (let i = 0; i < 200; i++) {
      deep = { node: deep, bounds: [0, 0, 1, 1] };
    }
    expect(shellCollectBoxes(deep).truncated).toBe(true);
  });

  test("reads a real captured Android hierarchy", () => {
    const { observe } = loadAndroidHomeObserve();
    const model = shellModelOf(toolResult(JSON.parse(JSON.stringify(observe))));
    expect(model).not.toBeNull();
    expect(model!.boxes.length).toBeGreaterThan(5);
    expect(model!.width).toBeGreaterThan(0);
  });
});

describe("shellModelOf", () => {
  test("uses screenSize, then hierarchy size, then the boxes' extent", () => {
    const sized = shellModelOf(
      toolResult({ viewHierarchy: hierarchy, screenSize: { width: 1080, height: 2400 } }),
    );
    expect([sized!.width, sized!.height]).toEqual([1080, 2400]);
    const fromHierarchy = shellModelOf(
      toolResult({ viewHierarchy: { ...hierarchy, screenWidth: 400, screenHeight: 800 } }),
    );
    expect([fromHierarchy!.width, fromHierarchy!.height]).toEqual([400, 800]);
    const extent = shellModelOf(toolResult({ viewHierarchy: hierarchy }));
    expect([extent!.width, extent!.height]).toEqual([1080, 2400]);
  });

  test("needs structuredContent with a hierarchy; free-form text is never parsed", () => {
    const text = JSON.stringify({ viewHierarchy: hierarchy });
    expect(shellModelOf({ content: [{ type: "text", text }] })).toBeNull();
    expect(shellModelOf(toolResult({ other: 1 }))).toBeNull();
    expect(shellModelOf(toolResult([]))).toBeNull();
    expect(shellModelOf(null)).toBeNull();
    expect(shellModelOf([])).toBeNull();
  });

  test("carries identity and caps its length", () => {
    const model = shellModelOf(
      toolResult({ viewHierarchy: hierarchy, deviceId: "d1", observationId: "x".repeat(500) }),
    );
    expect(model!.deviceId).toBe("d1");
    expect(model!.observationId).toHaveLength(200);
  });
});

describe("shellImageUri", () => {
  const block = (extra: Record<string, unknown>) => [
    { type: "image", mimeType: "image/png", data: png, ...extra },
  ];
  test("accepts base64 PNG, JPEG and WebP", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/webp"]) {
      expect(shellImageUri(block({ mimeType }))).toBe(`data:${mimeType};base64,${png}`);
    }
  });
  test("rejects other types, bad base64, script-ish data and oversized images", () => {
    expect(shellImageUri(block({ mimeType: "image/svg+xml" }))).toBeNull();
    expect(shellImageUri(block({ mimeType: "text/html" }))).toBeNull();
    expect(shellImageUri(block({ data: 'abc"onload="x' }))).toBeNull();
    expect(shellImageUri(block({ data: "a".repeat(12_000_001) }))).toBeNull();
    expect(shellImageUri([{ type: "text", text: "x" }])).toBeNull();
    expect(shellImageUri("nope")).toBeNull();
  });
});

describe("shellRender", () => {
  test("builds the canvas with DOM calls only and labels through textContent", () => {
    const doc = new FakeShellDocument();
    shellRender(
      doc,
      shellModelOf(
        toolResult({ viewHierarchy: hierarchy, deviceId: "d1" }, [
          { type: "image", mimeType: "image/png", data: png },
        ]),
      )!,
    );
    expect(doc.canvas.attributes.get("viewBox")).toBe("0 0 1080 2400");
    expect(doc.canvas.attributes.get("data-device-id")).toBe("d1");
    expect(doc.canvas.children.map((child) => child.tag)).toEqual(["image", "rect", "rect"]);
    expect(doc.canvas.children[0].attributes.get("href")).toStartWith("data:image/png;base64,");
    const titled = doc.canvas.children.find((rect) => rect.children[0]?.textContent === "Root");
    expect(titled).toBeDefined();
    expect(doc.status.textContent).toBe("2 elements");
  });

  test("a hostile label stays text and never becomes an attribute or markup", () => {
    const doc = new FakeShellDocument();
    const label = `"><script>alert(1)</script>`;
    shellRender(
      doc,
      shellModelOf(toolResult({ viewHierarchy: { bounds: [0, 0, 5, 5], text: label } }))!,
    );
    const rect = doc.canvas.children[0];
    expect(rect.children[0].textContent).toBe(label);
    expect([...rect.attributes.values()].some((value) => value.includes("<script>"))).toBe(false);
    expect(doc.status.textContent).toContain("no screenshot in this result");
  });
});

describe("shellBoot protocol", () => {
  function boot() {
    const win = new FakeShellWindow();
    const doc = new FakeShellDocument();
    shellBoot(win, doc);
    return { win, doc };
  }
  const result = toolResult({ viewHierarchy: hierarchy });

  test("starts with ui/initialize to the parent and then declares itself initialized", () => {
    const { win } = boot();
    expect(win.posted[0].message).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { appCapabilities: {} },
    });
    win.deliver({ jsonrpc: "2.0", id: 1, result: { hostContext: { theme: "dark" } } });
    expect(win.methods).toEqual(["ui/initialize", "ui/notifications/initialized"]);
  });

  test("renders a delivered tool result and applies the host theme", () => {
    const { win, doc } = boot();
    win.deliver({ jsonrpc: "2.0", id: 1, result: { hostContext: { theme: "dark" } } });
    expect(doc.documentElement.attributes.get("data-theme")).toBe("dark");
    win.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
    expect(doc.canvas.children).toHaveLength(2);
    expect(win.methods).toContain("ui/notifications/size-changed");
    win.deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "light" },
    });
    expect(doc.documentElement.attributes.get("data-theme")).toBe("light");
  });

  test("a second result replaces the first (live update)", () => {
    const { win, doc } = boot();
    const deliver = (viewHierarchy: unknown) =>
      win.deliver({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: toolResult({ viewHierarchy }),
      });
    deliver(hierarchy);
    deliver({ bounds: [0, 0, 9, 9] });
    expect(doc.canvas.children).toHaveLength(1);
  });

  test("ignores messages from any window but the parent and non-JSON-RPC data", () => {
    const { win, doc } = boot();
    const message = { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result };
    win.deliver(message, { other: "frame" });
    win.deliver({ ...message, jsonrpc: "1.0" });
    win.deliver("string");
    win.deliver(null);
    expect(doc.canvas.children).toHaveLength(0);
  });

  test("an unrenderable result clears the view rather than leaving a stale capture up", () => {
    const { win, doc } = boot();
    win.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
    expect(doc.canvas.children).toHaveLength(2);
    win.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { nope: 1 } });
    expect(doc.canvas.children).toHaveLength(0);
    expect(doc.status.textContent).toContain("no view hierarchy");
  });

  test("answers teardown and refuses every other request", () => {
    const { win } = boot();
    win.deliver({ jsonrpc: "2.0", id: 7, method: "ui/resource-teardown", params: {} });
    win.deliver({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "tapOn" } });
    expect(win.posted.at(-2)!.message).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(win.posted.at(-1)!.message).toMatchObject({ id: 8, error: { code: -32601 } });
  });

  test("never asks the host to do anything beyond the handshake", () => {
    const { win } = boot();
    win.deliver({ jsonrpc: "2.0", id: 1, result: {} });
    win.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
    win.deliver({ jsonrpc: "2.0", id: 3, method: "ui/resource-teardown" });
    const allowed = new Set([
      "ui/initialize",
      "ui/notifications/initialized",
      "ui/notifications/size-changed",
    ]);
    expect(win.methods.every((method) => allowed.has(method))).toBe(true);
  });
});

describe("the serialised script", () => {
  const script = observeAppShellScript();

  test("is plain JavaScript that boots against a fake window", () => {
    const win = new FakeShellWindow();
    const doc = new FakeShellDocument();
    new Function("window", "document", script)(win, doc);
    expect(win.methods).toEqual(["ui/initialize"]);
    win.deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: toolResult({ viewHierarchy: hierarchy }),
    });
    expect(doc.canvas.children).toHaveLength(2);
  });

  test("boots through the function's own name, so a minified build still starts", () => {
    expect(script.trimEnd().split("\n").at(-1)).toBe(`${shellBoot.name}(window, document);`);
  });

  test("contains no network, storage, code-evaluation or markup-injection APIs", () => {
    for (const forbidden of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "eval(",
      "new Function",
      'setTimeout("',
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "sendBeacon",
      "importScripts",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "document.cookie",
      "window.open",
      "location",
      ".style",
      "tools/call",
      "resources/read",
      "ui/message",
      "ui/open-link",
      "ui/update-model-context",
    ]) {
      expect(script).not.toContain(forbidden);
    }
    expect(script).not.toContain("</script");
  });
});

describe("the shell document", () => {
  const html = renderObserveAppShellHtml();

  test("is byte-identical on every call and holds no device data", () => {
    expect(renderObserveAppShellHtml()).toBe(html);
    expect(html).toContain("Waiting for an observe result");
    expect(html).not.toContain("data-observation-id=");
  });

  test("the CSP allows only the two inline blocks by hash and data: images", () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
    expect(csp).toBe(observeAppShellCsp());
    const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    const style = /<style>([\s\S]*)<\/style>/.exec(html)![1];
    expect(style).toBe(OBSERVE_APP_SHELL_STYLE);
    expect(csp).toContain(`script-src ${hash(script)}`);
    expect(csp).toContain(`style-src ${hash(style)}`);
    for (const directive of [
      "default-src 'none'",
      "img-src data:",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("*");
  });

  test("references nothing external and uses no inline style attributes or event handlers", () => {
    expect(html).not.toMatch(/\s(?:src|href)=["'](?!data:)/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  test("the resource metadata names no origins and no permissions", () => {
    expect(OBSERVE_APP_SHELL_META.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(OBSERVE_APP_SHELL_META.ui.permissions).toEqual({});
  });
});
