#!/usr/bin/env bun
/**
 * Release-time capability guard (issue #12996).
 *
 *   bun scripts/release/check-artifact-capabilities.ts
 *       Fail when a capability the host (`src/`) gates on is not advertised by
 *       the newest pinned release in src/constants/release.ts, according to the
 *       checked-in manifest scripts/release/artifact-capabilities.json.
 *   bun scripts/release/check-artifact-capabilities.ts --record <version> --ref <git ref>
 *       Record what the artifacts built from <git ref> advertise (read from the
 *       Kotlin/Swift sources at that ref via `git show`) under <version>. The
 *       release procedure runs this when it pins a new release.
 *
 * Nothing is downloaded. A pinned version with no manifest entry fails too, so
 * a release cannot be pinned without recording its capabilities.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RELEASE_CHECKSUM_REGISTRY } from "../../src/constants/release";
import {
  ADVERTISING_SOURCES,
  ARTIFACTS,
  HOST_GATE_SOURCES,
  type ArtifactCapabilities,
  type ArtifactId,
  type CapabilityManifest,
  findGaps,
  formatGaps,
  parseAndroidAdvertised,
  parseIosRunnerAdvertised,
  parseManifest,
  parsePrototypeAgentAdvertised,
  gatedByScans,
  recordRelease,
  scanHostGates,
} from "./lib/artifact-capabilities";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts/release/artifact-capabilities.json");

const ADVERTISED_PARSERS: Record<ArtifactId, (source: string) => string[]> = {
  "android-ctrlproxy-apk": parseAndroidAdvertised,
  "ios-runner": parseIosRunnerAdvertised,
  "prototype-agent-dylib": parsePrototypeAgentAdvertised,
};

function listTsFiles(target: string): string[] {
  const absolute = path.join(REPO_ROOT, target);
  if (!existsSync(absolute)) {
    throw new Error(`host gate source not found: ${target}`);
  }
  if (!statSync(absolute).isDirectory()) {
    return [absolute];
  }
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(absolute, entry));
}

function collectHostGated(): Record<ArtifactId, string[]> {
  const scansByArtifact = {} as Record<ArtifactId, ReturnType<typeof scanHostGates>[]>;
  const declared: Record<string, string> = {};
  for (const artifact of ARTIFACTS) {
    const files = HOST_GATE_SOURCES[artifact].flatMap(listTsFiles);
    scansByArtifact[artifact] = files.map((file) => {
      const scan = scanHostGates(readFileSync(file, "utf8"));
      Object.assign(declared, scan.declared);
      return scan;
    });
  }
  const result = {} as Record<ArtifactId, string[]>;
  for (const artifact of ARTIFACTS) {
    result[artifact] = gatedByScans(scansByArtifact[artifact], declared);
  }
  return result;
}

function readManifest(): CapabilityManifest {
  return parseManifest(readFileSync(MANIFEST_PATH, "utf8"));
}

function record(version: string, ref: string): void {
  const advertised = {} as ArtifactCapabilities;
  for (const artifact of ARTIFACTS) {
    const source = execFileSync("git", ["show", `${ref}:${ADVERTISING_SOURCES[artifact]}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    advertised[artifact] = ADVERTISED_PARSERS[artifact](source);
  }
  const manifest = recordRelease(readManifest(), version, advertised);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Recorded ${version} capabilities from ${ref}\n`);
}

function check(): number {
  const pinned = RELEASE_CHECKSUM_REGISTRY[0]?.version;
  if (!pinned) {
    process.stderr.write("RELEASE_CHECKSUM_REGISTRY is empty\n");
    return 1;
  }
  const entry = readManifest().releases[pinned];
  if (!entry) {
    process.stderr.write(
      `No capabilities recorded for pinned release ${pinned}; run with --record ${pinned} --ref <git ref>\n`,
    );
    return 1;
  }
  const gaps = findGaps(entry, collectHostGated());
  if (gaps.length > 0) {
    process.stderr.write(`${formatGaps(pinned, gaps)}\n`);
    return 1;
  }
  process.stdout.write(`Pinned release ${pinned} advertises every capability the host gates on\n`);
  return 0;
}

function main(argv: string[]): number {
  const recordIndex = argv.indexOf("--record");
  if (recordIndex === -1) {
    return check();
  }
  const version = argv[recordIndex + 1];
  const refIndex = argv.indexOf("--ref");
  const ref = refIndex === -1 ? undefined : argv[refIndex + 1];
  if (!version || !ref) {
    process.stderr.write("usage: --record <version> --ref <git ref>\n");
    return 2;
  }
  record(version, ref);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
