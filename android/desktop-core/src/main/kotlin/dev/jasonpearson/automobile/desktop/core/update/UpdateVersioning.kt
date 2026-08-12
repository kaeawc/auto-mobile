package dev.jasonpearson.automobile.desktop.core.update

/**
 * True when [candidate] is a strictly newer release than [current]. Both may carry a leading `v`
 * and a `-prerelease` / `+build` suffix. Numeric core segments compare left to right; when cores
 * are equal a final release outranks a prerelease, and two prereleases compare lexically. Anything
 * unparseable in a segment is treated as 0 so a malformed tag never reads as "newer".
 */
internal fun isNewerVersion(candidate: String, current: String): Boolean {
  val a = parseVersion(candidate)
  val b = parseVersion(current)
  val segments = maxOf(a.numbers.size, b.numbers.size)
  for (i in 0 until segments) {
    val left = a.numbers.getOrElse(i) { 0 }
    val right = b.numbers.getOrElse(i) { 0 }
    if (left != right) return left > right
  }
  // Numeric cores are equal: a final release outranks a prerelease; two prereleases compare
  // lexically.
  return when {
    a.prerelease == null && b.prerelease == null -> false
    a.prerelease == null -> true
    b.prerelease == null -> false
    else -> a.prerelease > b.prerelease
  }
}

/**
 * Resolves the installer asset for [platform] by suffix match, or null if the release lacks one.
 */
internal fun resolveAsset(assets: List<ReleaseAsset>, platform: HostPlatform): ReleaseAsset? =
  assets.firstOrNull {
    it.name.endsWith(platform.assetSuffix, ignoreCase = true)
  }

private data class ParsedVersion(val numbers: List<Int>, val prerelease: String?)

private fun parseVersion(raw: String): ParsedVersion {
  val withoutPrefix = raw.trim().removePrefix("v").removePrefix("V")
  val withoutBuild = withoutPrefix.substringBefore('+')
  val dash = withoutBuild.indexOf('-')
  val core = if (dash >= 0) withoutBuild.substring(0, dash) else withoutBuild
  val prerelease = if (dash >= 0) withoutBuild.substring(dash + 1) else null
  val numbers = core.split('.').map { it.toIntOrNull() ?: 0 }
  return ParsedVersion(numbers, prerelease)
}
