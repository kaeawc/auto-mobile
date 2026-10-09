package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * The two `setActiveDevice` refusals the desktop session loop acts on (#10682). Every other failure
 * (device not found, device cleanup still running, a CtrlProxy resume failure, a decode error) is
 * an ordinary bind error: it is retried a bounded number of times and then surfaced, never treated
 * as "another session holds the device".
 */
enum class SetActiveDeviceRefusal {
  /**
   * Another live session owns the device. The daemon refuses before rebinding, so this session
   * keeps whatever it held (`assertDeviceOwner` and `bindRequestedDevice` in
   * `src/server/setActiveDevice.ts`).
   */
  HELD_BY_ANOTHER_SESSION,

  /**
   * This session UUID is terminal on the daemon (released, idle-released or heartbeat-expired) and
   * can never bind again; only a fresh UUID can (`TerminalSessionError`).
   */
  SESSION_RELEASED,
}

private const val SESSION_OWNERSHIP_LOST_CODE = "session_ownership_lost"

// The daemon's typed ownership refusal (#10832): `setActiveDevice` and the pool bind carry
// [DEVICE_OWNED_BY_OTHER_SESSION_CODE] as a top-level `code` in the tool error payload, like
// `input/*` and device-aware `tools/call`. Older daemons sent ownership refusals as plain
// text, and the autolock wordings still are, so those wordings are matched as a fallback:
//  - `Device '<id>' is already assigned to session <uuid>` (src/server/setActiveDevice.ts,
//    src/daemon/devicePool.ts)
//  - `Device '<id>' is already assigned to another session.` (devicePool.ts,
//    deviceAutolockManager.ts)
//  - `Device '<id>' is locked to another session.` (deviceAutolockManager.ts)
// The id is matched with `.+` because a device id may itself contain a quote.
private val HELD_BY_ANOTHER_SESSION_MESSAGE =
  Regex(
    """Device '.+' is (?:already assigned to (?:session |another session)|locked to another session)""",
  )

// `TerminalSessionError`, which `toActionableError` may wrap into a plain text error.
private val TERMINAL_SESSION_MESSAGE =
  Regex("""Session \S+ (?:was released and|is terminal after .+? and) cannot be reused""")

/**
 * Classifies a failed `setActiveDevice` tool response by the daemon's own error shape, or returns
 * null when it is neither an ownership refusal nor a terminal session.
 */
internal fun classifySetActiveDeviceRefusal(
  json: Json,
  response: JsonElement,
): SetActiveDeviceRefusal? {
  val envelope = response as? JsonObject ?: return null
  if ((envelope["isError"] as? JsonPrimitive)?.booleanOrNull != true) return null
  val text =
    (envelope["content"] as? JsonArray)
      ?.mapNotNull { it as? JsonObject }
      ?.firstOrNull { (it["type"] as? JsonPrimitive)?.contentOrNull == "text" }
      ?.let { (it["text"] as? JsonPrimitive)?.contentOrNull } ?: return null
  val payload = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject
  val code = ((payload?.get("error") as? JsonObject)?.get("code") as? JsonPrimitive)?.contentOrNull
  val topLevelCode = (payload?.get("code") as? JsonPrimitive)?.contentOrNull
  return when {
    code == SESSION_OWNERSHIP_LOST_CODE -> SetActiveDeviceRefusal.SESSION_RELEASED
    topLevelCode == DEVICE_OWNED_BY_OTHER_SESSION_CODE ->
      SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION
    TERMINAL_SESSION_MESSAGE.containsMatchIn(text) -> SetActiveDeviceRefusal.SESSION_RELEASED
    HELD_BY_ANOTHER_SESSION_MESSAGE.containsMatchIn(text) ->
      SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION
    else -> null
  }
}
