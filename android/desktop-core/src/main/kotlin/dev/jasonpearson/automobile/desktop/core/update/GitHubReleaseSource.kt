package dev.jasonpearson.automobile.desktop.core.update

import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * [ReleaseSource] backed by the GitHub REST API `releases/latest` endpoint (unauthenticated — the
 * repo is public). Uses the JDK [HttpClient] already used elsewhere in this module; the blocking
 * `send` is confined to [Dispatchers.IO]. Non-2xx responses (notably 403 rate-limit) and malformed
 * bodies are converted to [ReleaseFetchException].
 */
class GitHubReleaseSource(
  private val repo: String = "kaeawc/auto-mobile",
  private val httpClient: HttpClient = HttpClient.newBuilder().build(),
) : ReleaseSource {

  override suspend fun fetchLatestRelease(): ReleaseInfo =
    withContext(Dispatchers.IO) {
      val uri = URI.create("https://api.github.com/repos/$repo/releases/latest")
      val request =
        HttpRequest.newBuilder(uri)
          .header("Accept", "application/vnd.github+json")
          .header("X-GitHub-Api-Version", "2022-11-28")
          .GET()
          .build()

      val response =
        try {
          httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        } catch (error: IOException) {
          throw ReleaseFetchException("Failed to reach GitHub: ${error.message}", error)
        } catch (error: InterruptedException) {
          Thread.currentThread().interrupt()
          throw ReleaseFetchException("Update check was interrupted", error)
        }

      when (val code = response.statusCode()) {
        in 200..299 -> parseLatestRelease(response.body())
        403 -> throw ReleaseFetchException("GitHub API rate limit or access forbidden (403)")
        else -> throw ReleaseFetchException("GitHub API returned HTTP $code")
      }
    }
}

private val releaseJson = Json { ignoreUnknownKeys = true }

@Serializable
private data class GitHubRelease(
  val tag_name: String? = null,
  val draft: Boolean = false,
  val prerelease: Boolean = false,
  val html_url: String? = null,
  val assets: List<GitHubAsset> = emptyList(),
)

@Serializable
private data class GitHubAsset(
  val name: String? = null,
  val browser_download_url: String? = null,
  val size: Long = 0,
)

/**
 * Parses a GitHub `releases/latest` JSON body into a [ReleaseInfo]. Assets missing a name or
 * download URL are dropped rather than surfaced as half-populated. A body without `tag_name` is a
 * failure. Extracted (and internal) so the parse is unit-tested without a network round-trip.
 */
internal fun parseLatestRelease(body: String): ReleaseInfo {
  val release =
    try {
      releaseJson.decodeFromString<GitHubRelease>(body)
    } catch (error: SerializationException) {
      throw ReleaseFetchException("Malformed release JSON: ${error.message}", error)
    }
  val tag =
    release.tag_name?.takeIf { it.isNotBlank() }
      ?: throw ReleaseFetchException("Release JSON is missing tag_name")
  val assets =
    release.assets.mapNotNull { asset ->
      val name = asset.name ?: return@mapNotNull null
      val url = asset.browser_download_url ?: return@mapNotNull null
      ReleaseAsset(name = name, downloadUrl = url, sizeBytes = asset.size)
    }
  return ReleaseInfo(
    tagName = tag,
    isDraft = release.draft,
    isPrerelease = release.prerelease,
    htmlUrl = release.html_url,
    assets = assets,
  )
}
