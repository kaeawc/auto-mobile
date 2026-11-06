import { expect, test } from "bun:test";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { expandPrototypeComponents } from "../../../src/features/prototype/prototypeComponents";
import { prototypeStrictPolicyError } from "../../../src/features/prototype/prototypeStrictPolicy";
import {
  prototypeWebViewCallError,
  prototypeWebViewError,
  prototypeWebViewIds,
  prototypeWebViewPrivateHost,
} from "../../../src/features/prototype/prototypeWebView";

const webView = (fields: Record<string, unknown> = {}) => ({
  type: "webView",
  url: "https://example.com/post",
  allowedOrigins: ["https://example.com"],
  ...fields,
});
const spec = (
  node: Record<string, unknown>,
  requires: Record<string, unknown> = { platform: ["webview"] },
  state: Record<string, unknown> = {},
) => ({ requires, state, root: { type: "column", children: [node] } });

test("a webView needs the webview module declared", () => {
  expect(prototypeWebViewError(spec(webView(), {}))).toEqual({
    path: "root.children[0]",
    message: "webView requires webview in requires.platform",
  });
  expect(prototypeWebViewError(spec(webView()))).toBeUndefined();
});

test("localhost and anything a URL parser reads as an IP address are private hosts", () => {
  for (const host of [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "10.0.2.2",
    "2130706433",
    "0x7f.0x1",
  ]) {
    expect(prototypeWebViewPrivateHost(host)).toBe(true);
  }
  for (const host of ["example.com", "cdn.example.com", "1.example.com", "0xcafe.example.com"]) {
    expect(prototypeWebViewPrivateHost(host)).toBe(false);
  }
});

test("an allowed origin must name a DNS host", () => {
  const node = webView({ allowedOrigins: ["https://example.com", "https://10.0.2.2:8080"] });
  expect(prototypeWebViewError(spec(node))).toEqual({
    path: "root.children[0].allowedOrigins[1]",
    message: "allowedOrigins must name a DNS host, not localhost or an IP address",
  });
});

test("a literal url authority must be an allowed origin", () => {
  const at = (url: string) => prototypeWebViewError(spec(webView({ url })));
  expect(at("https://example.com")).toBeUndefined();
  expect(at("https://EXAMPLE.com/a?b#c")).toBeUndefined();
  expect(at("https://example.com/{data:/slug}")).toBeUndefined();
  // A templated authority resolves at runtime, where the origin check runs again.
  expect(at("https://{data:/host}/a")).toBeUndefined();
  for (const url of ["https://other.com", "https://user@example.com", "https://example.com:8443"]) {
    expect(at(url)).toEqual({
      path: "root.children[0].url",
      message: "webView url origin must be one of allowedOrigins",
    });
  }
});

test("an explicit default port matches the origin that omits it", () => {
  const at = (url: string) => prototypeWebViewError(spec(webView({ url })));
  expect(at("https://example.com:443/post")).toBeUndefined();
  expect(at("https://EXAMPLE.com:443")).toBeUndefined();
  expect(at("https://example.com:4443/post")).toEqual({
    path: "root.children[0].url",
    message: "webView url origin must be one of allowedOrigins",
  });
});

test("navigation and title keys are string state, the back key is boolean state", () => {
  const state = { nav: "", title: "", back: false };
  const at = (fields: Record<string, unknown>) =>
    prototypeWebViewError(spec(webView(fields), undefined, state));
  expect(
    at({ navigationStateKey: "nav", titleKey: "title", canGoBackKey: "back" }),
  ).toBeUndefined();
  expect(at({ navigationStateKey: "back" })).toEqual({
    path: "root.children[0].navigationStateKey",
    message: "navigationStateKey must name a declared string state key",
  });
  expect(at({ titleKey: "missing" })?.message).toBe(
    "titleKey must name a declared string state key",
  );
  expect(at({ canGoBackKey: "nav" })?.message).toBe(
    "canGoBackKey must name a declared boolean state key",
  );
});

test("webview calls must name a webView node", () => {
  const ids = prototypeWebViewIds(spec(webView({ id: "article" })));
  expect([...ids]).toEqual(["article"]);
  const call = (name: string, node: string) => ({
    type: "platform",
    call: name,
    args: { node: { value: node } },
  });
  expect(prototypeWebViewCallError(call("webview.back", "article"), "a", ids)).toBeUndefined();
  expect(prototypeWebViewCallError(call("webview.reload", "other"), "a", ids)).toEqual({
    path: "a.args.node.value",
    message: "Unknown webView",
  });
  expect(prototypeWebViewCallError(call("links.open", "other"), "a", ids)).toBeUndefined();
});

test("the webview gate names each webView node as well as the declaration", () => {
  const gates = prototypeRequiredCapabilities(spec(webView()));
  expect(gates.find((gate) => gate.capability === "prototype_platform_webview_v1")?.fields).toEqual(
    ["requires.platform[0]", "root.children[0]"],
  );
});

test("a component prop used in onNavigate binds like one in onTap", () => {
  const expansion = expandPrototypeComponents({
    requires: { platform: ["webview"] },
    components: {
      page: { root: webView({ onNavigate: [{ type: "emit", name: "{props.eventName}" }] }) },
    },
    root: { type: "use", component: "page", props: { eventName: "page_loaded" } },
  });
  expect(expansion.success && expansion.spec).toMatchObject({
    root: { type: "webView", onNavigate: [{ type: "emit", name: "page_loaded" }] },
  });
});

test("a component prop used in the url binds like one in a request url", () => {
  const expansion = expandPrototypeComponents({
    requires: { platform: ["webview"] },
    components: { page: { root: webView({ url: "https://example.com/{props.slug}" }) } },
    root: { type: "use", component: "page", props: { slug: "article" } },
  });
  expect(expansion.success && expansion.spec).toMatchObject({
    root: { type: "webView", url: "https://example.com/article" },
  });
});

test("a component prop used in a navigation state key binds like a node state key", () => {
  const expansion = expandPrototypeComponents({
    requires: { platform: ["webview"] },
    state: { title: "", nav: "", back: false },
    components: {
      page: {
        root: webView({
          titleKey: "{props.titleKey}",
          navigationStateKey: "{props.navKey}",
          canGoBackKey: "{props.backKey}",
        }),
      },
    },
    root: {
      type: "use",
      component: "page",
      props: { titleKey: "title", navKey: "nav", backKey: "back" },
    },
  });
  expect(expansion.success && expansion.spec).toMatchObject({
    root: { type: "webView", titleKey: "title", navigationStateKey: "nav", canGoBackKey: "back" },
  });
});

test("a secure text field value cannot be bound into a library webView url", () => {
  const field = { type: "textField", stateKey: "pw", secure: true };
  const library = (url: string) => {
    const value = { ...spec(webView({ url }), undefined, { pw: "" }) };
    value.root.children.unshift(field);
    return prototypeStrictPolicyError(value, { library: true }, []);
  };
  expect(library("https://example.com/{pw}")).toEqual({
    path: "root.children[1].url",
    message: "Secure value cannot be bound into a request",
  });
  expect(library("https://example.com/post")).toBeUndefined();
});
