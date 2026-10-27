#!/usr/bin/env bun
/**
 * Release-time capability guard (issue #12996).
 *
 *   bun scripts/release/check-artifact-capabilities.ts
 *       Fail when a capability the host (`src/`) gates on is not advertised by
 *       the newest pinned release in src/constants/release.ts, according to the
 *       checked-in manifest scripts/release/artifact-capabilities.json. Only gates
 *       that already existed at the pinned release's ref count: a capability gated
 *       on main after the pin is expected to be missing from the pinned artifacts
 *       until the next release (the host fails closed meanwhile), and --candidate
 *       enforces it before that release.
 *   bun scripts/release/check-artifact-capabilities.ts --candidate
 *       Same comparison against what the checked-out sources advertise. prepare-release
 *       runs this before building, so a release cannot ship with gaps (#15347).
 *   bun scripts/release/check-artifact-capabilities.ts --record <version> --ref <git ref>
 *       Record what the artifacts built from <git ref> advertise (read from the
 *       Kotlin/Swift sources at that ref via `git show`) under <version>. The
 *       release procedure runs this when it pins a new release.
 *
 * Pattern values and source are covered by prototype_stack_patterns_v1 in the host gate sources.
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
  gatedBySources,
  gatesAddedAfter,
  gatesExistingAt,
  parseAndroidAdvertised,
  parseIosRunnerAdvertised,
  parseManifest,
  parsePrototypeAgentAdvertised,
  recordRelease,
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
  return gatedBySources(
    Object.fromEntries(
      ARTIFACTS.map((artifact) => [
        artifact,
        HOST_GATE_SOURCES[artifact].flatMap(listTsFiles).map((file) => readFileSync(file, "utf8")),
      ]),
    ) as Record<ArtifactId, string[]>,
  );
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/** File contents at `ref` through one `git cat-file --batch` (one process per file is slow). */
function showAll(ref: string, files: string[]): string[] {
  if (files.length === 0) {
    return [];
  }
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: REPO_ROOT,
    input: files.map((file) => `${ref}:${file}\n`).join(""),
    maxBuffer: 256 * 1024 * 1024,
  });
  const contents: string[] = [];
  let offset = 0;
  for (const file of files) {
    const headerEnd = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, headerEnd).toString("utf8");
    const size = Number(header.split(" ")[2]);
    if (!header.includes(" blob ") || !Number.isInteger(size)) {
      throw new Error(`cannot read ${ref}:${file}: ${header}`);
    }
    contents.push(out.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
    offset = headerEnd + 1 + size + 1;
  }
  return contents;
}

/** Host gate sources as they were at `ref`; a source that did not exist yet is skipped. */
function collectHostGatedAt(ref: string): Record<ArtifactId, string[]> {
  const filesAt = (target: string): string[] =>
    git(["ls-tree", "-r", "--name-only", ref, "--", target])
      .split("\n")
      .filter((file) => file.endsWith(".ts"));
  return gatedBySources(
    Object.fromEntries(
      ARTIFACTS.map((artifact) => [
        artifact,
        showAll(ref, HOST_GATE_SOURCES[artifact].flatMap(filesAt)),
      ]),
    ) as Record<ArtifactId, string[]>,
  );
}

function readManifest(): CapabilityManifest {
  return parseManifest(readFileSync(MANIFEST_PATH, "utf8"));
}

function record(version: string, ref: string): void {
  const advertised = {} as ArtifactCapabilities;
  for (const artifact of ARTIFACTS) {
    const source = showAll(ref, ADVERTISING_SOURCES[artifact]).join("\n");
    advertised[artifact] = ADVERTISED_PARSERS[artifact](source);
  }
  const manifest = recordRelease(readManifest(), version, advertised, collectHostGatedAt(ref));
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

function report(
  label: string,
  advertised: ArtifactCapabilities,
  gated: Record<ArtifactId, string[]>,
): number {
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
  const status = report("Release candidate", advertisedFromWorkingTree(), collectHostGated());
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
  const manifest = readManifest();
  const entry = manifest.releases[pinned];
  if (!entry) {
    process.stderr.write(
      `No capabilities recorded for pinned release ${pinned}; run with --record ${pinned} --ref <git ref>\n`,
    );
    return 1;
  }
  const gatesAtPin = manifest.hostGates?.[pinned];
  if (!gatesAtPin) {
    process.stderr.write(
      `No host gates recorded for pinned release ${pinned}; run with --record ${pinned} --ref <git ref>\n`,
    );
    return 1;
  }
  const current = collectHostGated();
  const status = report(`Pinned release ${pinned}`, entry, gatesExistingAt(current, gatesAtPin));
  if (status === 0) {
    process.stdout.write(
      `Pinned release ${pinned} advertises every capability the host gated on when it was cut\n`,
    );
    const awaiting = gatesAddedAfter(current, gatesAtPin).filter(
      (gap) => !entry[gap.artifact].includes(gap.capability),
    );
    if (awaiting.length > 0) {
      const lines = awaiting.map((gap) => `  - ${gap.artifact}: ${gap.capability}`);
      process.stdout.write(
        `Gated after ${pinned}; the host fails closed until the next release advertises them (--candidate enforces it):\n${lines.join("\n")}\n`,
      );
    }
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
