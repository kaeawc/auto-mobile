package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.sha256Hex
import java.io.IOException
import java.net.URI
import java.net.URISyntaxException
import java.util.logging.Level
import java.util.logging.Logger
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Only the parser constructs a link; parsing performs no DNS or network I/O. */
internal class ShareImportLink private constructor(val url: HttpUrl, val sha256: String) {
  companion object {
    fun parse(value: String): ShareImportLink? {
      val uri =
        try {
          URI(value)
        } catch (_: URISyntaxException) {
          return null
        }
      if (uri.scheme != "automobile-proto" || uri.rawAuthority != "import") return null
      if (!uri.rawPath.isNullOrEmpty() || uri.rawFragment != null) return null
      // Reuse OkHttp's structured query decoder, retaining duplicate (even encoded) keys.
      val query =
        HttpUrl.Builder().scheme("https").host("import").encodedQuery(uri.rawQuery).build()
      if (query.querySize != 2 || query.queryParameterNames != setOf("url", "sha256")) return null
      val url = shareImportUrl(query.queryParameter("url") ?: return null) ?: return null
      val hash = query.queryParameter("sha256") ?: return null
      if (!Regex("[0-9a-f]{64}").matches(hash)) return null
      return ShareImportLink(url, hash)
    }
  }
}

/** Mirrors protoViewerShareUrlProblem: absolute HTTPS, empty credentials and empty hash. */
internal fun shareImportUrl(value: String): HttpUrl? =
  value.toHttpUrlOrNull()?.takeIf {
    it.isHttps && it.username.isEmpty() && it.password.isEmpty() && it.fragment.isNullOrEmpty()
  }

internal enum class ShareImportError {
  Blocked,
  Download,
  TooLarge,
  HashMismatch,
}

internal class ShareImportException(val error: ShareImportError) : IOException(error.name)

internal sealed interface ShareImportResult {
  data class Completed(val result: LibraryImportResult) : ShareImportResult

  data class Failed(val error: ShareImportError) : ShareImportResult
}

internal fun interface ShareLibraryImporter {
  /** Call only after the user confirms this link's host and SHA-256. Runs on the I/O dispatcher. */
  fun importConfirmed(link: ShareImportLink): ShareImportResult
}

internal fun interface ShareBundleClient {
  fun download(url: HttpUrl): ByteArray
}

/** Verify the exact downloaded bytes before the unchanged strict reader sees them. */
internal class VerifiedShareLibraryImporter(
  private val client: ShareBundleClient,
  private val importer: LibraryBytesImporter,
) : ShareLibraryImporter {
  override fun importConfirmed(link: ShareImportLink): ShareImportResult =
    try {
      val bytes = client.download(link.url)
      if (sha256Hex(bytes) != link.sha256) ShareImportResult.Failed(ShareImportError.HashMismatch)
      else
        ShareImportResult.Completed(
          // The confirmed link's host is app-owned origin identity; OkHttp lowercases it.
          importer.importBytes(bytes, LibrarySource.share, null, link.url.host),
        )
    } catch (error: ShareImportException) {
      ShareImportResult.Failed(error.error)
    } catch (error: IOException) {
      Logger.getLogger("ProtoViewerImport").log(Level.WARNING, "Share download failed", error)
      ShareImportResult.Failed(ShareImportError.Download)
    }
}
