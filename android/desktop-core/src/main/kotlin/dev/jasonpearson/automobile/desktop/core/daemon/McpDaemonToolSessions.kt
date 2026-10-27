package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

internal fun McpDaemonClient.recordResultMintedSession(toolName: String, result: JsonElement) {
  if (toolName !in DEVICE_SESSION_ACQUISITION_TOOLS) return
  val content = (result as? JsonObject)?.get("content") as? JsonArray ?: return
  val text =
    content
      .mapNotNull { it as? JsonObject }
      .firstOrNull { it["type"]?.jsonPrimitive?.contentOrNull == "text" }
      ?.get("text")
      ?.jsonPrimitive
      ?.contentOrNull ?: return
  val payload = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
  val runtime = payload["runtime"] as? JsonObject
  val session = runtime?.get("session") as? JsonObject
  val minted =
    (session?.get("sessionUuid") as? JsonPrimitive)?.contentOrNull
      ?: (payload["sessionId"] as? JsonPrimitive)?.contentOrNull
  if (!minted.isNullOrBlank()) {
    ownedSessionUuids.add(minted)
  }
}
