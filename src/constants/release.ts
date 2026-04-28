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
    version: "0.0.18",
    apkSha256: "8ecd4e6a33d6158188535d9020d7145bc7038de3c1ff551a0474f08de401c7b1",
    ipaSha256: "e27ef949c6d68ffe19097a0db84284598b9ad0f3b04e887c68a9a04cf9425825",
  },
];

/**
 * Resolve a checksum from the registry.
 * - "latest" → registry[0] (most recent validated build)
 * - pinned version (e.g. "0.0.18") → exact match lookup
 * - unknown version or empty registry → ""
 */
export function resolveChecksum(version: string, platform: "android" | "ios"): string {
  if (RELEASE_CHECKSUM_REGISTRY.length === 0) {
    return "";
  }
  const normalized = version.trim().toLowerCase();
  const entry = normalized === LATEST_RELEASE_VERSION
    ? RELEASE_CHECKSUM_REGISTRY[0]
    : RELEASE_CHECKSUM_REGISTRY.find(e => e.version === version);
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

// --- Backward-compatible exports derived from registry[0] ---

export const RELEASE_VERSION: string = LATEST_RELEASE_VERSION;
export const APK_URL: string = `https://github.com/kaeawc/auto-mobile/releases/latest/download/control-proxy-debug.apk`;
export const APK_SHA256_CHECKSUM: string = resolveChecksum(LATEST_RELEASE_VERSION, "android");

export const IOS_CTRL_PROXY_RELEASE_VERSION: string = LATEST_RELEASE_VERSION;
export const IOS_CTRL_PROXY_IPA_URL: string = "https://github.com/kaeawc/auto-mobile/releases/latest/download/control-proxy.ipa";
export const IOS_CTRL_PROXY_SHA256_CHECKSUM: string = resolveChecksum(LATEST_RELEASE_VERSION, "ios");
export const IOS_CTRL_PROXY_APP_HASH: string = ""; // Hash of CtrlProxyApp.app (device build), empty = skip verification
export const IOS_CTRL_PROXY_RUNNER_SHA256: string = ""; // SHA256 of runner binary (CtrlProxyUITests-Runner), empty = skip verification
