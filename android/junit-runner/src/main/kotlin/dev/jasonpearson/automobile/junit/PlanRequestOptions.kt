package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

internal object PlanRequestOptions {
  /**
   * Optional `executePlan` post-run cleanup (daemon `toolRegistry` `finally`). Read fresh on each
   * build so per-test property changes apply (not cached via `SystemPropertyCache`).
   *
   * **System properties** (take precedence when set):
   * - `automobile.junit.executePlan.cleanupAppId` — non-blank package → daemon cleanup after plan
   * - `automobile.junit.executePlan.cleanupClearAppData` — `true` / `1` → clear app data; unset or
   *   false → force-stop only
   *
   * **Environment** (used when the property is unset for that field):
   * - `AUTOMOBILE_EXECUTE_PLAN_CLEANUP_APP_ID`
   * - `AUTOMOBILE_EXECUTE_PLAN_CLEANUP_CLEAR_APP_DATA` — `true` / `1` / `yes`
   *
   * This is intentionally **not** on `AutoMobilePlanExecutionOptions` so apps can keep compiling
   * against an older published runner while CI jobs that publish a newer JAR get the behavior.
   */
  internal fun appendExecutePlanCleanupArgs(args: MutableMap<String, JsonElement>) {
    val cleanupAppId = resolveExecutePlanCleanupAppId()
    if (cleanupAppId.isEmpty()) {
      return
    }
    args["cleanupAppId"] = JsonPrimitive(cleanupAppId)
    if (resolveExecutePlanCleanupClearAppData()) {
      args["cleanupClearAppData"] = JsonPrimitive(true)
    }
  }

  private fun resolveExecutePlanCleanupAppId(): String {
    val prop = System.getProperty("automobile.junit.executePlan.cleanupAppId")?.trim().orEmpty()
    if (prop.isNotEmpty()) {
      return prop
    }
    return System.getenv("AUTOMOBILE_EXECUTE_PLAN_CLEANUP_APP_ID")?.trim().orEmpty()
  }

  private fun resolveExecutePlanCleanupClearAppData(): Boolean {
    val propRaw = System.getProperty("automobile.junit.executePlan.cleanupClearAppData")
    if (propRaw != null) {
      val t = propRaw.trim()
      return t.equals("true", ignoreCase = true) || t == "1"
    }
    val env =
      System.getenv("AUTOMOBILE_EXECUTE_PLAN_CLEANUP_CLEAR_APP_DATA")?.trim()?.lowercase().orEmpty()
    return env == "true" || env == "1" || env == "yes"
  }

  internal const val CAPTURE_OBSERVE_STEPS_PROPERTY =
    "automobile.junit.executePlan.captureObserveSteps"
  internal const val CAPTURE_OBSERVE_STEPS_ENV = "AUTOMOBILE_EXECUTE_PLAN_CAPTURE_OBSERVE_STEPS"

  /**
   * When set, the daemon attaches each successful `observe` step to `executePlan` `debug` (see
   * AutoMobile `captureObserveSteps`). Single-device plans only.
   *
   * **System property:** [CAPTURE_OBSERVE_STEPS_PROPERTY] — `summary` or `full`
   *
   * **Environment:** [CAPTURE_OBSERVE_STEPS_ENV] (same values)
   */
  internal fun appendCaptureObserveStepsArgs(args: MutableMap<String, JsonElement>) {
    val v = resolveCaptureObserveSteps() ?: return
    args["captureObserveSteps"] = JsonPrimitive(v)
  }

  /**
   * Resolves the `captureObserveSteps` mode from system property (preferred) or environment
   * variable. Returns `null` if unset or set to an unrecognized value.
   */
  @JvmStatic
  internal fun resolveCaptureObserveSteps(): String? {
    val v =
      System.getProperty(CAPTURE_OBSERVE_STEPS_PROPERTY)?.trim()?.lowercase()
        ?: System.getenv(CAPTURE_OBSERVE_STEPS_ENV)?.trim()?.lowercase()
        ?: return null
    return v.takeIf { it == "summary" || it == "full" }
  }
}
