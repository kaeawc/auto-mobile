package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.URI
import java.net.URISyntaxException

/** Runs off main. The host owns DNS and TLS checks and must return redirects without following. */
@InternalAutoMobilePrototypeApi
fun interface PrototypeWebFetcher {
  fun fetch(url: String, method: String, headers: Map<String, String>): PrototypeWebFetchResult
}

/** The consumer closes [body]; all transport failures are returned as empty responses. */
@InternalAutoMobilePrototypeApi
data class PrototypeWebFetchResult(
  val status: Int,
  val reason: String,
  val headers: Map<String, String> = emptyMap(),
  val body: InputStream = ByteArrayInputStream(byteArrayOf()),
  val redirectLocation: String? = null,
  val destinationBlocked: Boolean = false,
)

internal data class PrototypeWebIntercept(
  val response: PrototypeWebFetchResult,
  val blockedUrl: String? = null,
  val redirectUrl: String? = null,
  val redirectHops: Int = 0,
)

internal class PrototypeWebViewRequests(
  private val origins: List<String>,
  private val fetcher: PrototypeWebFetcher,
) {
  @Suppress("ReturnCount") // Each outcome either transfers or closes the response stream.
  fun serve(
    url: String,
    method: String,
    headers: Map<String, String>,
    mainFrame: Boolean,
    redirectHops: Int = 0,
  ): PrototypeWebIntercept {
    if (method != "GET" && method != "HEAD") return empty(405, "Method Not Allowed")
    if (!allowed(url, mainFrame)) return blocked(url, mainFrame)
    val safeHeaders = headers.filterKeys { it.lowercase() in requestHeaders }
    var current = url
    var hops = redirectHops
    while (true) {
      val fetched = fetcher.fetch(current, method, safeHeaders)
      if (fetched.destinationBlocked) {
        fetched.body.close()
        return blocked(current, mainFrame)
      }
      if (fetched.status !in 300..399) return PrototypeWebIntercept(fetched)
      fetched.body.close()
      val next =
        fetched.redirectLocation?.let { resolve(current, it) }
          ?: return empty(502, "Invalid Redirect")
      if (!allowed(next, mainFrame)) return blocked(next, mainFrame)
      if (hops >= MAX_REDIRECTS) return empty(502, "Too Many Redirects")
      hops++
      if (mainFrame)
        return PrototypeWebIntercept(
          PrototypeWebFetchResult(204, "No Content"),
          redirectUrl = next,
          redirectHops = hops,
        )
      current = next
    }
  }

  private fun allowed(url: String, mainFrame: Boolean): Boolean =
    PrototypeWebViewPolicy.check(url, origins, mainFrame) == PrototypeWebViewPolicy.Allow

  private fun blocked(url: String, mainFrame: Boolean) =
    PrototypeWebIntercept(
      PrototypeWebFetchResult(403, "Forbidden"),
      blockedUrl = url.takeIf { mainFrame },
    )

  private fun empty(status: Int, reason: String) =
    PrototypeWebIntercept(PrototypeWebFetchResult(status, reason))

  private fun resolve(base: String, location: String): String =
    try {
      val target = URI(location)
      // URI.resolve treats query-only references as siblings. Keep the current path.
      if (location.startsWith("?")) base.substringBefore('#').substringBefore('?') + location
      else URI(base).resolve(target).toString()
    } catch (_: URISyntaxException) {
      // The policy rejects malformed Location values, including ones that name a forbidden scheme.
      location
    }

  private companion object {
    const val MAX_REDIRECTS = 5
    val requestHeaders = setOf("accept", "accept-language", "user-agent")
  }
}
