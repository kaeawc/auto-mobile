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
    version: "0.0.38",
    apkSha256: "0fb955a617654695036642662634d042c2e3d278b8e1dce20ccb37e425f059f3",
    ipaSha256: "f5a4a485ff8ebf3bfd0d73c8b7b10769177b419ccd62e48db188bb5122a2fcde",
  },
  {
    version: "0.0.37",
    apkSha256: "f9b0cc92bf8f7416cdb0c458e16c7a41e4fdeefb80bb9429ab7c603388c99083",
    ipaSha256: "caccbfaa4da0015bab701a36b81ac87e3f3f3330cee77bb10ec8553724275f4f",
  },
  {
    version: "0.0.36",
    apkSha256: "b5f56bb0ab065c60385a22013c97ee706213eb16deb5d4bcfa42f0a707b8620a",
    ipaSha256: "40e973dc8c87149e40a616658c74d90e648c6514cc642a5c3dd4a45a187e7600",
  },
  {
    version: "0.0.35",
    apkSha256: "039b359bcf35f1ab6cc666005a57823d71a771a96bd9bcaf4f82f2ec945e306d",
    ipaSha256: "e6afdfd04a90d2388dc4604e7957d3eef87b90a51ca37c5457b8139a54728108",
  },
  {
    version: "0.0.34",
    apkSha256: "4dcee4f6a7359847d081c5e184c57ed100ad135af2e62f3abfc7b0defaa1153c",
    ipaSha256: "c2a26ca065c85e9f8d5cfcd6dbad1dbaf3ce38b18d770b0983f7bad62129e4a3",
  },
  {
    version: "0.0.33",
    apkSha256: "7289eba90b22890d3c36e05e99db72a545fa4becdf46df079885783a919e6aed",
    ipaSha256: "425dfa4db4ad5a4febc9f05ffc97df38f3a1098ccdd9330adff1c0b5c877697d",
  },
  {
    version: "0.0.32",
    apkSha256: "4c4a743af5d18ed58214e64b85986c9e2f2332b015edcf7d9d68a24cd6dfda21",
    ipaSha256: "40f4d9084d3368995b57c0e81c4fe85f38851353da9f789eaff93027aee456a0",
  },
  {
    version: "0.0.31",
    apkSha256: "0b5802ada8d9adccdb69ee140ae788b3251832c0605d2f6baa3e9b7a78260764",
    ipaSha256: "e60f8689fb6ddd5c06a5d2ff57569b264f407229afb986258d1ce20326dc24c7",
  },
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

// --- Backward-compatible exports derived from RELEASE_VERSION ---

export const RELEASE_VERSION: string = LATEST_RELEASE_VERSION;

/**
 * Resolve a version string to its concrete equivalent. Module-level constants
 * (URLs, on-disk metadata, doctor checks) want a concrete version like
 * "0.0.30", never the placeholder "latest".
 */
export function resolveAssetVersion(version: string): string {
  if (version === LATEST_RELEASE_VERSION) {
    return resolveLatestVersion();
  }
  return version;
}

function buildReleaseAssetUrl(filename: string, version: string): string {
  const assetVersion = resolveAssetVersion(version);
  if (assetVersion === LATEST_RELEASE_VERSION) {
    // Degenerate case: empty registry. Fall back to GitHub's redirecting
    // /latest/download/ endpoint.
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
