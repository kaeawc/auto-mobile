/**
 * Release constants - DO NOT EDIT MANUALLY
 *
 * This file contains release-specific constants that are updated automatically.
 * The values below are defaults for local development.
 *
 * The APK checksum is updated by the merge workflow when the accessibility
 * service APK changes. The release workflow verifies the checksum matches
 * the built APK before publishing.
 *
 * During CI/CD release builds, the release version is replaced via
 * scripts/generate-release-constants.sh
 *
 * For local development, RELEASE_VERSION "latest" fetches from the most recent
 * GitHub release. Because the "latest" asset can change over time, runtime
 * checksum verification is only reliable for pinned release versions.
 */

export const LATEST_RELEASE_VERSION = "latest";

export function usesMutableLatestRelease(version: string): boolean {
  return version.trim().toLowerCase() === LATEST_RELEASE_VERSION;
}

export const RELEASE_VERSION: string = LATEST_RELEASE_VERSION;
export const APK_URL: string = RELEASE_VERSION === LATEST_RELEASE_VERSION
  ? `https://github.com/kaeawc/auto-mobile/releases/latest/download/control-proxy-debug.apk`
  : `https://github.com/kaeawc/auto-mobile/releases/download/v${RELEASE_VERSION}/control-proxy-debug.apk`;
export const APK_SHA256_CHECKSUM: string = "8ecd4e6a33d6158188535d9020d7145bc7038de3c1ff551a0474f08de401c7b1"; // Empty = skip verification (local dev only)

/**
 * iOS CtrlProxy Release Constants
 *
 * CtrlProxy is distributed via GitHub releases as a prebuilt bundle.
 * The default "latest" version targets the most recent release.
 */
export const IOS_CTRL_PROXY_RELEASE_VERSION: string = LATEST_RELEASE_VERSION;
export const IOS_CTRL_PROXY_IPA_URL: string = IOS_CTRL_PROXY_RELEASE_VERSION === LATEST_RELEASE_VERSION
  ? "https://github.com/kaeawc/auto-mobile/releases/latest/download/control-proxy.ipa"
  : `https://github.com/kaeawc/auto-mobile/releases/download/v${IOS_CTRL_PROXY_RELEASE_VERSION}/control-proxy.ipa`;
export const IOS_CTRL_PROXY_SHA256_CHECKSUM: string = "e27ef949c6d68ffe19097a0db84284598b9ad0f3b04e887c68a9a04cf9425825"; // Empty = skip verification (local dev only)
export const IOS_CTRL_PROXY_APP_HASH: string = ""; // Hash of CtrlProxyApp.app (device build), empty = skip verification
export const IOS_CTRL_PROXY_RUNNER_SHA256: string = ""; // SHA256 of runner binary (CtrlProxyUITests-Runner), empty = skip verification
