// Mirrors how GitHub Pages serves a project site: files exist only under the
// base path (https://<owner>.github.io/<repo>/), directory URLs map to
// index.html, and any other path answers 404 with the site's 404.html.

export type PagesResolution =
  | { kind: "file"; sitePath: string; status: 200 }
  | { kind: "not-found-page"; sitePath: "404.html"; status: 404 }
  | { kind: "not-found-bare"; status: 404 };

export function resolvePagesRequest(
  basePath: string,
  requestPath: string,
  exists: (sitePath: string) => boolean,
): PagesResolution {
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  // Pages answers the bare domain/other repos with its own 404, not this site's.
  if (!requestPath.startsWith(base)) {
    return { kind: "not-found-bare", status: 404 };
  }
  const relative = decodeURIComponent(requestPath.slice(base.length));
  const candidates =
    relative === "" || relative.endsWith("/")
      ? [`${relative}index.html`]
      : [relative, `${relative}/index.html`];
  const hit = candidates.find((candidate) => !candidate.includes("..") && exists(candidate));
  return hit
    ? { kind: "file", sitePath: hit, status: 200 }
    : { kind: "not-found-page", sitePath: "404.html", status: 404 };
}
