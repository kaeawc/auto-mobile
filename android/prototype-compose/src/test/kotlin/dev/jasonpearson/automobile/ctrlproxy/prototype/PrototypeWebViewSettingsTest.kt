package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.webkit.WebSettings
import android.webkit.WebView
import dev.jasonpearson.automobile.protocol.PrototypeWebViewNode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class PrototypeWebViewSettingsTest {
  @Suppress("DEPRECATION")
  @Test
  fun disablesActiveContentAndLocalAccessForBothScriptFlags() {
    val webView = WebView(RuntimeEnvironment.getApplication())
    try {
      for (flag in listOf(false, true)) {
        val node =
          PrototypeWebViewNode(
            url = "https://example.com",
            allowedOrigins = listOf("https://example.com"),
            javaScript = flag,
          )
        configurePrototypeWebView(webView, node)
        with(webView.settings) {
          assertFalse(javaScriptEnabled)
          assertFalse(domStorageEnabled)
          assertFalse(allowFileAccess)
          assertFalse(allowContentAccess)
          assertFalse(allowFileAccessFromFileURLs)
          assertFalse(allowUniversalAccessFromFileURLs)
          assertFalse(javaScriptCanOpenWindowsAutomatically)
          assertFalse(supportMultipleWindows())
          assertFalse(saveFormData)
          assertFalse(savePassword)
          assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, mixedContentMode)
        }
        for (name in listOf("Android", "AutoMobile", "bridge")) {
          assertNull(shadowOf(webView).getJavascriptInterface(name))
        }
      }
    } finally {
      webView.destroy()
    }
  }
}
