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

// --- Backward-compatible exports derived from registry[0] ---

export const RELEASE_VERSION: string = LATEST_RELEASE_VERSION;

function buildReleaseAssetUrl(filename: string): string {
  const version = resolveLatestVersion();
  if (version === LATEST_RELEASE_VERSION) {
    return `https://github.com/kaeawc/auto-mobile/releases/latest/download/${filename}`;
  }
  return `https://github.com/kaeawc/auto-mobile/releases/download/${version}/${filename}`;
}

export const APK_URL: string = buildReleaseAssetUrl("control-proxy-debug.apk");
export const APK_SHA256_CHECKSUM: string = resolveChecksum(LATEST_RELEASE_VERSION, "android");

export const IOS_CTRL_PROXY_RELEASE_VERSION: string = LATEST_RELEASE_VERSION;
export const IOS_CTRL_PROXY_IPA_URL: string = buildReleaseAssetUrl("control-proxy.ipa");
export const IOS_CTRL_PROXY_SHA256_CHECKSUM: string = resolveChecksum(LATEST_RELEASE_VERSION, "ios");
export const IOS_CTRL_PROXY_APP_HASH: string = ""; // Hash of CtrlProxyApp.app (device build), empty = skip verification
export const IOS_CTRL_PROXY_RUNNER_SHA256: string = ""; // SHA256 of runner binary (CtrlProxyUITests-Runner), empty = skip verification
