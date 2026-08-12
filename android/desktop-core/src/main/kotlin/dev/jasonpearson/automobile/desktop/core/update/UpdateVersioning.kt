package dev.jasonpearson.automobile.desktop.core.update

/**
 * True when [candidate] is a strictly newer release than [current]. Both may carry a leading `v`
 * and a `-prerelease` / `+build` suffix. Numeric core segments compare left to right; when cores
 * are equal a final release outranks a prerelease, and two prereleases compare lexically. Anything
 * unparseable in a segment is treated as 0 so a malformed tag never reads as "newer".
 */
internal fun isNewerVersion(candidate: String, current: String): Boolean {
  // A version we cannot fully parse (e.g. "v1.bad.0", "nightly") must never read as newer, or a
  // malformed tag could surface a bogus update. parseVersion returns null for such input.
  val a = parseVersion(candidate) ?: return false
  val b = parseVersion(current) ?: return false
  val segments = maxOf(a.numbers.size, b.numbers.size)
  for (i in 0 until segments) {
    val left = a.numbers.getOrElse(i) { 0 }
    val right = b.numbers.getOrElse(i) { 0 }
    if (left != right) return left > right
  }
  // Numeric cores are equal: order by prerelease precedence (release outranks any prerelease).
  return comparePrerelease(a.prerelease, b.prerelease) > 0
}

/**
 * SemVer prerelease precedence. A null prerelease (a final release) outranks any prerelease.
 * Otherwise dot-separated identifiers compare left to right: numeric identifiers numerically,
 * numeric below alphanumeric, alphanumeric lexically; a larger set of identifiers outranks a prefix
 * of it. So `rc.10` > `rc.9` (numeric), not the lexical `"rc.10" < "rc.9"`.
 */
private fun comparePrerelease(a: String?, b: String?): Int {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  val aIds = a.split('.')
  val bIds = b.split('.')
  for (i in 0 until maxOf(aIds.size, bIds.size)) {
    val x = aIds.getOrNull(i) ?: return -1
    val y = bIds.getOrNull(i) ?: return 1
    val xn = x.toIntOrNull()
    val yn = y.toIntOrNull()
    val cmp =
      when {
        xn != null && yn != null -> xn.compareTo(yn)
        xn != null -> -1
        yn != null -> 1
        else -> x.compareTo(y)
      }
    if (cmp != 0) return cmp
  }
  return 0
}

/**
 * Resolves the installer asset for [platform] by suffix match, or null if the release lacks one.
 */
internal fun resolveAsset(assets: List<ReleaseAsset>, platform: HostPlatform): ReleaseAsset? =
  assets.firstOrNull {
    it.name.endsWith(platform.assetSuffix, ignoreCase = true)
  }

private data class ParsedVersion(val numbers: List<Int>, val prerelease: String?)

/** A SemVer prerelease identifier: one or more ASCII alphanumerics or hyphens. */
private val PRERELEASE_IDENTIFIER = Regex("[0-9A-Za-z-]+")

/**
 * Parses `[v]MAJOR.MINOR.PATCH[-prerelease][+build]`, or null if any core segment is non-numeric or
 * the prerelease contains an empty/invalid identifier (`1.0.1-`, `1.0.1-alpha..1`). Rejecting
 * rather than best-effort-parsing keeps a malformed tag from ever reading as newer.
 */
private fun parseVersion(raw: String): ParsedVersion? {
  val withoutPrefix = raw.trim().removePrefix("v").removePrefix("V")
  val withoutBuild = withoutPrefix.substringBefore('+')
  val dash = withoutBuild.indexOf('-')
  val core = if (dash >= 0) withoutBuild.substring(0, dash) else withoutBuild
  val prerelease = if (dash >= 0) withoutBuild.substring(dash + 1) else null
  val numbers = ArrayList<Int>()
  for (segment in core.split('.')) {
    // A non-numeric core segment means we cannot trust the version — reject the whole string.
    numbers.add(segment.toIntOrNull() ?: return null)
  }
  if (prerelease != null && !isValidPrerelease(prerelease)) return null
  return ParsedVersion(numbers, prerelease)
}

/** True when every dot-separated prerelease identifier is non-empty and uses the SemVer charset. */
private fun isValidPrerelease(prerelease: String): Boolean =
  prerelease.split('.').all { it.isNotEmpty() && PRERELEASE_IDENTIFIER.matches(it) }
