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
     * Sentinel for runs where no packaged version can be resolved — a Gradle `run`, the IDE, and
     * Compose hot-reload all lack the generated version resource and the packaged jar manifest.
     * Update checks treat [isDevelopment] as "never self-update" so development never triggers an
     * installer download against itself.
     */
    val Dev: AppVersion = AppVersion(raw = "dev", isDevelopment = true)

    /**
     * Maps a raw version string to an [AppVersion]. A null or blank string (the unpackaged case)
     * yields [Dev]; otherwise the trimmed string is preserved verbatim as a packaged version.
     */
    fun of(raw: String?): AppVersion =
      raw?.trim()?.takeIf { it.isNotEmpty() }?.let { AppVersion(raw = it, isDevelopment = false) }
        ?: Dev
  }
}
