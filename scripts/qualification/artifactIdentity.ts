#!/usr/bin/env bun
/** Usage: bun scripts/qualification/artifactIdentity.ts --package-dir <installed-or-extracted-dir> [--tarball <tgz>] [--expected-integrity <sri>] [--repo <dir>] [--expect-source-sha <sha>] [--native-assets-dir <dir>] [--out <file>]. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DAEMON_PACKAGE_NAME,
  RELEASE_CHECKSUM_REGISTRY,
  VIDEO_SERVER_JAR_FILENAME,
  SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME,
  NETWORK_FILTER_ARCHIVE_FILENAME,
  type ReleaseChecksumEntry,
} from "../../src/constants/release";
import { sortedReaddirEntriesSync } from "../../src/utils/io";
import {
  REQUIRED_PACKED_RUNTIME_ASSETS,
  findMissingPackedAssets,
} from "../build/packed-runtime-assets";
import type { BuildInfo } from "../release/write-build-info";

export type CheckStatus = "pass" | "warn" | "fail";
export interface IdentityCheck {
  id: string;
  status: CheckStatus;
  detail: string;
}
export interface ArtifactIdentityRecord {
  schemaVersion: 1;
  verdict: "identified" | "refused";
  proofLevel: "local-build" | "published-package";
  package: {
    name: string | null;
    version: string | null;
    root: string;
    contentSha256: string | null;
    fileCount: number;
  };
  tarball: {
    path: string;
    integrity: string;
    shasum: string;
    expectedIntegrity: string | null;
  } | null;
  source: {
    sha: string | null;
    evidence: "build-info" | "release-tag" | "unknown";
    dirty: boolean | null;
    tag: string | null;
    expectedSha: string | null;
  };
  nativeResources: {
    from: "build-info" | "release-registry" | "none";
    entries: Record<string, { sha256: string; pinnedInBundle: boolean }>;
    localAssets: Array<{
      file: string;
      field: string;
      sha256: string;
      expected: string | null;
      match: boolean;
    }>;
  };
  managedSlotContract: {
    present: boolean;
    contractVersions: number[] | null;
    capabilities: string[] | null;
  };
  checks: IdentityCheck[];
}
export interface ArtifactIdentityOptions {
  packageDir: string;
  tarball?: string;
  expectedIntegrity?: string;
  repoDir?: string;
  expectSourceSha?: string;
  nativeAssetsDir?: string;
}
export interface ArtifactIdentityPorts {
  exists(path: string): boolean;
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
  listFiles(root: string): string[];
  git(args: readonly string[], cwd: string): { exitCode: number; stdout: string };
  registry: readonly ReleaseChecksumEntry[];
}
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseIdentityArgs(
  argv: readonly string[],
): ArtifactIdentityOptions & { out?: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        "package-dir": { type: "string" },
        tarball: { type: "string" },
        "expected-integrity": { type: "string" },
        repo: { type: "string" },
        "expect-source-sha": { type: "string" },
        "native-assets-dir": { type: "string" },
        out: { type: "string" },
      },
    }));
  } catch (error) {
    throw new UsageError(
      `Invalid artifact identity arguments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!values["package-dir"]) {
    throw new UsageError("--package-dir is required");
  }
  if (values["expected-integrity"] && !values.tarball) {
    throw new UsageError("--expected-integrity requires --tarball");
  }
  if (values["expect-source-sha"] && !/^[a-f\d]{7,40}$/i.test(values["expect-source-sha"])) {
    throw new UsageError("--expect-source-sha must be a 7–40 character hex SHA or prefix");
  }
  return {
    packageDir: values["package-dir"],
    tarball: values.tarball,
    expectedIntegrity: values["expected-integrity"],
    repoDir: values.repo,
    expectSourceSha: values["expect-source-sha"],
    nativeAssetsDir: values["native-assets-dir"],
    out: values.out,
  };
}

function check(
  record: ArtifactIdentityRecord,
  id: string,
  status: CheckStatus,
  detail: string,
): void {
  record.checks.push({ id, status, detail });
}

function identifySource(
  record: ArtifactIdentityRecord,
  info: BuildInfo | null,
  options: ArtifactIdentityOptions,
  ports: ArtifactIdentityPorts,
): void {
  const source = record.source;
  if (info?.sourceSha && /^[a-f\d]{40}$/i.test(info.sourceSha)) {
    source.sha = info.sourceSha.toLowerCase();
    source.evidence = "build-info";
  }
  source.dirty = info?.sourceDirty ?? null;
  let tagSha: string | null = null;
  if (options.repoDir && record.package.version) {
    for (const tag of [record.package.version, `v${record.package.version}`]) {
      const result = ports.git(
        ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`],
        options.repoDir,
      );
      if (result.exitCode === 0 && /^[a-f\d]{40}$/i.test(result.stdout.trim())) {
        source.tag = tag;
        tagSha = result.stdout.trim().toLowerCase();
        break;
      }
    }
  }
  const disagreement = source.sha !== null && tagSha !== null && source.sha !== tagSha;
  if (!source.sha && tagSha) {
    source.sha = tagSha;
    source.evidence = "release-tag";
  }
  const expected = options.expectSourceSha?.toLowerCase();
  const mismatch =
    expected !== undefined &&
    (!/^[a-f\d]{7,40}$/i.test(expected) || !source.sha?.startsWith(expected));
  let detail = source.sha
    ? `package ${record.package.version} was built from ${source.sha}`
    : "source SHA unknown";
  if (expected) {
    detail += ` but qualification expects ${options.expectSourceSha}`;
  }
  if (disagreement) {
    detail += `; build-info SHA ${source.sha} differs from release tag ${source.tag} SHA ${tagSha}`;
  }
  check(
    record,
    "source_sha",
    disagreement || mismatch ? "fail" : source.sha ? "pass" : "warn",
    detail,
  );
}

function identifyNative(
  record: ArtifactIdentityRecord,
  info: BuildInfo | null,
  options: ArtifactIdentityOptions,
  ports: ArtifactIdentityPorts,
): void {
  const registry = ports.registry.find((entry) => entry.version === record.package.version);
  const resources = info?.nativeResources ?? registry;
  record.nativeResources.from = info?.nativeResources
    ? "build-info"
    : registry
      ? "release-registry"
      : "none";
  const bundlePath = join(record.package.root, "dist/src/index.js");
  const bundle = ports.exists(bundlePath) ? ports.readText(bundlePath) : "";
  for (const [field, sha] of Object.entries(resources ?? {})) {
    if (field.endsWith("Sha256") && typeof sha === "string" && sha.length > 0) {
      record.nativeResources.entries[field] = {
        sha256: sha,
        pinnedInBundle: /^[a-f\d]{64}$/i.test(sha) && bundle.includes(sha),
      };
    }
  }
  const missing = Object.entries(record.nativeResources.entries)
    .filter(([, entry]) => !entry.pinnedInBundle)
    .map(([field]) => field);
  const count = Object.keys(record.nativeResources.entries).length;
  check(
    record,
    "native_resources",
    missing.length ? "fail" : count ? "pass" : "warn",
    missing.length
      ? `Native SHA-256s not pinned in bundle: ${missing.join(", ")}`
      : count
        ? `${count} native SHA-256s pinned in bundle; runner SHA lives inside the IPA and is recorded, not independently verified`
        : "No native-resource checksums available",
  );
  if (!options.nativeAssetsDir) {
    return;
  }
  const files: Record<string, string> = {
    "control-proxy-debug.apk": "apkSha256",
    "control-proxy.ipa": "ipaSha256",
    [VIDEO_SERVER_JAR_FILENAME]: "videoJarSha256",
    [SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME]: "screenCaptureHelperSha256",
    [NETWORK_FILTER_ARCHIVE_FILENAME]: "networkFilterSha256",
  };
  for (const [file, field] of Object.entries(files)) {
    const path = join(options.nativeAssetsDir, file);
    if (!ports.exists(path)) {
      continue;
    }
    const sha256 = createHash("sha256").update(ports.readBytes(path)).digest("hex");
    const expected = record.nativeResources.entries[field]?.sha256 ?? null;
    record.nativeResources.localAssets.push({
      file,
      field,
      sha256,
      expected,
      match: expected !== null && sha256 === expected.toLowerCase(),
    });
  }
  const mismatches = record.nativeResources.localAssets
    .filter((asset) => !asset.match)
    .map((asset) => asset.file);
  check(
    record,
    "native_assets",
    mismatches.length ? "fail" : record.nativeResources.localAssets.length ? "pass" : "warn",
    `${mismatches.length ? `Native assets mismatch or lack expected checksum: ${mismatches.join(", ")}` : record.nativeResources.localAssets.length ? "Present native assets match" : "Directory contains none of the recognized native assets"}; runner SHA lives inside the IPA and is not independently verified`,
  );
}

function identifyTarball(
  record: ArtifactIdentityRecord,
  options: ArtifactIdentityOptions,
  ports: ArtifactIdentityPorts,
): void {
  if (!options.tarball) {
    return;
  }
  const bytes = ports.readBytes(options.tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  record.tarball = {
    path: options.tarball,
    integrity,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    expectedIntegrity: options.expectedIntegrity ?? null,
  };
  const status = options.expectedIntegrity
    ? options.expectedIntegrity === integrity
      ? "pass"
      : "fail"
    : "warn";
  check(
    record,
    "tarball_integrity",
    status,
    options.expectedIntegrity
      ? `Computed ${integrity}; expected ${options.expectedIntegrity}`
      : `compare with npm view ${DAEMON_PACKAGE_NAME}@${record.package.version} dist.integrity`,
  );
  if (status === "pass") {
    record.proofLevel = "published-package";
  }
}

export function identifyArtifact(
  options: ArtifactIdentityOptions,
  ports: ArtifactIdentityPorts,
): ArtifactIdentityRecord {
  const root = resolve(options.packageDir);
  const record: ArtifactIdentityRecord = {
    schemaVersion: 1,
    verdict: "identified",
    proofLevel: "local-build",
    package: { name: null, version: null, root, contentSha256: null, fileCount: 0 },
    tarball: null,
    source: {
      sha: null,
      evidence: "unknown",
      dirty: null,
      tag: null,
      expectedSha: options.expectSourceSha ?? null,
    },
    nativeResources: { from: "none", entries: {}, localAssets: [] },
    managedSlotContract: { present: false, contractVersions: null, capabilities: null },
    checks: [],
  };
  const packagePath = join(root, "package.json");
  if (ports.exists(packagePath)) {
    const pkg = JSON.parse(ports.readText(packagePath)) as { name?: string; version?: string };
    record.package.name = pkg.name ?? null;
    record.package.version = pkg.version ?? null;
  }
  check(
    record,
    "package_root",
    record.package.name === DAEMON_PACKAGE_NAME ? "pass" : "fail",
    `Expected ${DAEMON_PACKAGE_NAME}; found ${record.package.name ?? "no package.json"}`,
  );
  const source = ports.exists(join(root, ".git")) || ports.exists(join(root, "src/index.ts"));
  const built = ports.exists(join(root, "dist/src/index.js"));
  check(
    record,
    "not_source_checkout",
    source ? "fail" : "pass",
    source
      ? `${built ? "source checkout" : "unbuilt source checkout"}; run bun run build && npm pack, then install or extract the tarball and pass that directory (plus --tarball)`
      : "Installed or extracted package directory",
  );
  const files = ports.listFiles(root).slice().sort();
  const missing = findMissingPackedAssets(files, REQUIRED_PACKED_RUNTIME_ASSETS);
  check(
    record,
    "packed_assets",
    missing.length ? "fail" : "pass",
    missing.length
      ? `Missing packed runtime assets: ${missing.join(", ")}`
      : "Required packed runtime assets present",
  );
  const manifest = files
    .map(
      (file) =>
        `${createHash("sha256")
          .update(ports.readBytes(join(root, file)))
          .digest("hex")}  ${file}\n`,
    )
    .join("");
  record.package.contentSha256 = createHash("sha256").update(manifest, "utf8").digest("hex");
  record.package.fileCount = files.length;
  check(
    record,
    "content_hash",
    "pass",
    `${files.length} files; SHA-256 ${record.package.contentSha256}`,
  );
  identifyTarball(record, options, ports);
  const infoPath = join(root, "dist/build-info.json");
  const info = ports.exists(infoPath) ? (JSON.parse(ports.readText(infoPath)) as BuildInfo) : null;
  const badInfo =
    info !== null &&
    (info.name !== record.package.name ||
      info.version !== record.package.version ||
      info.schemaVersion !== 1 ||
      (info.sourceSha !== null && !/^[a-f\d]{40}$/i.test(info.sourceSha)));
  check(
    record,
    "build_info",
    badInfo ? "fail" : !info || info.sourceDirty === true ? "warn" : "pass",
    badInfo
      ? "Invalid build-info or name/version differs from package.json"
      : !info
        ? "package predates build-info; source SHA falls back to the release tag"
        : info.sourceDirty
          ? "Build has tracked-file changes"
          : "Build info matches package",
  );
  identifySource(record, info, options, ports);
  identifyNative(record, info, options, ports);
  const contractPath = join(root, "schemas/managed-slot-contract.json");
  if (ports.exists(contractPath)) {
    const contract = JSON.parse(ports.readText(contractPath)) as {
      contractVersions: number[];
      daemonCapabilities: { base: string; additive: Array<{ capability: string }> };
    };
    record.managedSlotContract = {
      present: true,
      contractVersions: contract.contractVersions,
      capabilities: [
        contract.daemonCapabilities.base,
        ...contract.daemonCapabilities.additive.map((entry) => entry.capability),
      ],
    };
  }
  check(
    record,
    "managed_slot_contract",
    record.managedSlotContract.present ? "pass" : "warn",
    record.managedSlotContract.present
      ? "Published managed-slot contract present"
      : "package predates the published managed-slot contract",
  );
  record.verdict = record.checks.some((entry) => entry.status === "fail")
    ? "refused"
    : "identified";
  return record;
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of sortedReaddirEntriesSync(dir)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(join(dir, entry.name), path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(root, "");
  return files.sort();
}

if (import.meta.main) {
  try {
    const options = parseIdentityArgs(process.argv.slice(2));
    const record = identifyArtifact(options, {
      exists: existsSync,
      readText: (path) => readFileSync(path, "utf8"),
      readBytes: (path) => readFileSync(path),
      listFiles,
      git: (args, cwd) => {
        try {
          const result = Bun.spawnSync(["git", ...args], { cwd });
          return { exitCode: result.exitCode, stdout: result.stdout.toString() };
        } catch (error) {
          console.warn("Artifact identity git probe unavailable:", error);
          return { exitCode: 1, stdout: "" };
        }
      },
      registry: RELEASE_CHECKSUM_REGISTRY,
    });
    const json = `${JSON.stringify(record, null, 2)}\n`;
    if (options.out) {
      writeFileSync(options.out, json);
    } else {
      process.stdout.write(json);
    }
    for (const entry of record.checks) {
      console.error(`${entry.status} ${entry.id}: ${entry.detail}`);
    }
    process.exitCode = record.verdict === "identified" ? 0 : 1;
  } catch (error) {
    console.error("Artifact identity failed:", error);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
