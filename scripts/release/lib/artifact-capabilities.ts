/**
 * Pure helpers for the release-time capability guard (issue #12996).
 *
 * A pinned release artifact (CtrlProxy APK, iOS runner, prototype-agent dylib)
 * advertises capability names at runtime; host code in `src/` refuses features
 * (fails closed) when the name is absent. If the pinned artifacts predate a
 * host gate, every default install hits that refusal. This module compares the
 * two sets from checked-in data only: no artifact is downloaded.
 */

import ts from "typescript";

export const ARTIFACTS = ["android-ctrlproxy-apk", "ios-runner", "prototype-agent-dylib"] as const;
export type ArtifactId = (typeof ARTIFACTS)[number];

/** Capability names recorded per artifact for one release version. */
export type ArtifactCapabilities = Record<ArtifactId, string[]>;

export interface CapabilityManifest {
  description: string;
  releases: Record<string, ArtifactCapabilities>;
  /**
   * Capability names the host (`src/`) gated on at each release's git ref, recorded beside what the
   * artifacts advertise. The pinned-release check only holds a release to gates that already
   * existed when it was cut (#12996).
   */
  hostGates?: Record<string, ArtifactCapabilities>;
}

/**
 * Source files (relative to the repo root) that advertise each artifact's capabilities. An
 * artifact's parser reads their concatenation, so a capability advertised from a second file is
 * not missed (#15347).
 */
export const ADVERTISING_SOURCES: Record<ArtifactId, string[]> = {
  "android-ctrlproxy-apk": [
    "android/control-proxy/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/WebSocketServer.kt",
    // The `global_action_<name>_v1` flags are generated here from the action table, then added by
    // WebSocketServer through `addAll(SystemGlobalActions.advertisedFlags(sdk))`.
    "android/control-proxy/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/SystemGlobalActions.kt",
  ],
  "ios-runner": ["ios/control-proxy/Sources/CtrlProxy/Models/RunnerFeature.swift"],
  "prototype-agent-dylib": [
    "ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeAgentProtocol.swift",
    // Standalone mode appends `prototype_persistence_replay_v1` to the handshake list.
    "ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeStandalone.swift",
  ],
};

/**
 * Capabilities the host gates on but an artifact deliberately does not implement, with the reason.
 * The host gate stays: it fails closed (preflight refuses the spec feature against an agent that
 * does not advertise the name), which is the right degradation. A gate is exempt only while the
 * artifact really lacks the feature; once the artifact advertises it, the stale entry fails the
 * check (see {@link findStaleExemptions}) so it cannot hide a later regression.
 */
export const UNIMPLEMENTED_BY_ARTIFACT: Record<ArtifactId, Record<string, string>> = {
  "android-ctrlproxy-apk": {},
  "ios-runner": {},
  "prototype-agent-dylib": {
    prototype_chat_scroll_v1:
      "iOS agent only derives the bundle requirement; it does not implement chat scroll options or scrollTo",
    prototype_choreography_v1:
      "iOS agent keeps the transition type only; the host refuses delays, stagger and blurReplace (#15247)",
    prototype_custom_shaders_v1:
      "AGSL shaders are Android-only by owner decision; the iOS agent and ProtoViewer refuse them (#15131)",
    prototype_effects_v1:
      "style.effects has a validated contract only; no renderer yet, so the host refuses it (#15128)",
    prototype_motion_v3: "Expressive, press and layout animate are Android only until #14684",
    prototype_window_motion_v1: "Android window and repeat motion; iOS does not implement it",
    prototype_motion_v2:
      "iOS agent does not advertise it; the host refuses motion v2 features against it",
    prototype_platform_namespace_v1:
      "No renderer implements a platform-namespace field yet, so the host refuses own-platform blocks (#15257)",
    prototype_platform_v1:
      "iOS agent validates platform specs but has no module registry yet (#14296)",
  },
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
  // The platform-neutral spec gates (prototypeCapabilityGates.ts) and storage gate apply to
  // iOS agents too, so they count beyond the ios/ transport (#13318).
  "prototype-agent-dylib": [
    "src/features/prototype/ios/",
    "src/features/prototype/prototypeCapabilityGates.ts",
    "src/features/prototype/prototypeStorage.ts",
    "src/features/prototype/prototypeStorageWire.ts",
  ],
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
  return uniqueSorted([
    ...matchAll(kotlinSource, new RegExp(`\\badd\\("(${CAPABILITY_NAME})"\\)`, "g")),
    // SystemGlobalActions: `flagFor("lock_screen")` expands to `global_action_lock_screen_v1`.
    ...matchAll(kotlinSource, /\bflagFor\("([a-z][a-z0-9_]*)"\)/g).map(
      (name) => `global_action_${name}_v1`,
    ),
  ]);
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

const VERSIONED_CAPABILITY = new RegExp(`^${CAPABILITY_NAME}_v\\d+$`);

export interface HostGateScan {
  /** `const NAME = "x_v1"` declarations: identifier -> capability name. */
  declared: Record<string, string>;
  /** Versioned literals used outside a plain constant declaration (call args, arrays, ...). */
  literals: string[];
  /** Identifiers referenced outside their own declaration and import/export lists. */
  references: string[];
}

function isVersionedLiteral(
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    VERSIONED_CAPABILITY.test(node.text)
  );
}

/**
 * Parses a host source with the TypeScript AST (comments never count). A versioned
 * literal that initialises a constant is a declaration; it only becomes a gate for an
 * artifact once something in that artifact's sources references the constant (#13318).
 */
export function scanHostGates(tsSource: string): HostGateScan {
  const file = ts.createSourceFile("host.ts", tsSource, ts.ScriptTarget.Latest, true);
  const declared: Record<string, string> = {};
  const literals = new Set<string>();
  const references = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isVersionedLiteral(node.initializer)
    ) {
      declared[node.name.text] = node.initializer.text;
      return;
    }
    if (isVersionedLiteral(node)) {
      literals.add(node.text);
    } else if (ts.isIdentifier(node)) {
      references.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return {
    declared,
    literals: uniqueSorted(literals),
    references: uniqueSorted(references),
  };
}

/**
 * Capability names one artifact's host sources gate on: literals used directly, plus
 * declared constants (from any scanned source) that those sources reference.
 */
export function gatedByScans(scans: HostGateScan[], declared: Record<string, string>): string[] {
  return uniqueSorted(
    scans.flatMap((scan) => [
      ...scan.literals,
      ...scan.references.flatMap((name) => (Object.hasOwn(declared, name) ? [declared[name]] : [])),
    ]),
  );
}

/**
 * Gated names per artifact from the contents of that artifact's host sources. A constant declared
 * in one source counts as a gate for every artifact whose sources reference it.
 */
export function gatedBySources(
  sourcesByArtifact: Record<ArtifactId, string[]>,
): Record<ArtifactId, string[]> {
  const declared: Record<string, string> = {};
  const scansByArtifact = Object.fromEntries(
    ARTIFACTS.map((artifact) => [
      artifact,
      sourcesByArtifact[artifact].map((source) => {
        const scan = scanHostGates(source);
        Object.assign(declared, scan.declared);
        return scan;
      }),
    ]),
  ) as Record<ArtifactId, HostGateScan[]>;
  return Object.fromEntries(
    ARTIFACTS.map((artifact) => [artifact, gatedByScans(scansByArtifact[artifact], declared)]),
  ) as Record<ArtifactId, string[]>;
}

/**
 * Narrows the current host gates to those that already existed at a release's ref. A capability
 * gated only after the release was cut is expected to be missing from that release's artifacts
 * until the next release: the host gate fails closed, and the release-candidate check (which
 * compares every gate with what the sources will advertise) enforces it before the next release.
 */
export function gatesExistingAt(
  current: Record<ArtifactId, string[]>,
  atRelease: ArtifactCapabilities,
): Record<ArtifactId, string[]> {
  return Object.fromEntries(
    ARTIFACTS.map((artifact) => {
      const existing = new Set(atRelease[artifact]);
      return [artifact, current[artifact].filter((capability) => existing.has(capability))];
    }),
  ) as Record<ArtifactId, string[]>;
}

/** Current gates the release's ref did not have: they wait for the next release. */
export function gatesAddedAfter(
  current: Record<ArtifactId, string[]>,
  atRelease: ArtifactCapabilities,
): CapabilityGap[] {
  return ARTIFACTS.flatMap((artifact) => {
    const existing = new Set(atRelease[artifact]);
    return uniqueSorted(current[artifact])
      .filter((capability) => !existing.has(capability))
      .map((capability) => ({ artifact, capability }));
  });
}

export interface CapabilityGap {
  artifact: ArtifactId;
  capability: string;
}

/** Gated names the artifact does not advertise, per artifact, sorted. */
export function findGaps(
  advertised: ArtifactCapabilities,
  gated: Record<ArtifactId, string[]>,
  exempt: Record<ArtifactId, Record<string, string>> = {
    "android-ctrlproxy-apk": {},
    "ios-runner": {},
    "prototype-agent-dylib": {},
  },
): CapabilityGap[] {
  return ARTIFACTS.flatMap((artifact) => {
    const have = new Set(advertised[artifact]);
    return uniqueSorted(gated[artifact])
      .filter((capability) => !have.has(capability) && !Object.hasOwn(exempt[artifact], capability))
      .map((capability) => ({ artifact, capability }));
  });
}

/** Exempt names the artifact now advertises: the exemption is stale and must be removed. */
export function findStaleExemptions(
  advertised: ArtifactCapabilities,
  exempt: Record<ArtifactId, Record<string, string>>,
): CapabilityGap[] {
  return ARTIFACTS.flatMap((artifact) => {
    const have = new Set(advertised[artifact]);
    return Object.keys(exempt[artifact])
      .filter((capability) => have.has(capability))
      .sort()
      .map((capability) => ({ artifact, capability }));
  });
}

/** `label` names what was checked, e.g. "Pinned release 0.0.88" or "Release candidate". */
export function formatGaps(label: string, gaps: CapabilityGap[]): string {
  const lines = gaps.map((gap) => `  - ${gap.artifact}: ${gap.capability}`);
  return [
    `${label} does not advertise ${gaps.length} capability name(s) the host gates on:`,
    ...lines,
    "Make the artifacts advertise these capabilities, list them in UNIMPLEMENTED_BY_ARTIFACT if an",
    "artifact deliberately lacks them, or drop the host gate,",
    "then record the new release with: bun scripts/release/check-artifact-capabilities.ts --record <version> --ref <git ref>",
  ].join("\n");
}

/**
 * Records `version` first, with the host gates that existed at its ref; re-recording an existing
 * version replaces its entries.
 */
export function recordRelease(
  manifest: CapabilityManifest,
  version: string,
  advertised: ArtifactCapabilities,
  hostGated: ArtifactCapabilities,
): CapabilityManifest {
  const others = Object.entries(manifest.releases).filter(([existing]) => existing !== version);
  const otherGates = Object.entries(manifest.hostGates ?? {}).filter(
    ([existing]) => existing !== version,
  );
  return {
    ...manifest,
    releases: { [version]: advertised, ...Object.fromEntries(others) },
    hostGates: { [version]: hostGated, ...Object.fromEntries(otherGates) },
  };
}

function assertArtifactShape(kind: string, version: string, entry: ArtifactCapabilities): void {
  for (const artifact of ARTIFACTS) {
    if (!Array.isArray(entry[artifact])) {
      throw new Error(`manifest ${kind} ${version} is missing artifact ${artifact}`);
    }
  }
}

/** Throws a readable error when a manifest is not the expected shape. */
export function parseManifest(raw: string): CapabilityManifest {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("releases" in value)) {
    throw new Error("artifact-capabilities manifest must be an object with a `releases` map");
  }
  const manifest = value as CapabilityManifest;
  for (const [version, entry] of Object.entries(manifest.releases)) {
    assertArtifactShape("release", version, entry);
  }
  for (const [version, entry] of Object.entries(manifest.hostGates ?? {})) {
    assertArtifactShape("host gates for", version, entry);
  }
  return manifest;
}
