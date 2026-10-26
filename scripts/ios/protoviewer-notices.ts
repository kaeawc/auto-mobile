/**
 * Generates the ProtoViewer iOS third-party notices (#14158).
 *
 * The dependency graph comes from SwiftPM itself (`swift package show-dependencies --format json`)
 * rather than from parsing Package.swift, so transitive packages and the resolved versions are
 * covered. Each linked package needs its license text in
 * `ios/prototype-agent/ProtoViewer/third-party-licenses/<identity>.txt`; a missing or orphaned
 * text fails the run. Output is a Swift source the viewer build already compiles, so the notices
 * ship inside the executable with no resource bundling step.
 *
 *   bun scripts/ios/protoviewer-notices.ts          # regenerate
 *   bun scripts/ios/protoviewer-notices.ts --check  # fail when the committed output is stale
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PackageNode {
  identity: string;
  name: string;
  url: string;
  version: string;
  dependencies: PackageNode[];
}

export interface Notice {
  id: string;
  name: string;
  detail: string;
  license: string;
}

export const noticesPaths = {
  package: "ios/prototype-agent",
  licensesDir: "ios/prototype-agent/ProtoViewer/third-party-licenses",
  output: "ios/prototype-agent/ProtoViewer/Acknowledgements.generated.swift",
  rootLicense: "LICENSE",
} as const;

const FIRST_PARTY_ID = "first-party:auto-mobile";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates `swift package show-dependencies --format json` output into a typed tree. */
export function parsePackageTree(value: unknown, where = "root"): PackageNode {
  if (!isRecord(value)) {
    throw new Error(`${where}: expected an object`);
  }
  const { identity, name, url, version, dependencies } = value;
  if (
    typeof identity !== "string" ||
    typeof name !== "string" ||
    typeof url !== "string" ||
    typeof version !== "string" ||
    !Array.isArray(dependencies)
  ) {
    throw new Error(`${where}: expected identity, name, url, version and dependencies`);
  }
  return {
    identity,
    name,
    url,
    version,
    dependencies: dependencies.map((child, index) =>
      parsePackageTree(child, `${where}.dependencies[${index}]`),
    ),
  };
}

/** SwiftPM reports a local path package with an absolute filesystem path as its url. */
function isLocalPath(url: string): boolean {
  return url.startsWith("/") || url.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(url);
}

/**
 * Every linked third-party package, once, sorted by identity. Local path packages are first
 * party, covered by the repository LICENSE. Branch and revision pins report version "unspecified"
 * but keep a remote url, so they stay listed (an SSH-style url must not look local).
 */
export function collectDependencies(root: PackageNode): PackageNode[] {
  const found = new Map<string, PackageNode>();
  const visit = (node: PackageNode) => {
    for (const child of node.dependencies) {
      if (!isLocalPath(child.url) && !found.has(child.identity)) {
        found.set(child.identity, child);
      }
      visit(child);
    }
  };
  visit(root);
  return [...found.values()].sort((a, b) => a.identity.localeCompare(b.identity));
}

export function licenseFileName(identity: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(identity)) {
    throw new Error(`Package identity "${identity}" is not a safe license file name`);
  }
  return `${identity}.txt`;
}

export function buildNotices(input: {
  root: PackageNode;
  firstPartyLicense: string;
  /** License texts keyed by file name, e.g. `swift-collections.txt`. */
  licenseTexts: Readonly<Record<string, string>>;
}): Notice[] {
  const dependencies = collectDependencies(input.root);
  const expected = new Set(dependencies.map((dep) => licenseFileName(dep.identity)));
  const missing = dependencies
    .map((dep) => licenseFileName(dep.identity))
    .filter((file) => !input.licenseTexts[file]?.trim());
  const orphaned = Object.keys(input.licenseTexts).filter((file) => !expected.has(file));
  if (missing.length || orphaned.length) {
    throw new Error(
      [
        missing.length
          ? `Missing license text in ${noticesPaths.licensesDir}: ${missing.join(", ")}`
          : "",
        orphaned.length
          ? `License text for packages ProtoViewer no longer links: ${orphaned.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return [
    {
      id: FIRST_PARTY_ID,
      name: "AutoMobile ProtoViewer",
      detail: "Apache License 2.0",
      license: normalizeLicenseText(input.firstPartyLicense, FIRST_PARTY_ID),
    },
    ...dependencies.map((dep) => ({
      id: dep.identity,
      name: dep.name,
      detail: dep.version === "unspecified" ? dep.url : `${dep.version} · ${dep.url}`,
      license: normalizeLicenseText(
        input.licenseTexts[licenseFileName(dep.identity)] ?? "",
        dep.identity,
      ),
    })),
  ];
}

/** LF line endings, no trailing whitespace; other control characters cannot go into a Swift literal. */
function normalizeLicenseText(text: string, owner: string): string {
  const normalized = text.replaceAll("\r\n", "\n").trimEnd();
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(normalized)) {
    throw new Error(`License text for ${owner} contains a control character`);
  }
  return normalized;
}

function swiftString(value: string): string {
  if (/[\u0000-\u0009\u000b-\u001f]/.test(value)) {
    throw new Error(`Control character in notice metadata: ${JSON.stringify(value)}`);
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

/** A raw multi-line literal whose delimiter the text cannot terminate or interpolate through. */
function swiftRawBlock(text: string): string {
  let hashes = "#";
  while (text.includes(`"""${hashes}`) || text.includes(`\\${hashes}`)) {
    hashes += "#";
  }
  return `${hashes}"""\n${text}\n"""${hashes}`;
}

const DIGEST_PREFIX = "// Input digest: ";

export function renderNotices(notices: readonly Notice[], digest: string): string {
  return [
    "// Generated by scripts/ios/protoviewer-notices.ts; do not edit.",
    "// Regenerate (macOS): bun scripts/ios/protoviewer-notices.ts",
    `${DIGEST_PREFIX}${digest}`,
    "// swiftformat:disable all",
    "",
    "struct ProtoViewerNotice: Identifiable, Sendable {",
    "    let id: String",
    "    let name: String",
    "    let detail: String",
    "    let license: String",
    "}",
    "",
    "let protoViewerNotices: [ProtoViewerNotice] = [",
    ...notices.map((notice) =>
      [
        "    ProtoViewerNotice(",
        `        id: ${swiftString(notice.id)},`,
        `        name: ${swiftString(notice.name)},`,
        `        detail: ${swiftString(notice.detail)},`,
        `        license: ${swiftRawBlock(notice.license)}`,
        "    ),",
      ].join("\n"),
    ),
    "]",
    "",
  ].join("\n");
}

export interface NoticeSources {
  /** Package.swift contents; changing it (or any license input) changes the recorded digest. */
  manifest: string;
  dependencyTree: unknown;
  rootLicense: string;
  licenseTexts: Record<string, string>;
}

type DigestInputs = Pick<NoticeSources, "manifest" | "rootLicense" | "licenseTexts">;

/**
 * Hash of every input except the SwiftPM resolution. Hosts without the macOS toolchain cannot
 * rebuild the dependency graph, but can still tell that the manifest or a license text changed
 * since the committed output was generated.
 */
export function inputDigest(inputs: DigestInputs): string {
  const unixEol = (text: string) => text.replaceAll("\r\n", "\n");
  const canonical = JSON.stringify([
    unixEol(inputs.manifest),
    unixEol(inputs.rootLicense),
    Object.entries(inputs.licenseTexts)
      .map(([file, text]) => [file, unixEol(text)])
      .sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function recordedDigest(output: string): string | undefined {
  const line = output.split("\n").find((candidate) => candidate.startsWith(DIGEST_PREFIX));
  return line?.slice(DIGEST_PREFIX.length).trim();
}

export function renderFromSources(sources: NoticeSources): string {
  return renderNotices(
    buildNotices({
      root: parsePackageTree(sources.dependencyTree),
      firstPartyLicense: sources.rootLicense,
      licenseTexts: sources.licenseTexts,
    }),
    inputDigest(sources),
  );
}

function readLicenseTexts(dir: string): Record<string, string> {
  if (!existsSync(dir)) {
    return {};
  }
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith(".txt"))
      .map((file) => [file, readFileSync(join(dir, file), "utf8")]),
  );
}

type SwiftRun = { ok: true; stdout: string } | { ok: false; detail: string };

function runSwiftShowDependencies(packagePath: string): SwiftRun {
  const result = spawnSync(
    "swift",
    ["package", "--package-path", packagePath, "show-dependencies", "--format", "json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  if (result.error) {
    return { ok: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, detail: result.stderr.trim() };
  }
  return { ok: true, stdout: result.stdout };
}

const REGENERATE = "regenerate on macOS: bun scripts/ios/protoviewer-notices.ts";

export function main(argv: readonly string[], platform: string = process.platform): number {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const check = argv.includes("--check");
  const inputs: DigestInputs = {
    manifest: readFileSync(join(repoRoot, noticesPaths.package, "Package.swift"), "utf8"),
    rootLicense: readFileSync(join(repoRoot, noticesPaths.rootLicense), "utf8"),
    licenseTexts: readLicenseTexts(join(repoRoot, noticesPaths.licensesDir)),
  };
  const outputPath = join(repoRoot, noticesPaths.output);
  const actual = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : undefined;
  if (check && platform !== "darwin") {
    // Hosts without the pinned Swift toolchain compare the input digest only; macOS compares output.
    if (actual && recordedDigest(actual) === inputDigest(inputs)) {
      console.log("ProtoViewer iOS notices match their inputs (digest check).");
      return 0;
    }
    console.error(`${noticesPaths.output} is stale; ${REGENERATE}`);
    return 1;
  }
  if (platform !== "darwin") {
    console.error("Regenerating the ProtoViewer notices needs a macOS host with Swift.");
    return 1;
  }
  const swift = runSwiftShowDependencies(join(repoRoot, noticesPaths.package));
  if (!swift.ok) {
    console.error(`swift package show-dependencies failed: ${swift.detail}`);
    return 1;
  }
  try {
    const expected = renderFromSources({ ...inputs, dependencyTree: JSON.parse(swift.stdout) });
    if (!check) {
      writeFileSync(outputPath, expected);
      return 0;
    }
    if (actual === expected) {
      console.log("ProtoViewer iOS notices are current.");
      return 0;
    }
    console.error(`${noticesPaths.output} is stale; ${REGENERATE}`);
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv);
}
