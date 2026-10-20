package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonLaunchCommands.ignoredPackageVersions

internal object DaemonIdentityPolicy {
  /**
   * The release portion of a version string — everything before the semver `+g<sha>` dev stamp.
   * Mirrors the daemon's `releaseVersion`, so a git-stamped source-checkout daemon and a
   * plain-versioned runner compare equal at the same release.
   */
  internal fun releaseVersion(version: String): String = version.substringBefore('+')

  /**
   * Whether an already-running daemon must be restarted because its recorded build identity differs
   * from this runner's — two checkouts at the *same* release version (e.g. `0.0.40+gold` vs a local
   * `0.0.40`) that the release-only version check cannot tell apart (#2744). Mirrors the daemon's
   * `buildIdentitiesMatch`: compare content hashes when both are known, else fall back to comparing
   * entry-script paths (so a daemon whose hash is `unknown` but whose recorded entry script differs
   * still triggers a restart), else treat as a match to avoid thrashing an unidentifiable daemon.
   */
  internal fun requiresBuildSkewRestart(
    daemonBuildId: String?,
    daemonEntryScript: String?,
    clientBuildId: String?,
    clientEntryScript: String?,
  ): Boolean {
    val daemonHash = daemonBuildId?.trim().orEmpty()
    val clientHash = clientBuildId?.trim().orEmpty()
    val daemonHashKnown = daemonHash.isNotEmpty() && daemonHash != "unknown"
    val clientHashKnown = clientHash.isNotEmpty() && clientHash != "unknown"
    if (daemonHashKnown && clientHashKnown) {
      return daemonHash != clientHash
    }
    val daemonEntry = daemonEntryScript?.trim().orEmpty()
    val clientEntry = clientEntryScript?.trim().orEmpty()
    if (daemonEntry.isNotEmpty() && clientEntry.isNotEmpty()) {
      return daemonEntry != clientEntry
    }
    return false
  }

  /**
   * Whether an already-running daemon must be restarted before reuse because its recorded version
   * does not match this runner's (#2744). Compares release portions (stripping the dev stamp),
   * mirroring the MCP proxy's `ensureVersionMatches`. A blank/unknown version on either side yields
   * false: without both versions the skew cannot be proven, and forcing a restart would thrash a
   * daemon we cannot identify (matches the daemon gate's lenient "unknown => allow" stance).
   */
  internal fun requiresVersionSkewRestart(daemonVersion: String?, clientVersion: String?): Boolean {
    val daemonBase = releaseVersion(daemonVersion?.trim().orEmpty())
    val clientBase = releaseVersion(clientVersion?.trim().orEmpty())
    if (daemonBase.isEmpty() || clientBase.isEmpty()) return false
    return daemonBase != clientBase
  }

  internal fun resolveCallerAssetVersionPin(): String? {
    val pinned = System.getenv("AUTOMOBILE_VERSION")?.trim().orEmpty()
    if (pinned.isEmpty() || ignoredPackageVersions.contains(pinned.lowercase())) {
      return null
    }
    return pinned
  }

  internal fun requiresAssetVersionPinFailure(
    daemonAssetVersion: String?,
    callerPinnedVersion: String?,
  ): Boolean {
    val daemon = daemonAssetVersion?.trim().orEmpty()
    val caller = callerPinnedVersion?.trim().orEmpty()
    if (caller.isEmpty() || ignoredPackageVersions.contains(caller.lowercase())) {
      return false
    }
    return daemon != caller
  }

  internal fun requiresImmediateAssetVersionPinFailure(
    assetVersionSkew: Boolean,
    versionSkew: Boolean,
    buildSkew: Boolean,
    forceRestart: Boolean,
  ): Boolean {
    return assetVersionSkew && !versionSkew && !buildSkew && !forceRestart
  }
}
