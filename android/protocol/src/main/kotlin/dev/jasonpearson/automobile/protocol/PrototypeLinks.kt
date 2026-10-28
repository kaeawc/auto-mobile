package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Cross-argument `links.open` rule. Custom Tabs and SFSafariViewController load only web pages, so
 * `inApp` needs an http(s) URL. A spec's bound arguments are checked once the runtime resolves them.
 */
object PrototypeLinks {
  const val IN_APP_MESSAGE = "links.open mode inApp requires an http or https url"
  private val webUrl = Regex("^https?:")

  fun argumentsError(
    args: JsonObject,
    path: String,
    resolved: Boolean = false,
  ): PrototypeSpecError? {
    fun literal(name: String): String? =
      if (resolved) (args[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
      else (args[name] as? JsonObject)?.text("value")
    val url = literal("url") ?: return null
    if (literal("mode") != "inApp" || webUrl.containsMatchIn(url)) return null
    return fail(if (resolved) "$path.mode" else "$path.mode.value", IN_APP_MESSAGE)
  }
}
