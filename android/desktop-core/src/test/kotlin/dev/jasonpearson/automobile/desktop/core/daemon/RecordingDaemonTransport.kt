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
  private val sessionCalls = CopyOnWriteArrayList<Pair<String, String?>>()
  private val failures = CopyOnWriteArrayList<String>()
  private var bindAttempts = 0

  /**
   * While true, every `setActiveDevice` is refused the way the daemon refuses a device another live
   * session owns: an `isError` tool result naming the holder (#10660). Flip it to false to model
   * the holder releasing the device.
   */
  @Volatile var heldByAnotherSession: Boolean = false

  /** Devices another live session holds; binding one is refused like [heldByAnotherSession]. */
  val heldDeviceIds: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

  /**
   * The next this-many `setActiveDevice` calls fail the way an unrelated daemon error does
   * (#10682): an `isError` tool result that is NOT an ownership refusal.
   */
  @Volatile var unrelatedBindFailures: Int = 0

  /**
   * Session UUIDs the daemon has terminally released (idle release, #10682 C4): their heartbeat is
   * "Session not found" and their `setActiveDevice` is `session_ownership_lost`.
   */
  val releasedSessions: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

  fun failNext(key: String) {
    failures.add(key)
  }

  fun count(method: String) = calls.count { it.first == method }

  /** Session ids carried by [method] requests, in order (#10659). */
  fun sessionsFor(method: String): List<String?> =
    sessionCalls.filter { it.first == method }.map { it.second }

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
    val sessionId = request.params["sessionId"]?.jsonPrimitive?.content
    sessionCalls.add(request.method to sessionId)
    if (failures.remove(key) || (key == "daemon/heartbeat" && sessionId in releasedSessions)) {
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
      result = DaemonJson.parseToJsonElement(resultFor(key, request, device)),
    )
  }

  private fun resultFor(key: String, request: DaemonRequest, device: String?): String =
    when (key) {
      "tools/call:setActiveDevice" -> bindResult(request, device)
      "daemon/registerSession" ->
        """{"accepted":true,"heartbeatTimeoutMs":10000,"expiresAtMs":12345}"""
      else -> "{}"
    }

  private fun bindResult(request: DaemonRequest, device: String?): String {
    val session =
      request.params["arguments"]?.jsonObject?.get("sessionUuid")?.jsonPrimitive?.content
    return when {
      session in releasedSessions -> OWNERSHIP_LOST
      heldByAnotherSession || device in heldDeviceIds -> heldRefusal(device)
      unrelatedBindFailures > 0 -> {
        unrelatedBindFailures--
        DEVICE_NOT_FOUND
      }
      else -> {
        bindAttempts++
        val success = bindAttempts >= rejectBindsUntilAttempt
        """{"content":[{"type":"text","text":"{\"success\":$success}"}]}"""
      }
    }
  }
}

// Shapes from src/server/setActiveDevice.ts (assertDeviceOwner, requestedPoolDevice) via
// shapeToolCallError's `Error: <message>` text, and src/server/index.ts's TerminalSessionError
// branch (sessionOwnershipLostPayload).
private fun heldRefusal(device: String?) =
  """{"isError":true,"content":[{"type":"text","text":""" +
    """"Error: Device '$device' is already assigned to session agent-session"}]}"""

private const val DEVICE_NOT_FOUND =
  """{"isError":true,"content":[{"type":"text","text":""" +
    """"Error: Device 'emulator-5554' not found in device pool"}]}"""

private const val OWNERSHIP_LOST =
  """{"isError":true,"content":[{"type":"text","text":""" +
    """"{\"error\":{\"code\":\"session_ownership_lost\",\"message\":\"Session s is """ +
    """terminal after idle-timeout and cannot be reused.\",\"retryable\":true}}"}]}"""
