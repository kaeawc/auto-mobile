/**
 * Pure helpers for the release-time capability guard (issue #12996).
 *
 * A pinned release artifact (CtrlProxy APK, iOS runner, prototype-agent dylib)
 * advertises capability names at runtime; host code in `src/` refuses features
 * (fails closed) when the name is absent. If the pinned artifacts predate a
 * host gate, every default install hits that refusal. This module compares the
 * two sets from checked-in data only: no artifact is downloaded.
 */

export const ARTIFACTS = ["android-ctrlproxy-apk", "ios-runner", "prototype-agent-dylib"] as const;
export type ArtifactId = (typeof ARTIFACTS)[number];

/** Capability names recorded per artifact for one release version. */
export type ArtifactCapabilities = Record<ArtifactId, string[]>;

export interface CapabilityManifest {
  description: string;
  releases: Record<string, ArtifactCapabilities>;
}

/** Source files (relative to the repo root) that advertise each artifact's capabilities. */
export const ADVERTISING_SOURCES: Record<ArtifactId, string> = {
  "android-ctrlproxy-apk":
    "android/control-proxy/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/WebSocketServer.kt",
  "ios-runner": "ios/control-proxy/Sources/CtrlProxy/Models/RunnerFeature.swift",
  "prototype-agent-dylib":
    "ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeAgentProtocol.swift",
};

/**
 * Host `src/` locations whose quoted capability literals gate on each artifact.
 * Entries ending in `/` are directories (scanned recursively); others are files.
 */
export const HOST_GATE_SOURCES: Record<ArtifactId, string[]> = {
  "android-ctrlproxy-apk": [
    "src/features/observe/android/",
    "src/features/observe/shared/",
    "src/features/action/",
  ],
  "ios-runner": ["src/features/observe/ios/"],
  "prototype-agent-dylib": ["src/features/prototype/ios/"],
};

const CAPABILITY_NAME = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";

function uniqueSorted(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

function matchAll(source: string, pattern: RegExp): string[] {
  return uniqueSorted([...source.matchAll(pattern)].map((match) => match[1]));
}

/** `add("name")` flags in WebSocketServer.supportedCommands(), conditional ones included. */
export function parseAndroidAdvertised(kotlinSource: string): string[] {
  return matchAll(kotlinSource, new RegExp(`\\badd\\("(${CAPABILITY_NAME})"\\)`, "g"));
}

/** Raw values of the `RunnerFeature` enum cases. */
export function parseIosRunnerAdvertised(swiftSource: string): string[] {
  return matchAll(
    swiftSource,
    new RegExp(`^\\s*case\\s+\\w+\\s*=\\s*"(${CAPABILITY_NAME})"`, "gm"),
  );
}

/** `static let fooCapability = "name"` constants of the prototype agent protocol. */
export function parsePrototypeAgentAdvertised(swiftSource: string): string[] {
  return matchAll(
    swiftSource,
    new RegExp(`static\\s+let\\s+\\w*Capability\\s*=\\s*"(${CAPABILITY_NAME})"`, "g"),
  );
}

/** Versioned capability literals (`"..._v1"`) a host source file mentions. */
export function parseHostGated(tsSource: string): string[] {
  return matchAll(tsSource, new RegExp(`"(${CAPABILITY_NAME}_v\\d+)"`, "g"));
}

export interface CapabilityGap {
  artifact: ArtifactId;
  capability: string;
}

/** Gated names the artifact does not advertise, per artifact, sorted. */
export function findGaps(
  advertised: ArtifactCapabilities,
  gated: Record<ArtifactId, string[]>,
): CapabilityGap[] {
  return ARTIFACTS.flatMap((artifact) => {
    const have = new Set(advertised[artifact]);
    return uniqueSorted(gated[artifact])
      .filter((capability) => !have.has(capability))
      .map((capability) => ({ artifact, capability }));
  });
}

export function formatGaps(version: string, gaps: CapabilityGap[]): string {
  const lines = gaps.map((gap) => `  - ${gap.artifact}: ${gap.capability}`);
  return [
    `Pinned release ${version} does not advertise ${gaps.length} capability name(s) the host gates on:`,
    ...lines,
    "Re-cut the artifacts so they advertise these capabilities (or drop the host gate),",
    "then record the new release with: bun scripts/release/check-artifact-capabilities.ts --record <version> --ref <git ref>",
  ].join("\n");
}

/** Throws a readable error when a manifest is not the expected shape. */
/** Records `version` first; re-recording an existing version replaces its entry. */
export function recordRelease(
  manifest: CapabilityManifest,
  version: string,
  advertised: ArtifactCapabilities,
): CapabilityManifest {
  const others = Object.entries(manifest.releases).filter(([existing]) => existing !== version);
  return { ...manifest, releases: { [version]: advertised, ...Object.fromEntries(others) } };
}

export function parseManifest(raw: string): CapabilityManifest {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("releases" in value)) {
    throw new Error("artifact-capabilities manifest must be an object with a `releases` map");
  }
  const manifest = value as CapabilityManifest;
  for (const [version, entry] of Object.entries(manifest.releases)) {
    for (const artifact of ARTIFACTS) {
      if (!Array.isArray(entry[artifact])) {
        throw new Error(`manifest release ${version} is missing artifact ${artifact}`);
      }
    }
  }
  return manifest;
}
