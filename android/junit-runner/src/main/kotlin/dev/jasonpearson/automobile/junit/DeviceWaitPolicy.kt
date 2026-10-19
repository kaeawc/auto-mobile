package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonToolResultParser.ParsedToolResult
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

internal object DeviceWaitPolicy {
  /**
   * `nextAction` of a terminal-session refusal: acquire a new session, never retry the UUID
   * (#11098).
   */
  internal const val ACQUIRE_NEW_SESSION_NEXT_ACTION = "acquire_new_session"

  /** Typed code for a device-mutating call refused because another session holds it (#10783). */
  internal const val DEVICE_OWNED_BY_OTHER_SESSION_CODE = "device_owned_by_other_session"

  /**
   * Typed code for a bind refused while the device's previous session finishes cleanup (#10960).
   */
  internal const val DEVICE_CLEANUP_IN_PROGRESS_CODE = "device_cleanup_in_progress"

  /** Typed code for a bind refused because another AutoMobile daemon claims the device (#10980). */
  internal const val DEVICE_OWNED_BY_OTHER_DAEMON_CODE = "device_owned_by_other_daemon"

  /** Typed code for a bind refused while the device is under a kill reservation (#11088). */
  internal const val DEVICE_SHUTTING_DOWN_CODE = "device_shutting_down"

  /** Typed code for acquisition refused because device health is marked unhealthy (#12112). */
  internal const val DEVICE_UNHEALTHY_CODE = "device_unhealthy"

  /** Typed code for a call refused while its session's device is recovering (#12113). */
  internal const val SESSION_HELD_BY_RECOVERY_CODE = "session_held_by_recovery"

  internal val RECOVERY_CODES = setOf(DEVICE_UNHEALTHY_CODE, SESSION_HELD_BY_RECOVERY_CODE)

  /** Refusals the runner waits out with the bounded held-device wait. */
  private val DEVICE_WAIT_CODES =
    setOf(
      DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      DEVICE_CLEANUP_IN_PROGRESS_CODE,
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      DEVICE_SHUTTING_DOWN_CODE,
    )

  /**
   * Typed codes that wait only when the daemon marks the refusal retryable (iOS parity, #11202).
   */
  internal const val CAPACITY_EXHAUSTED_CODE = "capacity_exhausted"
  internal const val DISCOVERY_INCOMPLETE_CODE = "discovery_incomplete"

  private val RETRYABLE_WAIT_CODES =
    setOf(CAPACITY_EXHAUSTED_CODE, DISCOVERY_INCOMPLETE_CODE, SESSION_HELD_BY_RECOVERY_CODE)

  /**
   * Whether the runner waits out this refusal within the bounded device wait: the held-device codes
   * always, capacity, discovery and session recovery only when retryable. Unhealthy devices also
   * require an explicit recovering boolean.
   */
  internal fun waitsForDevice(parsed: ParsedToolResult): Boolean {
    val code = parsed.code ?: return false
    return code in DEVICE_WAIT_CODES ||
      (parsed.retryable &&
        (code in RETRYABLE_WAIT_CODES || (code == DEVICE_UNHEALTHY_CODE && parsed.recovering)))
  }

  private const val DEVICE_OWNED_INITIAL_DELAY_MS = 500L
  private const val DEVICE_OWNED_MAX_DELAY_MS = 4_000L

  /**
   * Longest the runner waits on a recording-finalize refusal (#11360). The daemon advertises its
   * real finalize cap (about 125 s) in `retryAfterMs`; this bounds a runaway hint. It is the
   * `finalizeWait.waitBudgetMs` of `test/fixtures/refusal-wire-hints/hints.json`, shared with the
   * MCP proxy and XCTestRunner.
   */
  internal const val DEVICE_FINALIZE_WAIT_CAP_MS = 150_000L

  /** Refusals whose `retryAfterMs` is the daemon's real finalize time, not a polling hint. */
  internal val FINALIZE_WAIT_CODES =
    setOf(DEVICE_CLEANUP_IN_PROGRESS_CODE, DEVICE_SHUTTING_DOWN_CODE)

  /**
   * A `retryAfterMs` hint as the runners use it: absent when zero or negative (as when missing),
   * otherwise clamped to [DEVICE_FINALIZE_WAIT_CAP_MS] so adding it to a waited time cannot
   * overflow (#11544). Swift's `DeviceWaitBackoff.usableHintMs` does the same.
   */
  internal fun positiveRetryAfterMs(retryAfterMs: Long?): Long? =
    retryAfterMs?.takeIf { it > 0 }?.coerceAtMost(DEVICE_FINALIZE_WAIT_CAP_MS)

  /** The usable hint of a wire `retryAfterMs` element: only a whole JSON number counts. */
  internal fun retryAfterHintMs(wire: JsonElement?): Long? =
    positiveRetryAfterMs((wire as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull)

  /**
   * Total wait budget for this refusal. For the finalize codes the daemon's `retryAfterMs` is the
   * finalize time STILL REMAINING, so it bounds the total: [waitedMs] already spent plus that hint,
   * clamped to [DEVICE_FINALIZE_WAIT_CAP_MS] and never below
   * [PlanExecutorTimings.deviceOwnedWaitBudgetMs] (#11360, #11538). Every other code, and a refusal
   * with no hint, keeps the plain budget.
   */
  private fun deviceOwnedBudgetMs(
    waitedMs: Long,
    retryAfterMs: Long?,
    code: String?,
    timings: PlanExecutorTimings,
  ): Long {
    val hintMs = positiveRetryAfterMs(retryAfterMs)
    if (code !in FINALIZE_WAIT_CODES || hintMs == null) return timings.deviceOwnedWaitBudgetMs
    // The hint is clamped before the addition so a hint near Long.MAX_VALUE cannot wrap negative.
    val untilFinalized = minOf(waitedMs + hintMs, DEVICE_FINALIZE_WAIT_CAP_MS)
    return maxOf(timings.deviceOwnedWaitBudgetMs, untilFinalized)
  }

  /**
   * Exponential delay (500ms doubling, capped at 4s) for the next wait on a held device, clamped to
   * the remaining budget; null once the budget is spent. For the finalize codes ([code]) the
   * daemon's `retryAfterMs` only bounds the total wait (up to 150 s, #11360); each step stays at
   * the ordinary backoff so a finalize that finishes early is noticed on the next poll (#11538).
   * For every other code a hint lengthens a step and never extends
   * [PlanExecutorTimings.deviceOwnedWaitBudgetMs].
   */
  internal fun deviceOwnedBackoffDelayMs(
    waitsSoFar: Int,
    waitedMs: Long,
    retryAfterMs: Long? = null,
    code: String? = null,
    timings: PlanExecutorTimings = PlanExecutorTimings(),
  ): Long? {
    val remaining = deviceOwnedBudgetMs(waitedMs, retryAfterMs, code, timings) - waitedMs
    if (remaining <= 0) return null
    val doubled = DEVICE_OWNED_INITIAL_DELAY_MS shl waitsSoFar.coerceAtMost(8)
    val backoff = minOf(doubled, DEVICE_OWNED_MAX_DELAY_MS)
    val hint = if (code in FINALIZE_WAIT_CODES) 0L else positiveRetryAfterMs(retryAfterMs) ?: 0L
    return minOf(maxOf(backoff, hint), remaining)
  }

  internal fun deviceOwnedGiveUpMessage(parsed: ParsedToolResult, waitedMs: Long): String {
    if (parsed.code in RECOVERY_CODES) {
      val lead =
        if (parsed.code == DEVICE_UNHEALTHY_CODE) "Device is still being recovered"
        else "Session's device is still being recovered"
      return "$lead (${parsed.code})" +
        (parsed.daemonMessage?.let { ": $it" } ?: "") +
        (if (parsed.code == DEVICE_UNHEALTHY_CODE)
          "\n${PlanFailureMessages.unhealthyDevicesMessage(parsed.unhealthyDevices)}"
        else "") +
        "\nThe runner waited ${waitedMs}ms for the recovery to finish."
    }
    return (when (parsed.code) {
      DEVICE_CLEANUP_IN_PROGRESS_CODE ->
        "Device is still finishing its previous session's cleanup ($DEVICE_CLEANUP_IN_PROGRESS_CODE)"
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE ->
        "Device is claimed by another AutoMobile daemon ($DEVICE_OWNED_BY_OTHER_DAEMON_CODE)"
      DEVICE_SHUTTING_DOWN_CODE -> "Device is shutting down ($DEVICE_SHUTTING_DOWN_CODE)"
      CAPACITY_EXHAUSTED_CODE -> "No device capacity is available ($CAPACITY_EXHAUSTED_CODE)"
      DISCOVERY_INCOMPLETE_CODE -> "Device discovery has not finished ($DISCOVERY_INCOMPLETE_CODE)"
      else -> "Device is held by another session ($DEVICE_OWNED_BY_OTHER_SESSION_CODE)"
    }) +
      (parsed.daemonMessage?.let { ": $it" } ?: "") +
      "\nThe runner waited ${waitedMs}ms for it to be released. Another test attempt or tool " +
      "session is using this device; give each concurrent test its own device, or run them " +
      "serially."
  }

  internal fun isTransientError(errorMessage: String?): Boolean {
    if (errorMessage.isNullOrBlank()) return false
    val normalized = errorMessage.lowercase()
    return normalized.contains("request timed out") ||
      normalized.contains("plan execution in progress") ||
      normalized.contains("daemon request timeout")
  }
}
