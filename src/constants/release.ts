/**
 * Release constants - DO NOT EDIT MANUALLY
 *
 * This file contains release-specific constants that are updated automatically.
 * The values below are defaults for local development.
 *
 * The checksum registry is an ordered array of validated release checksums,
 * newest first (max 100 entries). "latest" resolves to registry[0].
 * Pinned versions (e.g. "0.0.18") do an exact lookup by version.
 *
 * During CI/CD release builds, new entries are prepended to the registry via
 * scripts/generate-release-constants.sh
 */

export const LATEST_RELEASE_VERSION = "latest";

export interface ReleaseChecksumEntry {
  version: string;
  apkSha256: string;
  ipaSha256: string;
}

/**
 * Ordered checksum registry, newest first. Max 100 entries.
 * Each entry represents a validated release build.
 */
export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry[] = [
  {
    version: "0.0.30",
    apkSha256: "a1be5e6240f204ee99540e99cc198f7c0b592dbaf3699330c14f6ded7d333ec3",
    ipaSha256: "5ac285dd5be16439d3a8a8973c98606920461acfce489830e54ee20759a7b235",
  },
  {
    version: "0.0.29",
    apkSha256: "b33a67c7efa84aca2b07faa965aecb3b1819b4defd441dcc8d3bf7e2af209cd8",
    ipaSha256: "d47c1aea4495270c1489cae361286ea1439c2ba4e7d5bcfd73f66e4580a6c45d",
  },
  {
    version: "0.0.28",
    apkSha256: "0f683d5939bc308afe038ea1259eb29997dff38af0795136a281ad305986e40e",
    ipaSha256: "eee7accfbca717bb8b89fafd0676f10d8bb08561c3fbd7a04750c9b12c2a7104",
  },
  {
    version: "0.0.27",
    apkSha256: "9966113ae44f38f3cf34544b1375d3c9a3706701edba45a1eec1f220b9c676cc",
    ipaSha256: "8620de6b014df18465876334f9ba8c106292f6c3059370eea2349f1e44db4f4d",
  },
  {
    version: "0.0.26",
    apkSha256: "2eb2f156fd27602c85003ab8f6e00d3e06850e84f5453d75b7494aa5bbed7be0",
    ipaSha256: "905df276d2224d31cbc5aa2258d2dcc60eaeb9813727081ddd32c95394fec411",
  },
  {
    version: "0.0.25",
    apkSha256: "f727079edb4906e3b7928dbb641e788543e86b11fff3fc1b76f0c51b9c8d6e5d",
    ipaSha256: "d8032cc1cebcb456b7232aa67fc42c89ff62729bacf141aa8f594ce6f8bcd980",
  },
  {
    version: "0.0.24",
    apkSha256: "9047795bc6098f4ec687c126123c73c423806a9fd52888af391d6fb5b94ac93f",
    ipaSha256: "1dd3e0370cb8ed01d8e1020558d8a2808f208bd947bafcf6688211eddc928bf8",
  },
  {
    version: "0.0.18",
    apkSha256: "fd3c8d9f0b8542eaad56c78b18cf8e5666367b04ae8c4af74d8aa6dd1c8d1834",
    ipaSha256: "2a5eec63bce2f9dfc227c0732fcce67378305e945604d5eedd0e3df48e37fd39",
  },
  {
    version: "0.0.17",
    apkSha256: "916033440931666644474f227c8e39d13d9c80c3515e4292cc5581fd5bd4cc2f",
    ipaSha256: "e4dcf064d024f2371b8fd79281000e2d49751ef95b8817d1494d685aeda746ac",
  },
];

/**
 * Resolve a checksum from the registry.
 * - "latest" → registry[0] (most recent validated build)
 * - pinned version (e.g. "0.0.18") → exact match lookup
 * - unknown version or empty registry → ""
 */
export function resolveChecksum(
  version: string,
  platform: "android" | "ios",
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY
): string {
  if (registry.length === 0) {
    return "";
  }
  const normalized = version.trim().toLowerCase();
  const entry = normalized === LATEST_RELEASE_VERSION
    ? registry[0]
    : registry.find(e => e.version === version);
  if (!entry) {
    return "";
  }
  return platform === "android" ? entry.apkSha256 : entry.ipaSha256;
}

/**
 * Version of the latest validated release in the registry.
 * Used to construct download URLs for pinned releases.
 */
export function resolveLatestVersion(): string {
  if (RELEASE_CHECKSUM_REGISTRY.length === 0) {
    return LATEST_RELEASE_VERSION;
  }
  return RELEASE_CHECKSUM_REGISTRY[0].version;
}

/**
 * Resolve the effective CtrlProxy release version, honoring an optional
 * env-var override.
 *
 * Without the env var set, the daemon uses the newest validated version from
 * RELEASE_CHECKSUM_REGISTRY (equivalent to "latest"). Setting the env var
 * pins both the on-device APK download URL and the expected checksum to a
 * specific historical release — useful when:
 *
 *  - the latest CtrlProxy has a regression you want to dodge, or
 *  - you want CI to behave deterministically across daemon upgrades.
 *
 * Unknown versions throw at module load rather than silently falling back
 * to latest; CI configs should be explicit, and a typo should fail fast
 * rather than quietly downgrade.
 *
 * Exported for testing — pass the env value and registry explicitly.
 */
export function resolveConfiguredVersion(
  envValue: string | undefined,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY
): string {
  const trimmed = envValue?.trim();
  if (!trimmed || trimmed.length === 0) {
    return LATEST_RELEASE_VERSION;
  }
  if (trimmed.toLowerCase() === LATEST_RELEASE_VERSION) {
    return LATEST_RELEASE_VERSION;
  }
  const hit = registry.find(e => e.version === trimmed);
  if (!hit) {
    const known = registry.map(e => e.version).join(", ") || "<empty registry>";
    throw new Error(
      `AUTOMOBILE_CTRL_PROXY_VERSION=${trimmed} not found in release registry. ` +
      `Known versions: ${known}.`
    );
  }
  return trimmed;
}

// --- Backward-compatible exports derived from RELEASE_VERSION ---

export const RELEASE_VERSION: string = resolveConfiguredVersion(
  process.env.AUTOMOBILE_CTRL_PROXY_VERSION
);

/**
 * Resolve the version string that should appear in download URLs.
 * "latest" expands to registry[0].version so URLs are always concrete.
 */
function resolveAssetVersion(version: string): string {
  if (version === LATEST_RELEASE_VERSION) {
    return resolveLatestVersion();
  }
  return version;
}

function buildReleaseAssetUrl(filename: string, version: string): string {
  const assetVersion = resolveAssetVersion(version);
  if (assetVersion === LATEST_RELEASE_VERSION) {
    // Degenerate case: registry is empty AND nothing pinned. Fall back to
    // GitHub's redirecting /latest/download/ endpoint.
    return `https://github.com/kaeawc/auto-mobile/releases/latest/download/${filename}`;
  }
  return `https://github.com/kaeawc/auto-mobile/releases/download/${assetVersion}/${filename}`;
}

export const APK_URL: string = buildReleaseAssetUrl("control-proxy-debug.apk", RELEASE_VERSION);
export const APK_SHA256_CHECKSUM: string = resolveChecksum(RELEASE_VERSION, "android");

export const IOS_CTRL_PROXY_RELEASE_VERSION: string = RELEASE_VERSION;
export const IOS_CTRL_PROXY_IPA_URL: string = buildReleaseAssetUrl("control-proxy.ipa", IOS_CTRL_PROXY_RELEASE_VERSION);
export const IOS_CTRL_PROXY_SHA256_CHECKSUM: string = resolveChecksum(IOS_CTRL_PROXY_RELEASE_VERSION, "ios");
export const IOS_CTRL_PROXY_APP_HASH: string = ""; // Hash of CtrlProxyApp.app (device build), empty = skip verification
export const IOS_CTRL_PROXY_RUNNER_SHA256: string = ""; // SHA256 of runner binary (CtrlProxyUITests-Runner), empty = skip verification
