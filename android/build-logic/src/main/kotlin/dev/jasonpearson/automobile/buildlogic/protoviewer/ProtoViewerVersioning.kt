package dev.jasonpearson.automobile.buildlogic.protoviewer

/**
 * Monotonic Play `versionCode` derived from the release version (#14146).
 *
 * `versionCode = major * 1_000_000 + minor * 1_000 + patch`. Play requires every upload to carry a
 * strictly greater code than the last and caps it at 2_100_000_000, so the fields are bounded
 * (major <= 2099, minor and patch <= 999): within those bounds the code is strictly increasing in
 * (major, minor, patch) order, so a newer release always out-ranks an older one. Pre-release and
 * build suffixes (`-SNAPSHOT`, `-rc.1`) are rejected: a published build carries a plain
 * `MAJOR.MINOR.PATCH` name.
 */
object ProtoViewerVersioning {
  /** Version code of local, never-published builds. */
  const val LOCAL_VERSION_CODE = 1

  const val PLAY_MAX_VERSION_CODE = 2_100_000_000
  const val MAX_MAJOR = 2099
  const val MAX_MINOR_OR_PATCH = 999

  private val RELEASE_VERSION = Regex("""(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})""")

  /** Returns the version code, or throws [IllegalArgumentException] naming the problem. */
  fun versionCode(releaseVersion: String): Int {
    val match =
      requireNotNull(RELEASE_VERSION.matchEntire(releaseVersion)) {
        "Release version '$releaseVersion' must be plain MAJOR.MINOR.PATCH (no -SNAPSHOT or other suffix)"
      }
    val (major, minor, patch) = match.destructured.toList().map { it.toInt() }
    require(major <= MAX_MAJOR) { "Release version '$releaseVersion': major must be <= $MAX_MAJOR" }
    require(minor <= MAX_MINOR_OR_PATCH && patch <= MAX_MINOR_OR_PATCH) {
      "Release version '$releaseVersion': minor and patch must be <= $MAX_MINOR_OR_PATCH"
    }
    return major * 1_000_000 + minor * 1_000 + patch
  }
}
