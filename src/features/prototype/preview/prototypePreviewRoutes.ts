import { createHash } from "node:crypto";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../models/describeUnknownError";
import { encodeUriSegment } from "../../../utils/encodeUriSegment";
import { logger } from "../../../utils/logger";
import { el, toHtml, type WebChild } from "../web/webNodes";
import type {
  PrototypePreviewPageQuery,
  PrototypePreviewPageSource,
} from "./prototypePreviewSource";

/**
 * Routes of the prototype preview server (#17975):
 *
 * - `/` lists the prototypes with web output.
 * - `/p/<id>` is the live shell: the page in an iframe, reloaded on each change event.
 * - `/p/<id>/page` is the same HTML as `automobile:prototype/<id>/web`, byte for byte.
 * - `/p/<id>/events` is the server-sent event stream the shell listens to.
 * - `/p?id=<id>&view=page|events` addresses the same routes by query, for the ids `.` and `..`:
 *   browsers normalize those dot segments (even escaped as `%2e`) out of a path (#18077).
 *
 * The prototype page keeps its own CSP (no script but its runtime, no network), so the reload
 * script lives in the shell, never in the page.
 */
export type PrototypePreviewRoute =
  | { readonly kind: "index" }
  | ({ readonly kind: "shell" | "page" } & PrototypePreviewPageQuery)
  | { readonly kind: "events"; readonly id: string }
  | { readonly kind: "notFound" };

export interface PrototypePreviewResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const PAGE_PATH = /^\/p\/([^/]+)(\/page|\/events)?\/?$/;

function decoded(segment: string): string | undefined {
  try {
    const id = decodeURIComponent(segment);
    return id.length > 0 ? id : undefined;
  } catch (error) {
    // A malformed escape is a bad URL from the browser, answered with 404.
    logger.debug(`[prototype] preview path segment not decodable: ${errorMessage(error)}`);
    return undefined;
  }
}

function pageQuery(id: string, params: URLSearchParams): PrototypePreviewPageQuery {
  const variant = params.get("variant") || undefined;
  const frame = params.get("frame") || undefined;
  return { id, ...(variant ? { variant } : {}), ...(frame ? { frame } : {}) };
}

export type PrototypePreviewView = "shell" | "page" | "events";

const QUERY_PATH = /^\/p\/?$/;

/** A query-form route (`/p?id=<id>&view=...`), or notFound. */
function queryRoute(params: URLSearchParams): PrototypePreviewRoute {
  const id = params.get("id");
  const view = params.get("view") ?? "shell";
  if (!id) {
    return { kind: "notFound" };
  }
  if (view === "events") {
    return { kind: "events", id };
  }
  return view === "shell" || view === "page"
    ? { kind: view, ...pageQuery(id, params) }
    : { kind: "notFound" };
}

/** The route of a request target (path and query); anything else is notFound. */
export function parsePrototypePreviewRoute(target: string): PrototypePreviewRoute {
  let url: URL;
  try {
    url = new URL(target, "http://preview.invalid");
  } catch (error) {
    // A request target that is not a URL (such as `//[`) is a bad request, answered with 404.
    logger.debug(`[prototype] preview request target not parseable: ${errorMessage(error)}`);
    return { kind: "notFound" };
  }
  if (url.pathname === "/") {
    return { kind: "index" };
  }
  if (QUERY_PATH.test(url.pathname)) {
    return queryRoute(url.searchParams);
  }
  const match = PAGE_PATH.exec(url.pathname);
  const id = match?.[1] === undefined ? undefined : decoded(match[1]);
  if (id === undefined) {
    return { kind: "notFound" };
  }
  if (match?.[2] === "/events") {
    return { kind: "events", id };
  }
  return { kind: match?.[2] === "/page" ? "page" : "shell", ...pageQuery(id, url.searchParams) };
}

/**
 * The path (and query) of a prototype's `view`: `/p/<id>[/view]` for ordinary ids, and the query
 * form for `.` and `..`, which no path segment can carry through a browser.
 */
export function prototypePreviewPath(
  id: string,
  view: PrototypePreviewView = "shell",
  params: Readonly<Record<string, string>> = {},
): string {
  if (id === "." || id === "..") {
    const query = new URLSearchParams({ id, ...(view === "shell" ? {} : { view }), ...params });
    return `/p?${query.toString()}`;
  }
  const query = new URLSearchParams(params).toString();
  const suffix = view === "shell" ? "" : `/${view}`;
  return `/p/${encodeUriSegment(id)}${suffix}${query ? `?${query}` : ""}`;
}

/**
 * Loads the iframe on the first `ready`, so the page is requested only once the stream is
 * subscribed and no change can land unseen between the two; a stream that fails before `ready`
 * still loads it. Then reloads the iframe on each `reload` event, keeping the variant picked in the
 * page, and after any `ready` whose generation shows a change was missed.
 */
export const PROTOTYPE_PREVIEW_SHELL_SCRIPT = [
  "(() => {",
  'const frame = document.querySelector("iframe[data-preview]");',
  'const status = document.querySelector("[data-preview-status]");',
  "const events = new EventSource(document.body.dataset.events);",
  "let generation;",
  "let loaded = false;",
  "const reload = () => {",
  "if (!loaded) {",
  "loaded = true;",
  "frame.src = frame.dataset.page;",
  "return;",
  "}",
  'const picked = frame.contentDocument?.querySelector("[data-control=variant]")?.value;',
  'const next = new URL(frame.getAttribute("src"), location.href);',
  'if (picked) next.searchParams.set("variant", picked);',
  'next.searchParams.set("generation", String(generation));',
  "frame.src = next.pathname + next.search;",
  "};",
  'events.addEventListener("ready", (event) => {',
  "const seen = JSON.parse(event.data).generation;",
  "const missed = !loaded || seen !== generation;",
  "generation = seen;",
  'status.textContent = "Live";',
  "if (missed) reload();",
  "});",
  'events.addEventListener("reload", (event) => {',
  "generation = JSON.parse(event.data).generation;",
  "reload();",
  "});",
  "events.onerror = () => {",
  'status.textContent = "Reconnecting";',
  "if (!loaded) reload();",
  "};",
  "})();",
].join("\n");

const SHELL_SCRIPT_HASH = createHash("sha256")
  .update(PROTOTYPE_PREVIEW_SHELL_SCRIPT)
  .digest("base64");

const COMMON_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const SHELL_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${SHELL_SCRIPT_HASH}'`,
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

const STATIC_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";

const BASE_CSS =
  "html,body{margin:0;height:100%;font:14px system-ui,-apple-system,Roboto,sans-serif}" +
  "body{display:flex;flex-direction:column}" +
  "header{display:flex;gap:12px;align-items:center;padding:6px 12px;border-bottom:1px solid #ccc}" +
  "iframe{flex:1;border:0;width:100%}main{padding:16px}";

function htmlDocument(title: string, body: readonly WebChild[], bodyAttrs = {}): string {
  const head = `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>${toHtml(title)}</title><style>${BASE_CSS}</style></head>`;
  const content = toHtml(el("body", { attrs: bodyAttrs }, body));
  return `<!doctype html><html lang="en">${head}${content}</html>\n`;
}

function html(status: number, body: string, csp = STATIC_CSP): PrototypePreviewResponse {
  return {
    status,
    headers: {
      ...COMMON_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
    },
    body,
  };
}

function text(status: number, body: string): PrototypePreviewResponse {
  return {
    status,
    headers: { ...COMMON_HEADERS, "content-type": "text/plain; charset=utf-8" },
    body,
  };
}

function indexPage(source: PrototypePreviewPageSource): PrototypePreviewResponse {
  const ids = source.ids();
  const list =
    ids.length === 0
      ? el("p", {}, ["No prototype shown yet. Show one and open its link here."])
      : el(
          "ul",
          {},
          ids.map((id) =>
            el("li", {}, [el("a", { attrs: { href: prototypePreviewPath(id) } }, [id])]),
          ),
        );
  return html(
    200,
    htmlDocument("AutoMobile prototypes", [el("main", {}, [el("h1", {}, ["Prototypes"]), list])]),
  );
}

function shellPage(query: PrototypePreviewPageQuery): PrototypePreviewResponse {
  const params = {
    ...(query.variant ? { variant: query.variant } : {}),
    ...(query.frame ? { frame: query.frame } : {}),
  };
  const header = el("header", {}, [
    el("a", { attrs: { href: "/" } }, ["All prototypes"]),
    el("strong", {}, [query.id]),
    el("span", { attrs: { "data-preview-status": "" } }, ["Connecting"]),
  ]);
  const frame = el("iframe", {
    attrs: {
      "data-preview": "",
      title: query.id,
      "data-page": prototypePreviewPath(query.id, "page", params),
    },
  });
  const page = htmlDocument(`${query.id} preview`, [header, frame], {
    "data-events": prototypePreviewPath(query.id, "events"),
  });
  // The script is appended after the body's content so the elements it queries exist.
  const withScript = page.replace(
    "</body>",
    `<script>${PROTOTYPE_PREVIEW_SHELL_SCRIPT}</script></body>`,
  );
  return html(200, withScript, SHELL_CSP);
}

function waitingPage(id: string): PrototypePreviewResponse {
  const note = `Prototype "${id}" has no web output yet. Show it and this page reloads.`;
  return html(404, htmlDocument(id, [el("main", {}, [el("p", {}, [note])])]));
}

/**
 * A variant the shell kept from an earlier reload that has since left the group falls back to the
 * page's own first variant, so the live page never sticks on an error.
 */
function currentVariant(
  source: PrototypePreviewPageSource,
  query: PrototypePreviewPageQuery,
): PrototypePreviewPageQuery {
  if (query.variant === undefined || source.related(query.id).includes(query.variant)) {
    return query;
  }
  return { id: query.id, ...(query.frame ? { frame: query.frame } : {}) };
}

async function prototypePage(
  source: PrototypePreviewPageSource,
  query: PrototypePreviewPageQuery,
): Promise<PrototypePreviewResponse> {
  if (!source.has(query.id)) {
    return waitingPage(query.id);
  }
  try {
    // The page carries its own CSP meta; the header only stops other origins framing it.
    return html(200, await source.page(currentVariant(source, query)), "frame-ancestors 'self'");
  } catch (error) {
    if (error instanceof ActionableError) {
      return text(400, error.message);
    }
    logger.warn(`[prototype] preview page for ${query.id} failed: ${errorMessage(error)}`, error);
    return text(500, "The prototype page could not be rendered; see the daemon log.");
  }
}

/** The response of every route but `events`, which the server streams itself. */
export async function prototypePreviewResponse(
  route: Exclude<PrototypePreviewRoute, { kind: "events" }>,
  source: PrototypePreviewPageSource,
): Promise<PrototypePreviewResponse> {
  switch (route.kind) {
    case "index":
      return indexPage(source);
    case "shell":
      return shellPage(route);
    case "page":
      return prototypePage(source, route);
    case "notFound":
      return text(404, "Not found");
  }
}

/** Plain-text refusals the server answers before routing. */
export const prototypePreviewRefusal = {
  method: (): PrototypePreviewResponse => text(405, "Only GET is served"),
  host: (): PrototypePreviewResponse =>
    text(421, "This preview server answers its loopback address only"),
};

/** The headers that open an event stream. */
export const PROTOTYPE_PREVIEW_EVENT_HEADERS: Readonly<Record<string, string>> = {
  ...COMMON_HEADERS,
  "content-type": "text/event-stream; charset=utf-8",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};
