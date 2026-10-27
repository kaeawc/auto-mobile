package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * Routes internal budget announcements separately from responses and ignores other notifications.
 */
internal class DaemonInboundFrames(
  private val onResponse: (DaemonResponse) -> Unit,
  private val onBudget: (String, Long) -> Unit,
) {
  private val json = Json { ignoreUnknownKeys = true }

  fun handle(line: String) {
    val frame = json.parseToJsonElement(line).jsonObject
    if (frame["type"] == JsonPrimitive("daemon_notification")) {
      if (frame["method"] == JsonPrimitive("notifications/automobile/requestBudget")) {
        val requestId = frame["requestId"] as? JsonPrimitive
        val timeout = frame["timeoutMs"] as? JsonPrimitive
        val timeoutMs = timeout?.takeUnless { it.isString }?.longOrNull
        if (requestId?.isString == true && timeoutMs != null) {
          onBudget(requestId.content, timeoutMs)
        }
      }
      return
    }
    onResponse(json.decodeFromJsonElement(DaemonResponse.serializer(), frame))
  }
}
