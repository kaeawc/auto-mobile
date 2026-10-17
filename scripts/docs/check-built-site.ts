#!/usr/bin/env bun
//
// Verify a built MkDocs site is safe to serve under its Pages base path.
//
// Usage: bun scripts/docs/check-built-site.ts <site-dir> [--base-path /auto-mobile/]
//
// The base path defaults to the path of `site_url` in mkdocs.yml. Fails (exit 1)
// when any built HTML page references a local URL that resolves outside the base
// path (e.g. root-absolute `/assets/...`) or a local stylesheet/script/image that
// is missing from the build output. See scripts/docs/built-site-check.ts.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import {
  checkPage,
  formatViolation,
  normalizeBasePath,
  type SiteViolation,
} from "./built-site-check";

const ROOT = join(import.meta.dir, "..", "..");

export function baseFromMkdocs(mkdocsPath: string): string {
  const config = Bun.YAML.parse(readFileSync(mkdocsPath, "utf8")) as { site_url?: string };
  if (!config.site_url) {
    throw new Error(`${mkdocsPath} has no site_url; the 404 page would use a root-absolute base`);
  }
  return normalizeBasePath(new URL(config.site_url).pathname);
}

export async function checkSiteDir(siteDir: string, basePath: string): Promise<SiteViolation[]> {
  const violations: SiteViolation[] = [];
  const exists = (sitePath: string) => existsSync(join(siteDir, sitePath));
  for (const file of new Glob("**/*.html").scanSync({ cwd: siteDir })) {
    const page = relative(siteDir, join(siteDir, file)).split("\\").join("/");
    const html = readFileSync(join(siteDir, file), "utf8");
    violations.push(...(await checkPage(page, html, basePath, exists)));
  }
  return violations;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base-path");
  const explicitBase = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
  const siteDir = args.find(
    (arg, i) => (!arg.startsWith("--") && baseIndex < 0) || i !== baseIndex + 1,
  );
  if (!siteDir || !existsSync(siteDir)) {
    console.error("usage: check-built-site.ts <site-dir> [--base-path /base/]");
    process.exit(2);
  }
  const basePath = explicitBase
    ? normalizeBasePath(explicitBase)
    : baseFromMkdocs(join(ROOT, "mkdocs.yml"));
  const violations = await checkSiteDir(siteDir, basePath);
  if (violations.length > 0) {
    console.error(`error: built site is not safe to serve under ${basePath}:`);
    for (const violation of violations.slice(0, 50)) {
      console.error(`  ${formatViolation(violation)}`);
    }
    if (violations.length > 50) {
      console.error(`  ... and ${violations.length - 50} more`);
    }
    process.exit(1);
  }
  console.log(`built site OK under ${basePath}`);
}
