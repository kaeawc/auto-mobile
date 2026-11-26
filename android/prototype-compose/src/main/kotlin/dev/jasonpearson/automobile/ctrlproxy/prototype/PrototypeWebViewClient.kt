package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.Bitmap
import android.net.http.SslError
import android.util.Log
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import dev.jasonpearson.automobile.protocol.PrototypeWebViewNode
import java.io.IOException
import java.net.URI
import java.net.URISyntaxException

/**
 * Main callbacks own navigation state. Interception reads snapshots and posts terminal outcomes.
 */
@Suppress("TooManyFunctions") // WebView callback overrides share one navigation lifetime.
internal class PrototypeWebViewClient(
  node: PrototypeWebViewNode,
  private val module: PrototypeWebViewModule,
  page: PrototypeWebPage,
  interact: (PrototypeInteraction) -> Unit,
) : WebViewClient() {
  private val requests = PrototypeWebViewRequests(node.allowedOrigins, module.fetcher)
  private val navigation = PrototypeWebViewNavigation(node, page, interact)
  private var authoredUrl: String? = null

  private class Hop(
    val url: String? = null,
    val depth: Int = 0,
    val fromHistory: Boolean = false,
  ) {
    @Volatile var intercepted = false
    @Volatile var terminal = false

    fun matches(candidate: String): Boolean =
      url == null ||
        url == candidate ||
        navigationKey(url)?.let { it == navigationKey(candidate) } == true
  }

  @Volatile private var hop = Hop()
  @Volatile private var released = false
  private val inactive: Boolean
    get() = released || module.closed

  fun update(
    view: WebView,
    node: PrototypeWebViewNode,
    url: String,
    interact: (PrototypeInteraction) -> Unit,
  ) {
    navigation.update(node, interact)
    if (url == authoredUrl || inactive) return
    authoredUrl = url
    val allowed = beginNavigation(url)
    view.stopLoading()
    if (allowed) navigation.load(url)
  }

  fun beginNavigation(url: String, fromHistory: Boolean = false, depth: Int = 0): Boolean {
    if (inactive) return false
    val next = Hop(url, depth, fromHistory)
    hop = next
    navigation.reset()
    val allowed = navigation.permits(url, true)
    next.terminal = !allowed
    return allowed
  }

  fun release() {
    released = true
  }

  /** WebChromeClient.onReceivedTitle can arrive after onPageFinished (#19418). */
  fun titleChanged() {
    if (!inactive) navigation.titleChanged()
  }

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
    if (inactive) return true
    val url = request.url.toString()
    return if (request.isForMainFrame) {
      !beginNavigation(url, depth = if (request.isRedirect) hop.depth else 0)
    } else {
      !navigation.permits(url, false)
    }
  }

  @Suppress("ReturnCount") // A stale or disposed navigation never makes a new request.
  override fun shouldInterceptRequest(
    view: WebView,
    request: WebResourceRequest,
  ): WebResourceResponse {
    if (inactive) return PrototypeWebFetchResult(403, "Forbidden").webResponse()
    val current = hop
    val mainFrame = request.isForMainFrame
    val url = request.url.toString()
    if (mainFrame && current.terminal)
      return PrototypeWebFetchResult(403, "Forbidden").webResponse()
    if (mainFrame && !current.matches(url) && request.method in setOf("GET", "HEAD"))
      return PrototypeWebFetchResult(403, "Forbidden").webResponse()
    val result = serve(request, url, current.depth)

    if (inactive || (mainFrame && current !== hop)) {
      result.response.body.close()
      return PrototypeWebFetchResult(403, "Forbidden").webResponse()
    }

    if (mainFrame) reportMainFrame(view, current, result)
    return result.response.webResponse()
  }

  // A thrown transport or stream error must still answer the interception, without falling through.
  @Suppress("TooGenericExceptionCaught")
  private fun serve(request: WebResourceRequest, url: String, depth: Int): PrototypeWebIntercept =
    try {
      requests.serve(url, request.method, request.requestHeaders, request.isForMainFrame, depth)
    } catch (error: IOException) {
      networkFailure(error)
    } catch (error: RuntimeException) {
      networkFailure(error)
    }

  private fun networkFailure(error: Exception): PrototypeWebIntercept {
    Log.w("PrototypeWebView", "Web request failed: ${error.javaClass.simpleName}")
    return PrototypeWebIntercept(PrototypeWebFetchResult(502, "Upstream Request Failed"))
  }

  private fun reportMainFrame(view: WebView, current: Hop, result: PrototypeWebIntercept) {
    current.intercepted = true
    val blocked = result.blockedUrl
    val redirect = result.redirectUrl
    current.terminal = blocked != null || redirect != null || result.response.status >= 400
    if (!current.terminal) return
    view.post {
      if (!inactive && hop === current) {
        when {
          blocked != null -> navigation.blocked(blocked)
          redirect != null -> {
            hop = Hop(redirect, result.redirectHops)
            navigation.load(redirect)
          }
          else -> navigation.failed()
        }
      }
    }
  }

  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
    if (inactive || hop.terminal || !hop.matches(url)) return
    if (navigation.permits(url, true)) navigation.started(url)
    else {
      hop.terminal = true
      view.stopLoading()
    }
  }

  override fun onPageFinished(view: WebView, url: String) {
    // An intermediate 204 and synthetic error pages must never emit onNavigate.
    val current = hop
    if (inactive || current.terminal || !current.matches(url)) return
    if (view.url == url && (current.intercepted || current.fromHistory)) navigation.finished(url)
  }

  override fun onReceivedError(
    view: WebView,
    request: WebResourceRequest,
    error: WebResourceError,
  ) {
    if (request.isForMainFrame) reportError(request.url.toString())
  }

  override fun onReceivedHttpError(
    view: WebView,
    request: WebResourceRequest,
    errorResponse: WebResourceResponse,
  ) {
    if (request.isForMainFrame) reportError(request.url.toString())
  }

  override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
    handler.cancel()
    reportError(error.url)
  }

  private fun reportError(url: String) {
    val current = hop
    if (inactive || current.terminal || !current.matches(url)) return
    current.terminal = true
    navigation.failed()
  }
}

/** Chromium normalizes root slashes, default ports and fragments before reporting a request. */
private fun navigationKey(url: String): String? =
  try {
    val uri = URI(URI(url).toASCIIString()).normalize()
    val authority = uri.rawAuthority?.lowercase()?.removeSuffix(":443")
    val path = uri.rawPath?.ifEmpty { "/" }
    "${uri.scheme}://$authority$path?${uri.rawQuery.orEmpty()}"
  } catch (_: URISyntaxException) {
    null
  }

private fun PrototypeWebFetchResult.webResponse(): WebResourceResponse {
  val contentType = headers.entries.firstOrNull { it.key.equals("Content-Type", true) }?.value
  val mimeType = contentType?.substringBefore(';')?.trim()
  val encoding =
    contentType?.split(';')?.drop(1)?.firstNotNullOfOrNull {
      val (name, value) =
        it.split('=', limit = 2).let { parts ->
          parts.first() to parts.getOrNull(1)
        }
      value?.trim()?.trim('"')?.takeIf { name.trim().equals("charset", true) }
    }
  return WebResourceResponse(mimeType, encoding, status, reason, headers, body)
}
