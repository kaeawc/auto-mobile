package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import dev.jasonpearson.automobile.protocol.PrototypeWebViewNode

@Composable
internal fun RenderPrototypeWebView(
  rendered: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val node = rendered.source as? PrototypeWebViewNode ?: return
  val module =
    LocalPrototypeStackRuntime.current
      ?.platformRegistry
      ?.modules
      ?.filterIsInstance<PrototypeWebViewModule>()
      ?.firstOrNull()
  if (module == null) {
    Box(modifier)
    LaunchedEffect(node) {
      PrototypeWebViewNavigation(node, UnavailableWebPage, interact).failed()
    }
    return
  }

  key(module, node.id, node.allowedOrigins) {
    AndroidView(
      modifier = modifier,
      factory = { context -> PrototypePageView(context, node, module, interact) },
      update = { it.update(node, rendered.text, interact) },
      onReset = null,
      onRelease = { it.release() },
    )
  }
}

private object UnavailableWebPage : PrototypeWebPage {
  override val canGoBack = false
  override val title = ""

  override fun load(url: String) = Unit

  override fun back() = Unit

  override fun reload() = Unit
}

@Suppress("DEPRECATION", "UnusedParameter") // The same policy applies to both authored JS settings.
internal fun configurePrototypeWebView(view: WebView, node: PrototypeWebViewNode) {
  with(view.settings) {
    javaScriptEnabled = false
    domStorageEnabled = false
    allowFileAccess = false
    allowContentAccess = false
    allowFileAccessFromFileURLs = false
    allowUniversalAccessFromFileURLs = false
    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    setSupportMultipleWindows(false)
    javaScriptCanOpenWindowsAutomatically = false
    setGeolocationEnabled(false)
    saveFormData = false
    savePassword = false
    cacheMode = WebSettings.LOAD_NO_CACHE
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = false
  }
  view.webChromeClient =
    object : WebChromeClient() {
      override fun onPermissionRequest(request: PermissionRequest) = request.deny()

      override fun onGeolocationPermissionsShowPrompt(
        origin: String,
        callback: GeolocationPermissions.Callback,
      ) = callback.invoke(origin, false, false)
    }
}

// Built only in code, never inflated from XML.
@SuppressLint("ViewConstructor")
private class PrototypePageView(
  context: Context,
  node: PrototypeWebViewNode,
  private val module: PrototypeWebViewModule,
  interact: (PrototypeInteraction) -> Unit,
) : WebView(context) {
  private val nodeId = node.id
  private val page: PrototypeWebPage =
    object : PrototypeWebPage {
      override val canGoBack: Boolean
        get() = canGoBack()

      override val title: String
        get() = this@PrototypePageView.title.orEmpty()

      override fun load(url: String) = loadUrl(url)

      override fun back() {
        val history = copyBackForwardList()
        val target = history.getItemAtIndex(history.currentIndex - 1)?.url ?: return
        if (client.beginNavigation(target, fromHistory = true)) goBack()
      }

      override fun reload() {
        val target = this@PrototypePageView.url ?: return
        if (client.beginNavigation(target)) this@PrototypePageView.reload()
      }
    }
  private val client = PrototypeWebViewClient(node, module, page, interact)

  init {
    configurePrototypeWebView(this, node)
    webViewClient = client
  }

  fun update(node: PrototypeWebViewNode, url: String, interact: (PrototypeInteraction) -> Unit) {
    client.update(this, node, url, interact)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    module.attach(nodeId, page)
  }

  override fun onDetachedFromWindow() {
    module.detach(nodeId, page)
    super.onDetachedFromWindow()
  }

  fun release() {
    module.detach(nodeId, page)
    client.release()
    stopLoading()
    clearHistory()
    removeAllViews()
    (parent as? ViewGroup)?.removeView(this)
    destroy()
  }
}
