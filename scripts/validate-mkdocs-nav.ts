#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";

const COPIED_FILES = new Set(["changelog.md", "contributing.md"]);
const EXCLUDED_FILES = new Set([
  "ai/structure.md",
  "ai/platforms.md",
  "ai/mcp-tools.md",
  "ai/vision-fallback-design.md",
  "ai/vision-model-research.md",
  "origin.md",
  "design-docs/mcp/system-design.md",
  "design-docs/mcp/vision-fallback.md",
  "design-docs/plat/android/docker.md",
  "using/perf-analysis.md",
  // Author/design docs kept in the repo but intentionally off the site nav
  // (mirrors mkdocs.yml `not_in_nav`).
  "design-docs/mcp/daemon/screen-control-mapping.md",
  "design-docs/plat/android/system-tray-lookfor.md",
  "design-docs/plat/android/accessibility-data-sensitive-windows.md",
  "release/ios-simulator-continuity.md",
  "design-docs/plat/ios/xctestrunner/ci-integration.md",
  "decisions/ios-user-files-provider.md",
]);
const TODO_IGNORED_FILES = new Set(["contributing.md"]);

export function collectNavFiles(value: unknown): string[] {
  if (typeof value === "string") {
    return value.endsWith(".md") ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectNavFiles);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectNavFiles);
  }
  return [];
}

async function markdownFiles(docsDir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.md");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: docsDir, onlyFiles: true })) {
    if (!file.startsWith(".")) {
      files.push(file);
    }
  }
  return files.sort();
}

async function main(): Promise<void> {
  const root = process.cwd();
  const mkdocsPath = path.join(root, "mkdocs.yml");
  const docsDir = path.join(root, "docs");
  // MkDocs accepts Python-specific tags in plugin configuration. They are not
  // nav data and js-yaml cannot construct them, so neutralize only the tag
  // annotation before structurally parsing the document.
  const yaml = (await readFile(mkdocsPath, "utf8")).replace(/!!python\/name:[^\s]+/g, "");
  const parsed = load(yaml, { filename: mkdocsPath });
  const nav =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).nav
      : undefined;
  if (!nav) {
    throw new Error("mkdocs.yml has no nav section");
  }

  const navFiles = collectNavFiles(nav);
  const referenced = new Set(navFiles);
  const actual = await markdownFiles(docsDir);
  const missing = [...referenced].filter(
    (file) => !COPIED_FILES.has(file) && !existsSync(path.join(docsDir, file)),
  );
  const orphaned = actual.filter(
    (file) => !COPIED_FILES.has(file) && !EXCLUDED_FILES.has(file) && !referenced.has(file),
  );
  const duplicates = [
    ...new Set(navFiles.filter((file, index) => navFiles.indexOf(file) !== index)),
  ].sort();
  const todoFiles = (
    await Promise.all(
      actual.map(async (file) => {
        const content = await readFile(path.join(docsDir, file), "utf8");
        return !EXCLUDED_FILES.has(file) && !TODO_IGNORED_FILES.has(file) && /TODO/i.test(content)
          ? file
          : undefined;
      }),
    )
  ).filter((file): file is string => file !== undefined);
  const emptyFiles = (
    await Promise.all(
      actual.map(async (file) => {
        const content = await readFile(path.join(docsDir, file), "utf8");
        return !EXCLUDED_FILES.has(file) && content.trim().length === 0 ? file : undefined;
      }),
    )
  ).filter((file): file is string => file !== undefined);

  console.log(
    `Found ${referenced.size} files referenced in mkdocs.yml and ${actual.length} markdown files.`,
  );
  const failures = [
    ["Missing", missing],
    ["Orphaned", orphaned],
    ["Duplicate nav", duplicates],
    ["TODO", todoFiles],
    ["Empty", emptyFiles],
  ] as const;
  for (const [label, files] of failures) {
    if (files.length > 0) {
      console.error(`${label} files:\n${files.map((file) => `  - ${file}`).join("\n")}`);
    }
  }
  if (failures.some(([, files]) => files.length > 0)) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
