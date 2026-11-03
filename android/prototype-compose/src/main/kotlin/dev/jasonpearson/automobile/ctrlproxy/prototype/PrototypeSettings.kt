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
import kotlinx.serialization.json.put

/** The closed `settings.open` page list; a spec can never name a package. */
enum class SettingsPage(val wireValue: String) {
  APP("app"),
  NOTIFICATIONS("notifications"),
  LOCATION("location"),
  WIFI("wifi"),
  BLUETOOTH("bluetooth"),
  DISPLAY("display");

  companion object {
    fun parse(value: String?): SettingsPage? = entries.firstOrNull { it.wireValue == value }
  }
}

/** What a [SettingsOpener] did with one page. */
sealed interface SettingsOpenResult {
  /**
   * [fallback] means the exact page does not exist on this OS version and a broader page opened
   * instead. [handler] is the resolved package, when the platform names one.
   */
  data class Opened(val fallback: Boolean, val handler: String?) : SettingsOpenResult

  /** No installed Settings app handles the page. */
  data object Unavailable : SettingsOpenResult
}

/** Opens one settings page for the runtime's own package; the Android opener lives in CtrlProxy. */
fun interface SettingsOpener {
  fun open(page: SettingsPage): SettingsOpenResult
}

/** `settings.open` (#14320). The contract has already checked `page` against the closed list. */
class PrototypeSettingsModule(private val opener: SettingsOpener) : PrototypePlatformModule {
  override val name = "settings"
  override val capability = "prototype_platform_settings_v1"
  override val events = emptyFlow<PlatformEvent>()
  override val state = MutableStateFlow(JsonObject(emptyMap())).asStateFlow()

  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    if (call.call != "settings.open") return failure(PlatformErrorCode.UNSUPPORTED, "Unknown call")
    val raw = (call.args["page"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val page =
      SettingsPage.parse(raw)
        ?: return failure(
          PlatformErrorCode.INVALID_ARGS,
          "page must be one of ${SettingsPage.entries.joinToString { it.wireValue }}",
        )
    return when (val result = opener.open(page)) {
      SettingsOpenResult.Unavailable ->
        failure(PlatformErrorCode.UNAVAILABLE, "No settings app opens the ${page.wireValue} page")
      is SettingsOpenResult.Opened ->
        PlatformCallResult.Success(
          buildJsonObject {
            put("outcome", if (result.fallback) "fallback" else "opened")
            put("page", page.wireValue)
            result.handler?.let { put("handler", it) }
          },
        )
    }
  }

  override fun close() = Unit

  private fun failure(code: PlatformErrorCode, message: String) =
    PlatformCallResult.Failure(PlatformError(code, message))
}
