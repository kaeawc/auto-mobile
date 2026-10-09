package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * In-memory daemon that records `method` and the `setActiveDevice` device ids it receives and
 * answers every call successfully, with per-call failure injection.
 *
 * Its daemon answers (bind success, ownership refusal, non-ownership error, terminal session,
 * registration, not-found heartbeat) are the REAL daemon's, taken from the desktop wire fixtures
 * `test/daemon/desktopWireContract.test.ts` generates (#10669), so they cannot drift from what the
 * handlers send.
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

  /**
   * Overrides the `releaseReason` a [releasedSessions] heartbeat answer carries (#10730); "" omits
   * it.
   */
  val releaseReasons: MutableMap<String, String> = java.util.concurrent.ConcurrentHashMap()

  /** Methods that fail like an unreachable daemon on every call until removed (#11072). */
  val unavailable: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

  /** Runs at the start of each request with its key, to model a slow call on the fake clock. */
  @Volatile var onSend: (String) -> Unit = {}

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
    onSend(key)
    calls.add(request.method to device)
    val sessionId = request.params["sessionId"]?.jsonPrimitive?.content
    sessionCalls.add(request.method to sessionId)
    if (key == "daemon/heartbeat" && sessionId in releasedSessions) {
      val answer = WireAnswers.sessionNotFound.response(request.id)
      return if (sessionId in releaseReasons) {
        answer.copy(releaseReason = releaseReasons[sessionId]?.ifEmpty { null })
      } else {
        answer
      }
    }
    if (failures.remove(key) || key in unavailable) {
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
      "daemon/registerSession" -> WireAnswers.registered.result.toString()
      else -> "{}"
    }

  private fun bindResult(request: DaemonRequest, device: String?): String {
    val session =
      request.params["arguments"]?.jsonObject?.get("sessionUuid")?.jsonPrimitive?.content
    return when {
      session in releasedSessions -> WireAnswers.sessionReleased.result.toString()
      heldByAnotherSession || device in heldDeviceIds -> WireAnswers.heldRefusal(device)
      unrelatedBindFailures > 0 -> {
        unrelatedBindFailures--
        WireAnswers.deviceNotFound.result.toString()
      }
      else -> {
        bindAttempts++
        if (bindAttempts >= rejectBindsUntilAttempt) {
          WireAnswers.bound.result.toString()
        } else {
          // Not a daemon answer: a decodable result reporting failure, for the client's retry path.
          """{"content":[{"type":"text","text":"{\"success\":false}"}]}"""
        }
      }
    }
  }
}

/** The real daemon answers, from the desktop wire fixtures (#10669). */
private object WireAnswers {
  val bound = DesktopWireFixture.load("first-tap-binds-device").exchange("bind")
  val registered = DesktopWireFixture.load("no-click-start").exchange("register")
  val sessionNotFound = DesktopWireFixture.load("heartbeat-expiry").exchange("heartbeat-lapse")
  val sessionReleased =
    DesktopWireFixture.load("released-session-tap").exchange("bind-refused-released")
  val deviceNotFound = DesktopWireFixture.load("bind-error-not-ownership").exchange("bind-error-1")

  /** `assertDeviceOwner`'s refusal, recorded for both devices these tests pick. */
  private val refusals =
    listOf(
        DesktopWireFixture.load("held-by-another-session").exchange("bind-refused"),
        DesktopWireFixture.load("tap-held-device-releases-previous").exchange("bind-held-refused"),
      )
      .associateBy {
        it.params.getValue("arguments").jsonObject.getValue("deviceId").jsonPrimitive.content
      }

  fun heldRefusal(device: String?): String =
    requireNotNull(refusals[device]) { "No recorded ownership refusal for $device" }
      .result
      .toString()
}
