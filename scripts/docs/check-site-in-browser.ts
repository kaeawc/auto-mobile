#!/usr/bin/env bun
//
// Load key pages of a built MkDocs site in headless Chrome, served the way
// GitHub Pages serves it (under the /auto-mobile/ base path, 404.html for
// missing pages), and assert the Material theme actually applied.
//
// Usage: bun scripts/docs/check-site-in-browser.ts <site-dir> [--base-path /auto-mobile/] [--screenshots <dir>]
//
// Per page: every same-origin subresource answers 200, every same-origin
// stylesheet parsed, the Material header is laid out and sticky, and the body
// font is the configured theme font (not the browser default). Chrome comes from
// AUTOMOBILE_CHROME_BINARY or the standard Linux/macOS install paths. Screenshots
// are written for upload as a CI artifact; this check is structural, so no
// pixel baselines are committed.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseFromMkdocs } from "./check-built-site";
import { normalizeBasePath } from "./built-site-check";
import { resolvePagesRequest } from "./pagesRouting";

const ROOT = join(import.meta.dir, "..", "..");

interface PageSpec {
  path: string;
  // HTTP status expected for the document itself.
  status: number;
  // When set, the document is a dead URL that must redirect to this site path
  // (relative to the base path) and land on a rendered page there.
  redirectsTo?: string;
}

const PAGES: PageSpec[] = [
  { path: "", status: 200 },
  { path: "tools/", status: 200 },
  { path: "using/agent-examples/", status: 200 },
  { path: "design-docs/plat/android/prototype-ux/", status: 200 },
  // GitHub Pages serves 404.html for a dead link; it redirects to the home page.
  { path: "using/this-page-does-not-exist/", status: 404, redirectsTo: "" },
];

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  gif: "image/gif",
  woff2: "font/woff2",
  xml: "application/xml",
};

function resolveChrome(): string {
  const configured = process.env.AUTOMOBILE_CHROME_BINARY;
  if (configured) {
    return configured;
  }
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error("Chrome is required; install it or set AUTOMOBILE_CHROME_BINARY");
  }
  return found;
}

function serveSite(siteDir: string, basePath: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const { pathname } = new URL(request.url);
      const resolved = resolvePagesRequest(basePath, pathname, (sitePath) =>
        existsSync(join(siteDir, sitePath)),
      );
      if (resolved.kind === "not-found-bare") {
        return new Response("Not Found", { status: 404 });
      }
      const extension = resolved.sitePath.split(".").pop() ?? "";
      return new Response(Bun.file(join(siteDir, resolved.sitePath)), {
        status: resolved.status,
        headers: { "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream" },
      });
    },
  });
}

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  readonly listeners: Array<(message: Record<string, unknown>) => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (typeof message.id === "number") {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else {
        this.listeners.forEach((listener) => listener(message));
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`could not open DevTools socket ${url}`));
    });
    return new Cdp(socket);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.error) {
          reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        } else {
          resolve(message.result as T);
        }
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function waitForDevToolsEndpoint(profileDir: string, deadlineMs: number): Promise<string> {
  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, "utf8").split("\n");
      return `http://127.0.0.1:${port}`;
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome did not publish a DevTools port");
}

// Evaluated inside the page. Returns plain data; assertions run in Node.
const PAGE_PROBE = `(() => {
  const header = document.querySelector(".md-header");
  const headerStyle = header ? getComputedStyle(header) : null;
  const rect = header ? header.getBoundingClientRect() : null;
  const sheets = [...document.querySelectorAll('link[rel~="stylesheet"]')]
    .filter((link) => new URL(link.href).origin === location.origin)
    .map((link) => ({ href: link.getAttribute("href"), parsed: link.sheet !== null }));
  return {
    headerPosition: headerStyle && headerStyle.position,
    headerDisplay: headerStyle && headerStyle.display,
    headerHeight: rect && rect.height,
    bodyFont: getComputedStyle(document.body).fontFamily,
    hasContent: document.querySelector(".md-content") !== null,
    isNotFoundPage: document.getElementById("home-link") !== null,
    finalUrl: location.href,
    sheets,
  };
})()`;

interface ProbeResult {
  headerPosition: string | null;
  headerDisplay: string | null;
  headerHeight: number | null;
  bodyFont: string;
  hasContent: boolean;
  isNotFoundPage: boolean;
  finalUrl: string;
  sheets: Array<{ href: string; parsed: boolean }>;
}

export function probeProblems(probe: ProbeResult): string[] {
  const problems: string[] = [];
  if (probe.headerPosition === null) {
    problems.push("no .md-header element (Material layout missing)");
  } else {
    if (probe.headerDisplay === "none" || !probe.headerHeight) {
      problems.push(`.md-header is not laid out (display=${probe.headerDisplay})`);
    }
    if (probe.headerPosition !== "sticky" && probe.headerPosition !== "fixed") {
      problems.push(`.md-header position is ${probe.headerPosition}, expected sticky (unstyled?)`);
    }
  }
  if (!probe.hasContent) {
    problems.push("no .md-content element");
  }
  if (!probe.bodyFont.includes("Shantell Sans")) {
    problems.push(`body font is "${probe.bodyFont}", expected the theme font Shantell Sans`);
  }
  if (probe.sheets.length === 0) {
    problems.push("page has no same-origin stylesheets");
  }
  for (const sheet of probe.sheets.filter((s) => !s.parsed)) {
    problems.push(`stylesheet ${sheet.href} did not load`);
  }
  return problems;
}

// A dead URL must end on the home page (final URL == base, not the 404 page).
export function redirectProblems(probe: ProbeResult, expectedUrl: string): string[] {
  const problems: string[] = [];
  if (probe.finalUrl !== expectedUrl) {
    problems.push(`redirected to ${probe.finalUrl}, expected ${expectedUrl}`);
  }
  if (probe.isNotFoundPage) {
    problems.push("still showing the 404 page after the redirect");
  }
  return problems;
}

async function waitForUrl(cdp: Cdp, sessionId: string, expectedUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { result } = await cdp.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "location.href + '|' + document.readyState", returnByValue: true },
      sessionId,
    );
    if (result.value === `${expectedUrl}|complete`) {
      return;
    }
    await Bun.sleep(100);
  }
}

async function checkPage(
  cdp: Cdp,
  sessionId: string,
  origin: string,
  basePath: string,
  spec: PageSpec,
  screenshotDir: string | undefined,
): Promise<string[]> {
  const problems: string[] = [];
  const documentUrl = `${origin}${basePath}${spec.path}`;
  const listener = (message: Record<string, unknown>) => {
    if (message.sessionId !== sessionId) {
      return;
    }
    const params = (message.params ?? {}) as Record<string, any>;
    if (message.method === "Network.responseReceived") {
      const { url, status } = params.response as { url: string; status: number };
      const isDocument = params.type === "Document";
      if (url.startsWith(origin) && !isDocument && status >= 400) {
        problems.push(`${url} answered ${status}`);
      }
      if (isDocument && url === documentUrl && status !== spec.status) {
        problems.push(`document answered ${status}, expected ${spec.status}`);
      }
    } else if (message.method === "Network.loadingFailed" && params.canceled !== true) {
      // External hosts (Google Fonts) are unreachable by design; only local failures count.
      if (String(params.errorText).length > 0 && params.requestUrl?.startsWith?.(origin)) {
        problems.push(`${params.requestUrl} failed: ${params.errorText}`);
      }
    }
  };
  cdp.listeners.push(listener);
  const loaded = new Promise<void>((resolve) => {
    const onEvent = (message: Record<string, unknown>) => {
      if (message.sessionId === sessionId && message.method === "Page.loadEventFired") {
        resolve();
      }
    };
    cdp.listeners.push(onEvent);
  });
  await cdp.send("Page.navigate", { url: documentUrl }, sessionId);
  await Promise.race([loaded, Bun.sleep(15_000)]);
  const expectedUrl =
    spec.redirectsTo === undefined ? undefined : `${origin}${basePath}${spec.redirectsTo}`;
  if (expectedUrl) {
    await waitForUrl(cdp, sessionId, expectedUrl);
  }
  const evaluation = await cdp.send<{ result: { value: ProbeResult } }>(
    "Runtime.evaluate",
    { expression: PAGE_PROBE, returnByValue: true },
    sessionId,
  );
  problems.push(...probeProblems(evaluation.result.value));
  if (expectedUrl) {
    problems.push(...redirectProblems(evaluation.result.value, expectedUrl));
  }
  if (screenshotDir) {
    const shot = await cdp.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png" },
      sessionId,
    );
    const name = (spec.path || "home").replace(/\/+$/g, "").replace(/\//g, "_");
    writeFileSync(join(screenshotDir, `${name}.png`), Buffer.from(shot.data, "base64"));
  }
  return problems;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const siteDir = args.find(
    (arg, i) =>
      !arg.startsWith("--") && args[i - 1] !== "--base-path" && args[i - 1] !== "--screenshots",
  );
  if (!siteDir || !existsSync(siteDir)) {
    console.error(
      "usage: check-site-in-browser.ts <site-dir> [--base-path /base/] [--screenshots <dir>]",
    );
    return 2;
  }
  const basePath = valueOf("--base-path")
    ? normalizeBasePath(valueOf("--base-path") as string)
    : baseFromMkdocs(join(ROOT, "mkdocs.yml"));
  const screenshotDir = valueOf("--screenshots");
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
  }

  const server = serveSite(siteDir, basePath);
  const profileDir = mkdtempSync(join(tmpdir(), "docs-site-chrome-"));
  const chrome = spawn(
    resolveChrome(),
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let failures = 0;
  try {
    const endpoint = await waitForDevToolsEndpoint(profileDir, 30_000);
    const version = (await (await fetch(`${endpoint}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: "light" }] },
      sessionId,
    );
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    const origin = `http://127.0.0.1:${server.port}`;
    for (const spec of PAGES) {
      const problems = await checkPage(cdp, sessionId, origin, basePath, spec, screenshotDir);
      if (problems.length > 0) {
        failures += 1;
        console.error(`FAIL ${basePath}${spec.path}`);
        problems.forEach((problem) => console.error(`  ${problem}`));
      } else {
        console.log(`ok   ${basePath}${spec.path}`);
      }
    }
    cdp.close();
  } finally {
    chrome.kill("SIGTERM");
    await server.stop(true);
    rmSync(profileDir, { recursive: true, force: true });
  }
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
