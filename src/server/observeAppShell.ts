import { createHash } from "node:crypto";
import { OBSERVE_SHELL_CLIENT_FUNCTIONS, shellBoot } from "./observeAppShellClient";

/**
 * The stable, read-only live shell behind `ui://automobile/observe` for MCP Apps hosts (#4682).
 * The HTML never contains device data: the host delivers each `observe` tool result over
 * `postMessage` and the inline script renders it, so the page is the same bytes for every call,
 * session and device and cannot show another call's capture.
 *
 * Containment, in layers:
 * 1. The document carries its own CSP `<meta>` that allows nothing but this page's one inline
 *    script and one inline stylesheet (by SHA-256) and `data:` images: no network (`connect-src`,
 *    `frame-src`, `object-src`, `form-action`, `base-uri` are `'none'`).
 * 2. The resource's `_meta.ui` asks the host for the same: empty `csp` domain lists and no
 *    `permissions`, so a conforming host builds an equally empty policy and grants no camera,
 *    microphone, geolocation or clipboard.
 * 3. The host's own sandbox. MCP Apps hosts render the view in a sandboxed iframe; the shell needs
 *    only `allow-scripts` and works with an opaque origin (`allow-same-origin` is not required and
 *    must not be granted), a document that never touches storage, cookies or the parent's DOM.
 * 4. The script never sends a request other than `ui/initialize`, so the App cannot call tools.
 *
 * Host requirement: a `<meta>` CSP cannot set `frame-ancestors` or `sandbox`, so the host must
 * render the view in a sandboxed iframe with `allow-scripts` only: never `allow-same-origin`,
 * `allow-top-navigation`, `allow-popups` or `allow-forms`.
 */
export const OBSERVE_APP_SHELL_STYLE = `:root { color-scheme: light dark; --am-bg:#f6f7f9; --am-fg:#1b1f24; --am-box:#2f6feb; --am-backdrop:#e7e9ee; }
@media (prefers-color-scheme: dark) { :root { --am-bg:#0f1216; --am-fg:#e6e8eb; --am-box:#6ea8ff; --am-backdrop:#1b1f24; } }
:root[data-theme="light"] { --am-bg:#f6f7f9; --am-fg:#1b1f24; --am-box:#2f6feb; --am-backdrop:#e7e9ee; }
:root[data-theme="dark"] { --am-bg:#0f1216; --am-fg:#e6e8eb; --am-box:#6ea8ff; --am-backdrop:#1b1f24; }
* { box-sizing: border-box; }
body { margin:0; padding:12px; background:var(--am-bg); color:var(--am-fg); font:14px/1.4 system-ui, sans-serif; }
#stage { max-width:100%; margin:0 auto; }
#canvas { width:100%; height:auto; max-width:100%; display:block; background:var(--am-backdrop); border-radius:8px; }
.am-box { fill:transparent; stroke:var(--am-box); stroke-width:1.5; vector-effect:non-scaling-stroke; }
.am-box:hover { fill:color-mix(in srgb, var(--am-box) 18%, transparent); }
#status { margin:0 0 8px; opacity:.75; }`;

/** The one inline script: the client functions followed by the call that starts them. */
export function observeAppShellScript(): string {
  return `${OBSERVE_SHELL_CLIENT_FUNCTIONS.map((fn) => fn.toString()).join("\n")}\n${shellBoot.name}(window, document);`;
}

function sha256Source(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** The CSP carried by the shell's `<meta>`: nothing is allowed beyond the two hashed inline blocks. */
export function observeAppShellCsp(script = observeAppShellScript()): string {
  return [
    "default-src 'none'",
    `script-src ${sha256Source(script)}`,
    `style-src ${sha256Source(OBSERVE_APP_SHELL_STYLE)}`,
    "img-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** `_meta.ui` for the shell's resource content: no network origins, no powerful permissions. */
export const OBSERVE_APP_SHELL_META = {
  ui: {
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    permissions: {},
    prefersBorder: true,
  },
} as const;

/** The shell document. Pure and constant: the same bytes on every read. */
export function renderObserveAppShellHtml(): string {
  const script = observeAppShellScript();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${observeAppShellCsp(script)}"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>AutoMobile — observe</title>
<style>${OBSERVE_APP_SHELL_STYLE}</style>
</head>
<body>
<main id="stage" data-observe-app="shell">
<p id="status">Waiting for an observe result…</p>
<svg id="canvas" viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="observe screen overlay"></svg>
</main>
<script>${script}</script>
</body>
</html>`;
}
