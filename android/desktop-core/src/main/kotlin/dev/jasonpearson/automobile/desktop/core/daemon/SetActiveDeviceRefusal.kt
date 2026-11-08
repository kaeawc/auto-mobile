package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * The `setActiveDevice` refusals the desktop session loop acts on (#10682, #11365). Every other
 * failure (device not found, device cleanup still running, a CtrlProxy resume failure, a suspect
 * session being restored, a decode error) is an ordinary bind error: it is retried a bounded number
 * of times and then surfaced, never treated as "held elsewhere".
 */
enum class SetActiveDeviceRefusal(
  /**
   * The device is held by someone else: the pane shows it as held elsewhere and the session never
   * re-sends the bind on its own, whatever the wire's `retryable` says (owner decision
   * 2026-11-07, #11365). Only the user's explicit Take control makes one more attempt.
   */
  val heldElsewhere: Boolean = false,
) {
  /**
   * Another live session owns the device. The daemon refuses before rebinding, so this session
   * keeps whatever it held (`assertDeviceOwner` and `bindRequestedDevice` in
   * `src/server/setActiveDevice.ts`).
   */
  HELD_BY_ANOTHER_SESSION(heldElsewhere = true),

  /**
   * Another AutoMobile daemon claims the device (`device_owned_by_other_daemon`). The wire marks it
   * `retryable` with a `retryAfterMs`, but the desktop never retries it automatically (#11365).
   */
  HELD_BY_ANOTHER_DAEMON(heldElsewhere = true),

  /**
   * The device is reserved for a declared binding (`device_assigned_to_binding`, `retryable:
   * false`); it stays reserved while idle until that binding's scope is reset.
   */
  ASSIGNED_TO_BINDING(heldElsewhere = true),

  /**
   * This session UUID is terminal on the daemon (released, idle-released or heartbeat-expired) and
   * can never bind again; only a fresh UUID can (`TerminalSessionError`).
   */
  SESSION_RELEASED,
}

/** Who holds a device the desktop shows as held elsewhere, for the pane's notice (#11365). */
sealed interface HeldElsewhereHolder {
  /** Another live session on this daemon. */
  data object AnotherSession : HeldElsewhereHolder

  /** Another AutoMobile daemon; [pid] when the refusal names it. */
  data class AnotherDaemon(val pid: Long?) : HeldElsewhereHolder

  /** A declared binding; [declaredBinding] is its index when the refusal carries it. */
  data class Binding(val declaredBinding: Long?) : HeldElsewhereHolder
}

internal const val DEVICE_OWNED_BY_OTHER_DAEMON_CODE = "device_owned_by_other_daemon"
internal const val DEVICE_ASSIGNED_TO_BINDING_CODE = "device_assigned_to_binding"

// `DeviceOwnedByOtherDaemonError` names the owner's PID only in its message:
// `... claimed by another AutoMobile daemon (PID 4242) ...`.
private val OTHER_DAEMON_PID_MESSAGE = Regex("""another AutoMobile daemon \(PID (\d+)\)""")

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
): SetActiveDeviceRefusal? = refusalTextOf(response)?.let { classifyRefusalText(json, it) }

/**
 * Who holds the device, for a failed `setActiveDevice` response that
 * [classifySetActiveDeviceRefusal] classifies as held elsewhere; null for every other response.
 */
internal fun heldElsewhereHolderOf(json: Json, response: JsonElement): HeldElsewhereHolder? {
  val text = refusalTextOf(response) ?: return null
  val payload = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject
  return when (classifyRefusalText(json, text)) {
    SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION -> HeldElsewhereHolder.AnotherSession
    SetActiveDeviceRefusal.HELD_BY_ANOTHER_DAEMON ->
      HeldElsewhereHolder.AnotherDaemon(
        payload?.let { refusalPrimitive(it, "ownerPid")?.longOrNull }
          ?: OTHER_DAEMON_PID_MESSAGE.find(text)?.groupValues?.get(1)?.toLongOrNull(),
      )
    SetActiveDeviceRefusal.ASSIGNED_TO_BINDING ->
      HeldElsewhereHolder.Binding(
        payload?.let { refusalPrimitive(it, "declaredBinding")?.longOrNull },
      )
    SetActiveDeviceRefusal.SESSION_RELEASED,
    null -> null
  }
}

private fun refusalTextOf(response: JsonElement): String? {
  val envelope = response as? JsonObject ?: return null
  if ((envelope["isError"] as? JsonPrimitive)?.booleanOrNull != true) return null
  return refusalText(envelope)
}

private fun refusalText(envelope: JsonObject): String? =
  (envelope["content"] as? JsonArray)
    ?.mapNotNull { it as? JsonObject }
    ?.firstOrNull { (it["type"] as? JsonPrimitive)?.contentOrNull == "text" }
    ?.let { (it["text"] as? JsonPrimitive)?.contentOrNull }

private fun classifyRefusalText(json: Json, text: String): SetActiveDeviceRefusal? {
  val payload = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject
  val code = ((payload?.get("error") as? JsonObject)?.get("code") as? JsonPrimitive)?.contentOrNull
  val topLevelCode = (payload?.get("code") as? JsonPrimitive)?.contentOrNull
  val retryable = payload?.let { refusalPrimitive(it, "retryable")?.booleanOrNull }
  // The daemon's contract: every terminal session loss says `nextAction: acquire_new_session`
  // with `retryable: false`, in either payload shape. A retryable refusal is never terminal.
  val terminalByContract =
    payload?.let { refusalString(it, "nextAction") } == NEXT_ACTION_ACQUIRE_NEW_SESSION &&
      retryable != true
  return when {
    terminalByContract -> SetActiveDeviceRefusal.SESSION_RELEASED
    // Fallback for daemons that predate `nextAction` on the ownership-lost refusal.
    code == SESSION_OWNERSHIP_LOST_CODE && retryable != true ->
      SetActiveDeviceRefusal.SESSION_RELEASED
    topLevelCode == DEVICE_OWNED_BY_OTHER_SESSION_CODE ->
      SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION
    topLevelCode == DEVICE_OWNED_BY_OTHER_DAEMON_CODE ->
      SetActiveDeviceRefusal.HELD_BY_ANOTHER_DAEMON
    topLevelCode == DEVICE_ASSIGNED_TO_BINDING_CODE -> SetActiveDeviceRefusal.ASSIGNED_TO_BINDING
    TERMINAL_SESSION_MESSAGE.containsMatchIn(text) -> SetActiveDeviceRefusal.SESSION_RELEASED
    HELD_BY_ANOTHER_SESSION_MESSAGE.containsMatchIn(text) ->
      SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION
    else -> null
  }
}
