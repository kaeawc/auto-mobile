package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PlatformEvent
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * `links.open` modes; `auto` prefers an in-app browser and quietly opens externally without one.
 */
enum class LinkMode(val wireValue: String) {
  EXTERNAL("external"),
  IN_APP("inApp"),
  AUTO("auto");

  companion object {
    fun parse(value: String?): LinkMode? = entries.firstOrNull { it.wireValue == value }
  }
}

/** What a [UrlOpener] did with one URL. */
sealed interface LinkOpenResult {
  /**
   * [mode] is how it opened (`external` or `inApp`); [fallback] means `inApp` was asked for but no
   * in-app browser exists. [handler] is the resolved package, when the platform names one.
   */
  data class Opened(val mode: LinkMode, val fallback: Boolean, val handler: String?) :
    LinkOpenResult

  /** No installed app handles the URL. */
  data object Unavailable : LinkOpenResult
}

/** Opens a validated `links.open` URL; the Android opener lives in CtrlProxy. */
fun interface UrlOpener {
  fun open(url: String, mode: LinkMode): LinkOpenResult
}

/** `links.open` (#14238). The contract has already checked the scheme allowlist and mode. */
class PrototypeLinksModule(private val opener: UrlOpener) : PrototypePlatformModule {
  override val name = "links"
  override val capability = "prototype_platform_links_v1"
  override val events = emptyFlow<PlatformEvent>()
  override val state = MutableStateFlow(JsonObject(emptyMap())).asStateFlow()

  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    if (call.call != "links.open") return failure(PlatformErrorCode.UNSUPPORTED, "Unknown call")
    val url =
      (call.args["url"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: return failure(PlatformErrorCode.INVALID_ARGS, "url is required")
    val requested = (call.args["mode"] as? JsonPrimitive)?.contentOrNull
    val mode =
      if (requested == null) LinkMode.AUTO
      else
        LinkMode.parse(requested)
          ?: return failure(PlatformErrorCode.INVALID_ARGS, "mode must be external, inApp or auto")
    return when (val result = opener.open(url, mode)) {
      LinkOpenResult.Unavailable ->
        failure(PlatformErrorCode.UNAVAILABLE, "No installed app opens ${scheme(url)} links")
      is LinkOpenResult.Opened ->
        PlatformCallResult.Success(
          buildJsonObject {
            put("outcome", if (result.fallback) "fallback" else "opened")
            put("url", url.take(MAX_RESULT_URL_CHARS))
            put("mode", result.mode.wireValue)
            result.handler?.let { put("handler", it) }
          },
        )
    }
  }

  override fun close() = Unit

  private fun scheme(url: String) = url.substringBefore(':')

  private fun failure(code: PlatformErrorCode, message: String) =
    PlatformCallResult.Failure(PlatformError(code, message))

  companion object {
    const val MAX_RESULT_URL_CHARS = 2048
  }
}
