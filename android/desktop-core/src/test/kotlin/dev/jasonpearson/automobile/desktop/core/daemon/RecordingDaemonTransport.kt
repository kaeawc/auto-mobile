package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * In-memory daemon that records `method` and the `setActiveDevice` device ids it receives and
 * answers every call successfully, with per-call failure injection.
 */
internal class RecordingDaemonTransport(private val rejectBindsUntilAttempt: Int = 0) :
  DaemonRequestTransport {
  private val calls = CopyOnWriteArrayList<Pair<String, String?>>()
  private val failures = CopyOnWriteArrayList<String>()
  private var bindAttempts = 0

  fun failNext(key: String) {
    failures.add(key)
  }

  fun count(method: String) = calls.count { it.first == method }

  fun boundDevices(): List<String> =
    calls.filter { it.second != null }.map { requireNotNull(it.second) }

  override fun send(request: DaemonRequest): DaemonResponse {
    val tool = request.params["name"]?.jsonPrimitive?.content
    val key = if (tool != null) "${request.method}:$tool" else request.method
    val device =
      if (tool == "setActiveDevice") {
        request.params["arguments"]?.jsonObject?.get("deviceId")?.jsonPrimitive?.content
      } else {
        null
      }
    calls.add(request.method to device)
    if (failures.remove(key)) {
      return DaemonResponse(
        id = request.id,
        type = "mcp_response",
        success = false,
        error = "daemon unavailable",
      )
    }
    return DaemonResponse(
      id = request.id,
      type = "mcp_response",
      success = true,
      result = DaemonJson.parseToJsonElement(resultFor(key)),
    )
  }

  private fun resultFor(key: String): String =
    when (key) {
      "tools/call:setActiveDevice" -> {
        bindAttempts++
        val success = bindAttempts >= rejectBindsUntilAttempt
        """{"content":[{"type":"text","text":"{\"success\":$success}"}]}"""
      }
      "daemon/registerSession" ->
        """{"accepted":true,"heartbeatTimeoutMs":10000,"expiresAtMs":12345}"""
      else -> "{}"
    }
}
