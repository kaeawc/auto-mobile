package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PlatformEvent
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal interface PrototypeWebPage {
  val canGoBack: Boolean
  val title: String

  fun load(url: String)

  fun back()

  fun reload()
}

/** Each runtime gets its own attached pages; registering the host never creates a WebView. */
@InternalAutoMobilePrototypeApi
class PrototypeWebViewModule(
  internal val fetcher: PrototypeWebFetcher,
  private val main: PrototypeMainThread = AndroidPrototypeMainThread(),
) : PrototypePlatformModule {
  private val pages = ConcurrentHashMap<String, PrototypeWebPage>()
  @Volatile
  internal var closed = false
    private set

  override val name = "webview"
  override val capability = CAPABILITY
  override val events = emptyFlow<PlatformEvent>()
  override val state = MutableStateFlow(JsonObject(emptyMap())).asStateFlow()

  override fun availability() =
    if (closed) PlatformAvailability.Unavailable("Web view module closed")
    else PlatformAvailability.Ready

  internal fun session() = PrototypeWebViewModule(fetcher, main)

  internal fun attach(id: String?, page: PrototypeWebPage) {
    if (id != null && !closed) pages[id] = page
  }

  internal fun detach(id: String?, page: PrototypeWebPage) {
    if (id != null) pages.remove(id, page)
  }

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    if (call.call != "webview.back" && call.call != "webview.reload")
      return failure(PlatformErrorCode.UNSUPPORTED, "Unknown call")
    val id =
      (call.args["node"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: return failure(PlatformErrorCode.INVALID_ARGS, "node is required")
    return main.onMain {
      val page =
        pages[id]?.takeUnless { closed }
          ?: return@onMain failure(PlatformErrorCode.UNAVAILABLE, "Web view is not attached")
      when (call.call) {
        "webview.back" -> if (page.canGoBack) page.back()
        "webview.reload" -> page.reload()
      }
      PlatformCallResult.Success(JsonNull)
    }
  }

  override fun close() {
    closed = true
    pages.clear()
  }

  private fun failure(code: PlatformErrorCode, message: String) =
    PlatformCallResult.Failure(PlatformError(code, message))

  companion object {
    const val CAPABILITY = "prototype_platform_webview_v1"
  }
}
