package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import dev.jasonpearson.automobile.protocol.PrototypeWebViewNode
import java.io.ByteArrayInputStream
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowSslErrorHandler

@RunWith(RobolectricTestRunner::class)
class PrototypeWebViewClientTest {
  private lateinit var webView: WebView
  private lateinit var client: PrototypeWebViewClient
  private lateinit var module: PrototypeWebViewModule

  @Before
  fun configure() {
    webView = WebView(RuntimeEnvironment.getApplication())
    val allowed = "https://example.com"
    val node = PrototypeWebViewNode(url = allowed, allowedOrigins = listOf(allowed))
    module =
      PrototypeWebViewModule(
        PrototypeWebFetcher { _, _, _ ->
          PrototypeWebFetchResult(200, "OK", body = ByteArrayInputStream(byteArrayOf(42)))
        },
      )
    client = PrototypeWebViewClient(node, module, FakePage()) {}
    webView.webViewClient = client
  }

  @After
  fun release() {
    module.close()
    webView.destroy()
  }

  @Test
  fun interceptionReturnsBodiesAndDeniedRequestsNeverFallThrough() {
    val denied = client.shouldInterceptRequest(webView, Resource("https://elsewhere.test"))
    assertEquals(403, denied.statusCode)
    assertEquals(-1, denied.data.read())
    val allowed = client.shouldInterceptRequest(webView, Resource("https://example.com"))
    assertEquals(200, allowed.statusCode)
    assertEquals(42, allowed.data.read())
  }

  @Test
  fun sslErrorCancelsEvenAfterRelease() {
    client.release()
    val handler = Shadow.newInstanceOf(SslErrorHandler::class.java)
    val cert = Shadow.newInstanceOf(SslCertificate::class.java)
    client.onReceivedSslError(
      webView,
      handler,
      SslError(SslError.SSL_UNTRUSTED, cert, "https://example.com"),
    )
    val shadow = Shadow.extract<ShadowSslErrorHandler>(handler)
    assertTrue(shadow.wasCancelCalled())
    assertFalse(shadow.wasProceedCalled())
  }

  private class Resource(private val candidate: String) : WebResourceRequest {
    override fun getUrl(): Uri = Uri.parse(candidate)

    override fun isForMainFrame() = false

    override fun isRedirect() = false

    override fun hasGesture() = false

    override fun getMethod() = "GET"

    override fun getRequestHeaders(): Map<String, String> = emptyMap()
  }

  private class FakePage : PrototypeWebPage {
    override val canGoBack = false
    override val title = ""

    override fun load(url: String) = Unit

    override fun back() = Unit

    override fun reload() = Unit
  }
}
