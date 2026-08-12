package dev.jasonpearson.automobile.desktop.core.update

/** A published release's fields relevant to the update check. */
data class ReleaseInfo(
  val tagName: String,
  val isDraft: Boolean,
  val isPrerelease: Boolean,
  val htmlUrl: String?,
  val assets: List<ReleaseAsset>,
)

/**
 * Fetches the latest release. The network implementation is [GitHubReleaseSource]; tests supply a
 * fake. Any failure (network, non-2xx, malformed body) is signalled by throwing
 * [ReleaseFetchException] so the controller can map it to [UpdateStatus.Failed].
 */
fun interface ReleaseSource {
  suspend fun fetchLatestRelease(): ReleaseInfo
}

/** Raised by a [ReleaseSource] when the latest release cannot be retrieved or parsed. */
class ReleaseFetchException(message: String, cause: Throwable? = null) : Exception(message, cause)
