#!/usr/bin/env bun
/**
 * Fast Validation gate for the ProtoViewer store listing (#14152).
 *
 *   bun scripts/store-listing/validate-store-listing.ts
 *
 * Checks the fastlane metadata tree against the Play and App Store limits and required fields, and
 * that the icon source layers parse and share the adaptive-icon canvas. Reads files only; renders
 * nothing and needs no native tooling.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_SOURCE_DIR } from "./iconTargets";
import { validateIconSvg } from "./iconSourceCheck";
import { type Finding, type ListingFiles, validateListing } from "./storeListing";

export const METADATA_DIR = "fastlane/metadata";

/** Reads the tree: `.txt` files with their text, any other file (art) as an empty entry. */
export function readListingTree(root: string): ListingFiles {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    readdirSync(dir)
      .sort()
      .forEach((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          return;
        }
        const rel = relative(root, full).split("\\").join("/");
        files.set(rel, name.endsWith(".txt") ? readFileSync(full, "utf8") : "");
      });
  };
  if (existsSync(root)) {
    walk(root);
  }
  return files;
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `${METADATA_DIR}/${finding.path}: ${finding.message}`)
    .join("\n");
}

export async function main(): Promise<number> {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const files = readListingTree(join(repoRoot, METADATA_DIR));
  const findings = validateListing(files);
  const readLayer = (name: string): string | undefined => {
    const path = join(repoRoot, ICON_SOURCE_DIR, name);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  const iconFindings = (
    await Promise.all(
      ["background.svg", "foreground.svg"].map((name) =>
        validateIconSvg(`${ICON_SOURCE_DIR}/${name}`, readLayer(name)),
      ),
    )
  ).flat();
  const problems = [
    ...(findings.length > 0 ? [formatFindings(findings)] : []),
    ...iconFindings.map((finding) => `${finding.path}: ${finding.message}`),
  ];
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    return 1;
  }
  console.log(`ProtoViewer store listing is valid (${files.size} metadata files).`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
