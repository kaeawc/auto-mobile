import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { PrototypePlatformError } from "./prototypePlatform";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Rules for the `webView` node (#14312) that the contract cannot express: `webview` in
 * `requires.platform`; allowed origins that name a DNS host, never an IP literal or `localhost`
 * (JavaScript, JVM and Swift URL parsers disagree on numeric host spellings, so none is accepted);
 * a literal URL authority that is one of the allowed origins; and navigation, title and back keys
 * that name declared state of the right type. Kotlin's `PrototypeWebView` and Swift's
 * `PrototypeWebView` are the twins.
 */

const WEBVIEW_CALLS = new Set(["webview.back", "webview.reload"]);

const STATE_KEYS = [
  ["navigationStateKey", "string"],
  ["titleKey", "string"],
  ["canGoBackKey", "boolean"],
] as const;

/** A host whose last label is numeric or hexadecimal parses as an IPv4 address in WHATWG URL. */
const IP_LIKE_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;

/** The ids of the spec's `webView` nodes, the values a `webview.*` `node` argument may name. */
export function prototypeWebViewIds(root: Raw): Set<string> {
  const ids = new Set<string>();
  walkPrototypeNodes(root, (node) => {
    if (node.type === "webView" && typeof node.id === "string") {
      ids.add(node.id);
    }
  });
  return ids;
}

/** The first `webView` node rule a spec breaks. */
export function prototypeWebViewError(root: Raw): PrototypePlatformError | undefined {
  const requires = record(root.requires);
  const platform = Array.isArray(requires?.platform) ? requires.platform : [];
  const scope = { webview: platform.includes("webview"), state: record(root.state) ?? {} };
  let first: PrototypePlatformError | undefined;
  walkPrototypeNodes(root, (node, path) => {
    if (!first && node.type === "webView") {
      first = nodeError(node, path, scope);
    }
  });
  return first;
}

/** The host of an `https://host[:port]` origin the contract pattern already accepted. */
function originHost(origin: string): string {
  return origin.slice("https://".length).split(":")[0];
}

/** `localhost`, a `.localhost` name, or a host a URL parser would read as an IP address. */
export function prototypeWebViewPrivateHost(host: string): boolean {
  const last = host.slice(host.lastIndexOf(".") + 1);
  return host === "localhost" || host.endsWith(".localhost") || IP_LIKE_LABEL.test(last);
}

/** The `https://authority` of a URL whose authority is literal, lowercased, without `:443`. */
function literalOrigin(url: string): string | undefined {
  const authority = /^https:\/\/([^/?#]*)/.exec(url)?.[1];
  if (authority === undefined || authority.includes("{")) {
    return undefined;
  }
  // An allowed origin never spells the default port, so `:443` is dropped before comparing.
  return `https://${authority.toLowerCase().replace(/:443$/, "")}`;
}

function nodeError(
  node: Raw,
  path: string,
  scope: { webview: boolean; state: Raw },
): PrototypePlatformError | undefined {
  if (!scope.webview) {
    return { path, message: "webView requires webview in requires.platform" };
  }
  const origins = Array.isArray(node.allowedOrigins) ? node.allowedOrigins.map(String) : [];
  const privateIndex = origins.findIndex((origin) =>
    prototypeWebViewPrivateHost(originHost(origin)),
  );
  if (privateIndex >= 0) {
    return {
      path: `${path}.allowedOrigins[${privateIndex}]`,
      message: "allowedOrigins must name a DNS host, not localhost or an IP address",
    };
  }
  const origin = typeof node.url === "string" ? literalOrigin(node.url) : undefined;
  if (origin !== undefined && !origins.includes(origin)) {
    return { path: `${path}.url`, message: "webView url origin must be one of allowedOrigins" };
  }
  for (const [field, type] of STATE_KEYS) {
    const key = node[field];
    if (typeof key === "string" && typeof scope.state[key] !== type) {
      return {
        path: `${path}.${field}`,
        message: `${field} must name a declared ${type} state key`,
      };
    }
  }
  return undefined;
}

/** A `webview.*` call whose literal `node` argument names no `webView` node. */
export function prototypeWebViewCallError(
  action: Raw,
  path: string,
  webViews: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  if (typeof action.call !== "string" || !WEBVIEW_CALLS.has(action.call)) {
    return undefined;
  }
  const target = record(record(action.args)?.node);
  return target && typeof target.value === "string" && !webViews.has(target.value)
    ? { path: `${path}.args.node.value`, message: "Unknown webView" }
    : undefined;
}
