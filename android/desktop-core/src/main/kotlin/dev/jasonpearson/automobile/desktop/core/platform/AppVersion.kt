package dev.jasonpearson.automobile.desktop.core.platform

/**
 * The running desktop app's own version, resolved at runtime.
 *
 * [raw] preserves the exact version string the app was packaged with, including any `-SNAPSHOT` or
 * build-metadata suffix. Semantic comparison against GitHub release tags is the update checker's
 * concern (a later item), not this value's — this type only answers "what version am I, and am I a
 * packaged build or a development run?".
 */
data class AppVersion(val raw: String, val isDevelopment: Boolean) {
  companion object {
    /**
     * Sentinel for runs where no version string can be resolved at all. Update checks treat
     * [isDevelopment] as "never self-update" so development never triggers an installer download
     * against itself.
     */
    val Dev: AppVersion = AppVersion(raw = "dev", isDevelopment = true)

    /**
     * Marks source/local builds. Release installers are packaged with a plain, unsuffixed semver.
     */
    private const val SNAPSHOT_SUFFIX = "-SNAPSHOT"

    /**
     * Maps a raw version string to an [AppVersion]. A null or blank string yields [Dev]. A
     * `-SNAPSHOT` version is a source/local build (the generated version resource is present in
     * ordinary Gradle/IDE runs, so absence of the resource is *not* a reliable dev signal — the
     * SNAPSHOT qualifier is), so it is marked `isDevelopment = true` while preserving [raw]. Only a
     * plain, unsuffixed version — what the release workflow packages — is treated as a real
     * installed build eligible for updates.
     */
    fun of(raw: String?): AppVersion {
      val trimmed = raw?.trim()
      if (trimmed.isNullOrEmpty()) return Dev
      val isSnapshot = trimmed.endsWith(SNAPSHOT_SUFFIX, ignoreCase = true)
      return AppVersion(raw = trimmed, isDevelopment = isSnapshot)
    }
  }
}
