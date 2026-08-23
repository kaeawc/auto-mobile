#!/usr/bin/env bun

import { pathToFileURL } from "node:url";
import path from "node:path";

interface ReleaseChecksumEntry {
  [field: string]: string | undefined;
  version: string;
}

interface ReleaseModule {
  RELEASE_CHECKSUM_REGISTRY?: ReleaseChecksumEntry[];
  NIGHTLY_CHECKSUM_ENTRY?: ReleaseChecksumEntry;
}

export async function readReleaseRegistryField(
  field: string,
  sourcePath: string,
  version?: string,
): Promise<string> {
  const sourceUrl = pathToFileURL(path.resolve(sourcePath));
  sourceUrl.searchParams.set("release-registry-read", Date.now().toString());
  const release = (await import(sourceUrl.href)) as ReleaseModule;
  const entry = version
    ? version === "nightly"
      ? release.NIGHTLY_CHECKSUM_ENTRY
      : release.RELEASE_CHECKSUM_REGISTRY?.find((candidate) => candidate.version === version)
    : release.RELEASE_CHECKSUM_REGISTRY?.[0];
  const value = entry?.[field];
  return typeof value === "string" ? value : "";
}

async function main(): Promise<void> {
  const [field, sourcePath, version] = process.argv.slice(2);
  if (!field || !sourcePath) {
    throw new Error(
      "Usage: bun scripts/read-release-registry.ts <field> <release.ts path> [version]",
    );
  }
  process.stdout.write(`${await readReleaseRegistryField(field, sourcePath, version)}\n`);
}

if (import.meta.main) {
  await main();
}
