import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  OBSERVE_APP_INTERACTIVE_FLAG,
  OBSERVE_APP_RESOURCE_URI,
  MCP_APP_MIME_TYPE,
  registerObserveAppResource,
  type ObserveAppDataSource,
} from "../../src/server/observeAppResource";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import {
  OBSERVE_APP_PICKER_STYLE,
  OBSERVE_APP_SHELL_META,
  OBSERVE_APP_SHELL_STYLE,
  observeAppShellCsp,
  observeAppShellScript,
  renderObserveAppShellHtml,
} from "../../src/server/observeAppShell";
import {
  pickerBoot,
  pickerSelectorOf,
  pickerTapRequest,
  pickerTargetsOf,
} from "../../src/server/observeAppPickerClient";
import { FEATURE_FLAG_DEFINITIONS } from "../../src/features/featureFlags/FeatureFlagDefinitions";
import type { FeatureFlagReader } from "../../src/features/featureFlags/FeatureFlagService";
import { tapOnSchema } from "../../src/server/interactionTools/tapSchemas";
import { FakeShellDocument, FakeShellNode, FakeShellWindow } from "../fakes/FakeShellDom";

const hierarchy = {
  hierarchy: {
    node: [
      {
        bounds: [0, 0, 1080, 2400],
        "resource-id": "app:id/root",
        node: [
          { "resource-id": "app:id/ok", text: "OK", bounds: [10, 20, 110, 220] },
          { "content-desc": "Settings", bounds: { left: 200, top: 20, right: 300, bottom: 120 } },
          { className: "android.view.View", bounds: [0, 0, 5, 5] },
        ],
      },
    ],
  },
};
const toolResult = (structuredContent: unknown) => ({ content: [], structuredContent });
const observeResult = toolResult({ deviceId: "emulator-5554", viewHierarchy: hierarchy });

function flags(enabled: boolean): () => FeatureFlagReader {
  return () => ({ isEnabled: (key) => enabled && key === OBSERVE_APP_INTERACTIVE_FLAG });
}

const noObservation: ObserveAppDataSource = { getObservation: async () => undefined };

async function read(options: { flagOn: boolean; apps: boolean }) {
  ResourceRegistry.clearResources();
  registerObserveAppResource({ dataSource: noObservation, featureFlags: flags(options.flagOn) });
  return ResourceRegistry.getResource(OBSERVE_APP_RESOURCE_URI)!.handler({
    clientSupportsApps: options.apps,
  });
}

afterEach(() => {
  ResourceRegistry.clearResources();
});

describe("flag", () => {
  test("is defined and off by default", () => {
    const flag = FEATURE_FLAG_DEFINITIONS.find(({ key }) => key === OBSERVE_APP_INTERACTIVE_FLAG);
    expect(flag?.defaultValue).toBe(false);
  });
});

describe("resource registration and flag gating", () => {
  test("registers ui://automobile/observe with the MCP App mime type", async () => {
    const content = await read({ flagOn: true, apps: true });
    expect(ResourceRegistry.getResource(OBSERVE_APP_RESOURCE_URI)?.mimeType).toBe(
      MCP_APP_MIME_TYPE,
    );
    expect(content.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(content._meta).toEqual(OBSERVE_APP_SHELL_META);
  });

  test("flag off: an Apps host gets the read-only shell, byte for byte", async () => {
    const content = await read({ flagOn: false, apps: true });
    expect(content.text).toBe(renderObserveAppShellHtml());
    expect(content.text).not.toContain('id="picker"');
  });

  test("flag on: an Apps host gets the interactive picker", async () => {
    const content = await read({ flagOn: true, apps: true });
    expect(content.text).toBe(renderObserveAppShellHtml("interactive"));
    expect(content.text).toContain('id="picker"');
    expect(content.text).toContain(`${pickerBoot.name}(window, document);`);
  });

  test("flag on: a client without Apps support still gets the static snapshot", async () => {
    const content = await read({ flagOn: true, apps: false });
    expect(content.text).not.toContain("<script>");
    expect(content.text).not.toContain('id="picker"');
  });

  test("the flag is read per request, so a toggle applies to the next read", async () => {
    let enabled = false;
    ResourceRegistry.clearResources();
    registerObserveAppResource({
      dataSource: noObservation,
      featureFlags: () => ({ isEnabled: () => enabled }),
    });
    const handler = ResourceRegistry.getResource(OBSERVE_APP_RESOURCE_URI)!.handler;
    expect((await handler({ clientSupportsApps: true })).text).not.toContain('id="picker"');
    enabled = true;
    expect((await handler({ clientSupportsApps: true })).text).toContain('id="picker"');
  });
});

describe("interactive document", () => {
  const html = renderObserveAppShellHtml("interactive");
  const sha = (text: string) =>
    `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

  test("pins its own script and style by hash and keeps the network closed", () => {
    const csp = observeAppShellCsp(observeAppShellScript("interactive"), OBSERVE_APP_PICKER_STYLE);
    expect(html).toContain(csp);
    expect(csp).toContain(`script-src ${sha(observeAppShellScript("interactive"))}`);
    expect(csp).toContain(`style-src ${sha(OBSERVE_APP_PICKER_STYLE)}`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("unsafe-");
    expect(OBSERVE_APP_PICKER_STYLE.startsWith(OBSERVE_APP_SHELL_STYLE)).toBe(true);
  });

  test("the only tool it can name is tapOn", () => {
    const script = observeAppShellScript("interactive");
    expect(script.match(/name: "[A-Za-z]+"/g)).toEqual(['name: "tapOn"']);
    for (const forbidden of [
      "resources/read",
      "ui/message",
      "ui/open-link",
      "innerHTML",
      "eval(",
    ]) {
      expect(script).not.toContain(forbidden);
    }
  });
});

describe("selectors and targets", () => {
  test("prefers resource id, then text, then content description", () => {
    expect(pickerSelectorOf({ "resource-id": "a:id/x", text: "X" })).toEqual({
      elementId: "a:id/x",
    });
    expect(pickerSelectorOf({ text: "X", "content-desc": "Y" })).toEqual({ text: "X" });
    expect(pickerSelectorOf({ "content-desc": "Y" })).toEqual({ text: "Y" });
    expect(pickerSelectorOf({ className: "View" })).toBeNull();
    expect(pickerSelectorOf({ text: "   " })).toBeNull();
    expect(pickerSelectorOf({ text: "x".repeat(501) })).toBeNull();
  });

  test("only elements with bounds and a selector are pickable, largest first", () => {
    const targets = pickerTargetsOf(observeResult);
    expect(targets.map((target) => target.selector)).toEqual([
      { elementId: "app:id/root" },
      { elementId: "app:id/ok" },
      { text: "Settings" },
    ]);
    expect(pickerTargetsOf(toolResult({ nope: 1 }))).toEqual([]);
    expect(pickerTargetsOf(null)).toEqual([]);
  });
});

describe("tapOn payload shape", () => {
  test("is a JSON-RPC tools/call the real tapOn schema accepts", () => {
    for (const target of pickerTargetsOf(observeResult)) {
      const request = pickerTapRequest(target, 1000, "emulator-5554");
      expect(request).toMatchObject({ jsonrpc: "2.0", id: 1000, method: "tools/call" });
      const params = request.params as { name: string; arguments: unknown };
      expect(params.name).toBe("tapOn");
      expect(tapOnSchema.safeParse(params.arguments).success).toBe(true);
    }
  });

  test("omits deviceId when the result did not carry one", () => {
    const [target] = pickerTargetsOf(observeResult);
    const params = pickerTapRequest(target, 1, "").params as { arguments: object };
    expect(params.arguments).toEqual({
      selector: { elementId: "app:id/root" },
      selectionStrategy: "unique",
    });
  });
});

describe("picker protocol", () => {
  function boot() {
    const win = new FakeShellWindow();
    const doc = new FakeShellDocument();
    new Function("window", "document", observeAppShellScript("interactive"))(win, doc);
    win.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: observeResult });
    const picks = doc.canvas.children.find((child) => child.attributes.get("id") === "picks");
    return { win, doc, picks: (picks?.children ?? []) as FakeShellNode[] };
  }

  test("boots the shell handshake and draws hit targets over the rendered result", () => {
    const { win, doc, picks } = boot();
    expect(win.methods).toEqual(["ui/initialize", "ui/notifications/size-changed"]);
    expect(picks).toHaveLength(3);
    // The shell's own boxes are still drawn underneath.
    expect(doc.canvas.children.filter((child) => child.tag === "rect")).toHaveLength(4);
    expect(doc.node("tap").attributes.has("disabled")).toBe(true);
  });

  test("nothing is sent until the user picks an element and presses tap", () => {
    const { win, doc, picks } = boot();
    doc.node("tap").click();
    expect(win.methods).not.toContain("tools/call");
    picks[1].click();
    expect(doc.node("selector").textContent).toBe('{"elementId":"app:id/ok"}');
    expect(doc.node("tap").attributes.has("disabled")).toBe(false);
    expect(win.methods).not.toContain("tools/call");
    doc.node("tap").click();
    const call = win.posted.at(-1)!.message;
    expect(call).toEqual({
      jsonrpc: "2.0",
      id: 1000,
      method: "tools/call",
      params: {
        name: "tapOn",
        arguments: {
          selector: { elementId: "app:id/ok" },
          selectionStrategy: "unique",
          deviceId: "emulator-5554",
        },
      },
    });
  });

  test("reports the host's reply, including a refusal", () => {
    const { win, doc, picks } = boot();
    picks[2].click();
    doc.node("tap").click();
    win.deliver({ jsonrpc: "2.0", id: 1000, result: { content: [] } });
    expect(doc.node("tap-status").textContent).toContain("Tapped Settings");
    doc.node("tap").click();
    win.deliver({ jsonrpc: "2.0", id: 1001, error: { code: -32000, message: "denied by user" } });
    expect(doc.node("tap-status").textContent).toBe("Host did not run tapOn: denied by user");
    doc.node("tap").click();
    win.deliver({ jsonrpc: "2.0", id: 1002, result: { isError: true } });
    expect(doc.node("tap-status").textContent).toBe("tapOn failed on Settings");
  });

  test("a new result clears the selection; replies from other frames are ignored", () => {
    const { win, doc, picks } = boot();
    picks[1].click();
    win.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: observeResult });
    expect(doc.node("selector").textContent).toBe("");
    expect(doc.node("tap").attributes.has("disabled")).toBe(true);
    doc.node("tap").click();
    expect(win.methods).not.toContain("tools/call");
    win.deliver({ jsonrpc: "2.0", id: 1000, result: {} }, { other: "frame" });
    expect(doc.node("tap-status").textContent).toBeNull();
  });
});

describe("multi-display picker taps", () => {
  test("a tap picked from a secondary-display observe targets that display", () => {
    const secondary = toolResult({
      deviceId: "emulator-5554",
      display: { key: "2", role: "external" },
      viewHierarchy: hierarchy,
    });
    const win = new FakeShellWindow();
    const doc = new FakeShellDocument();
    new Function("window", "document", observeAppShellScript("interactive"))(win, doc);
    win.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: secondary });
    const picks = doc.canvas.children.find((child) => child.attributes.get("id") === "picks")!
      .children as FakeShellNode[];
    picks[1].click();
    doc.node("tap").click();
    const params = win.posted.at(-1)!.message.params as { arguments: unknown };
    expect(params.arguments).toEqual({
      selector: { elementId: "app:id/ok" },
      selectionStrategy: "unique",
      deviceId: "emulator-5554",
      display: "2",
    });
    expect(tapOnSchema.safeParse(params.arguments).success).toBe(true);
  });
});

describe("ambiguous selectors", () => {
  const rows = toolResult({
    viewHierarchy: {
      node: [
        { "resource-id": "app:id/remove", bounds: [0, 0, 100, 50] },
        { "resource-id": "app:id/remove", bounds: [0, 60, 100, 110] },
        { "resource-id": "app:id/add", bounds: [0, 120, 100, 170] },
      ],
    },
  });

  test("a selector shared by several elements is marked ambiguous", () => {
    const ambiguous = pickerTargetsOf(rows).map((target) => [
      JSON.stringify(target.selector),
      target.ambiguous,
    ]);
    expect(ambiguous).toEqual([
      ['{"elementId":"app:id/remove"}', true],
      ['{"elementId":"app:id/remove"}', true],
      ['{"elementId":"app:id/add"}', false],
    ]);
  });

  test("picking an ambiguous element never enables or sends a tap", () => {
    const win = new FakeShellWindow();
    const doc = new FakeShellDocument();
    new Function("window", "document", observeAppShellScript("interactive"))(win, doc);
    win.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: rows });
    const picks = doc.canvas.children.find((child) => child.attributes.get("id") === "picks")!
      .children as FakeShellNode[];
    picks[1].click();
    expect(doc.node("selection").textContent).toContain("not tappable");
    expect(doc.node("tap").attributes.has("disabled")).toBe(true);
    doc.node("tap").click();
    expect(win.methods).not.toContain("tools/call");
    picks[2].click();
    doc.node("tap").click();
    expect(win.methods).toContain("tools/call");
  });
});
