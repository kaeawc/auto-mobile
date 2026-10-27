package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService

/**
 * Wire-name to `AccessibilityService.performGlobalAction` mapping for `request_global_action`, with
 * the API level each action needs. Pure so the mapping and its API gates are unit-testable without
 * an Android runner.
 *
 * The actions beyond back/home/recent/notifications each advertise a `global_action_<name>_v1`
 * capability flag, and only on a device whose API level can perform them (#14095). A host therefore
 * needs a single check, "is the flag advertised", to cover both the installed APK and the device
 * API level; an older APK that predates a flag never advertises it.
 */
internal object SystemGlobalActions {
  internal class Spec(
    val wireName: String,
    val actionId: Int,
    val minSdk: Int,
    /** Null for the long-standing actions every APK has always accepted. */
    val capabilityFlag: String?,
    val aliases: List<String> = emptyList(),
  ) {
    fun matches(action: String): Boolean = action == wireName || action in aliases
  }

  private const val API_P = 28
  private const val API_S = 31

  // Values of the API 28/31 AccessibilityService constants. Referencing the constants directly
  // trips the InlinedApi lint check on the module's minSdk even though every use is gated by
  // [Spec.minSdk], so the ids are spelled out here.
  private const val GLOBAL_ACTION_LOCK_SCREEN = 8
  private const val GLOBAL_ACTION_TAKE_SCREENSHOT = 9
  private const val GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE = 15

  private fun flagFor(wireName: String) = "global_action_${wireName}_v1"

  internal val specs: List<Spec> =
    listOf(
      Spec("back", AccessibilityService.GLOBAL_ACTION_BACK, 1, null),
      Spec("home", AccessibilityService.GLOBAL_ACTION_HOME, 1, null),
      Spec("recent", AccessibilityService.GLOBAL_ACTION_RECENTS, 1, null, listOf("recents")),
      Spec("notifications", AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS, 1, null),
      Spec(
        "power_dialog",
        AccessibilityService.GLOBAL_ACTION_POWER_DIALOG,
        1,
        flagFor("power_dialog"),
      ),
      Spec(
        "quick_settings",
        AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS,
        1,
        flagFor("quick_settings"),
      ),
      Spec(
        "split_screen",
        AccessibilityService.GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN,
        1,
        flagFor("split_screen"),
      ),
      Spec(
        "lock_screen",
        GLOBAL_ACTION_LOCK_SCREEN,
        API_P,
        flagFor("lock_screen"),
      ),
      Spec(
        "screenshot",
        GLOBAL_ACTION_TAKE_SCREENSHOT,
        API_P,
        flagFor("screenshot"),
      ),
      Spec(
        "dismiss_notification_shade",
        GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE,
        API_S,
        flagFor("dismiss_notification_shade"),
      ),
    )

  private fun find(action: String): Spec? {
    val normalized = action.lowercase()
    return specs.firstOrNull { it.matches(normalized) }
  }

  /** The `performGlobalAction` id for [action] on [sdkInt], or null when unknown or too new. */
  fun resolve(action: String, sdkInt: Int): Int? =
    find(action)?.takeIf { sdkInt >= it.minSdk }?.actionId

  /** Why [action] cannot run on [sdkInt], or null when it can. */
  fun refusal(action: String, sdkInt: Int): String? {
    val spec = find(action) ?: return "Unsupported global action: $action"
    return if (sdkInt >= spec.minSdk) {
      null
    } else {
      "Global action $action requires Android API ${spec.minSdk}+ (device is API $sdkInt)"
    }
  }

  /** Capability flags to advertise on [sdkInt]: one per gated action the device can perform. */
  fun advertisedFlags(sdkInt: Int): List<String> =
    specs
      .filter { it.capabilityFlag != null && sdkInt >= it.minSdk }
      .mapNotNull {
        it.capabilityFlag
      }
}
