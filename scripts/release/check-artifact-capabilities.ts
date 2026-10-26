#!/usr/bin/env bun
/**
 * Release-time capability guard (issue #12996).
 *
 *   bun scripts/release/check-artifact-capabilities.ts
 *       Fail when a capability the host (`src/`) gates on is not advertised by
 *       the newest pinned release in src/constants/release.ts, according to the
 *       checked-in manifest scripts/release/artifact-capabilities.json.
 *   bun scripts/release/check-artifact-capabilities.ts --candidate
 *       Same comparison against what the checked-out sources advertise. prepare-release
 *       runs this before building, so a release cannot ship with gaps (#15347).
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
  UNIMPLEMENTED_BY_ARTIFACT,
  HOST_GATE_SOURCES,
  type ArtifactCapabilities,
  type ArtifactId,
  type CapabilityManifest,
  findGaps,
  findStaleExemptions,
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
    const source = ADVERTISING_SOURCES[artifact]
      .map((file) =>
        execFileSync("git", ["show", `${ref}:${file}`], { cwd: REPO_ROOT, encoding: "utf8" }),
      )
      .join("\n");
    advertised[artifact] = ADVERTISED_PARSERS[artifact](source);
  }
  const manifest = recordRelease(readManifest(), version, advertised);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Recorded ${version} capabilities from ${ref}\n`);
}

/** What the artifacts built from the current working tree would advertise. */
function advertisedFromWorkingTree(): ArtifactCapabilities {
  const advertised = {} as ArtifactCapabilities;
  for (const artifact of ARTIFACTS) {
    const source = ADVERTISING_SOURCES[artifact]
      .map((file) => readFileSync(path.join(REPO_ROOT, file), "utf8"))
      .join("\n");
    advertised[artifact] = ADVERTISED_PARSERS[artifact](source);
  }
  return advertised;
}

function report(label: string, advertised: ArtifactCapabilities): number {
  const gated = collectHostGated();
  const gaps = findGaps(advertised, gated, UNIMPLEMENTED_BY_ARTIFACT);
  const stale = findStaleExemptions(advertised, UNIMPLEMENTED_BY_ARTIFACT);
  if (gaps.length > 0) {
    process.stderr.write(`${formatGaps(label, gaps)}\n`);
  }
  if (stale.length > 0) {
    const lines = stale.map((gap) => `  - ${gap.artifact}: ${gap.capability}`);
    process.stderr.write(
      `${label} advertises capabilities still listed in UNIMPLEMENTED_BY_ARTIFACT; remove the stale entries:\n${lines.join("\n")}\n`,
    );
  }
  return gaps.length > 0 || stale.length > 0 ? 1 : 0;
}

/**
 * Release-candidate guard (prepare-release, #15347): compares the host gates with what the
 * artifacts built from this checkout will advertise. Reads sources only, so it needs no manifest
 * entry for the version being cut.
 */
function checkCandidate(): number {
  const status = report("Release candidate", advertisedFromWorkingTree());
  if (status === 0) {
    process.stdout.write("Release candidate advertises every capability the host gates on\n");
  }
  return status;
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
  const status = report(`Pinned release ${pinned}`, entry);
  if (status === 0) {
    process.stdout.write(
      `Pinned release ${pinned} advertises every capability the host gates on\n`,
    );
  }
  return status;
}

function main(argv: string[]): number {
  if (argv.includes("--candidate")) {
    return checkCandidate();
  }
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
