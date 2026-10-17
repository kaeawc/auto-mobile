// Pure checks over MkDocs-built HTML. A project Pages site is served under a
// base path (https://<owner>.github.io/<repo>/), so every local reference in
// the built output must either be relative or start with that base path, and
// every local stylesheet/script/image must exist in the build output. Guards
// the failure where 404.html rendered root-absolute asset URLs
// (`/assets/...`) because mkdocs.yml had no `site_url`, leaving the page
// unstyled once Pages served it under `/auto-mobile/`.

export interface SiteViolation {
  page: string;
  tag: string;
  url: string;
  reason: "root-absolute-outside-base" | "missing-file";
}

interface Reference {
  tag: string;
  url: string;
  // Whether the target must exist as a file in the build output.
  mustExist: boolean;
}

// attribute holding the URL, per element; `mustExist` for asset-like elements.
const REFERENCE_SELECTORS: ReadonlyArray<{
  selector: string;
  attribute: string;
  mustExist: boolean;
}> = [
  { selector: "link[rel~=stylesheet]", attribute: "href", mustExist: true },
  { selector: "link[rel~=icon]", attribute: "href", mustExist: true },
  { selector: "link[rel~=preload]", attribute: "href", mustExist: true },
  { selector: "script[src]", attribute: "src", mustExist: true },
  { selector: "img[src]", attribute: "src", mustExist: true },
  { selector: "source[src]", attribute: "src", mustExist: true },
  { selector: "a[href]", attribute: "href", mustExist: false },
];

const NON_LOCAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

export async function collectReferences(html: string): Promise<Reference[]> {
  const references: Reference[] = [];
  let rewriter = new HTMLRewriter();
  for (const { selector, attribute, mustExist } of REFERENCE_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element(element) {
        const url = element.getAttribute(attribute);
        if (url !== null && url.trim() !== "") {
          references.push({ tag: element.tagName, url: url.trim(), mustExist });
        }
      },
    });
  }
  await rewriter.transform(new Response(html)).text();
  return references;
}

export function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "/" : `/${trimmed}/`;
}

/** Site-relative file path (no leading slash) a reference resolves to, or null if outside the site. */
export function resolveSitePath(pagePath: string, url: string, basePath: string): string | null {
  const base = normalizeBasePath(basePath);
  const origin = "http://site.invalid";
  const pageUrl = new URL(`${base}${pagePath}`, origin);
  const target = new URL(url, pageUrl);
  if (!target.pathname.startsWith(base)) {
    return null;
  }
  const relative = decodeURIComponent(target.pathname.slice(base.length));
  return relative === "" || relative.endsWith("/") ? `${relative}index.html` : relative;
}

export async function checkPage(
  pagePath: string,
  html: string,
  basePath: string,
  exists: (sitePath: string) => boolean,
): Promise<SiteViolation[]> {
  const base = normalizeBasePath(basePath);
  const violations: SiteViolation[] = [];
  for (const { tag, url, mustExist } of await collectReferences(html)) {
    if (NON_LOCAL.test(url)) {
      continue;
    }
    const sitePath = resolveSitePath(pagePath, url, base);
    if (sitePath === null) {
      violations.push({ page: pagePath, tag, url, reason: "root-absolute-outside-base" });
    } else if (mustExist && !exists(sitePath)) {
      violations.push({ page: pagePath, tag, url, reason: "missing-file" });
    }
  }
  return violations;
}

export function formatViolation(violation: SiteViolation): string {
  const why =
    violation.reason === "root-absolute-outside-base"
      ? "resolves outside the site base path"
      : "does not exist in the build output";
  return `${violation.page}: <${violation.tag}> ${violation.url} ${why}`;
}
