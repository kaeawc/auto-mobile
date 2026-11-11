package dev.jasonpearson.automobile.junit

import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor
import org.yaml.snakeyaml.error.YAMLException

/**
 * Which device a single-device plan runs on (#17953).
 *
 * An explicit [AutoMobilePlanExecutionOptions.device] wins. With the default `"auto"`, a non-blank
 * `ANDROID_SERIAL` pins the plan to that device, as adb itself would, so a host shared with other
 * users' emulators does not hand the plan to whichever device the daemon picks first. A plan that
 * declares top-level `devices:` labels allocates its own devices, so it is never pinned by
 * `ANDROID_SERIAL`.
 */
internal object PlanDeviceSelection {
  const val ANDROID_SERIAL_ENV = "ANDROID_SERIAL"
  private const val AUTO = "auto"

  /** The device id to send as `deviceId`, or null to let the daemon choose. */
  fun resolveDeviceId(
    configuredDevice: String,
    planContent: String,
    env: (String) -> String?,
  ): String? {
    val configured = configuredDevice.trim().takeIf { it.isNotEmpty() && it != AUTO }
    return configured ?: androidSerial(env)?.takeUnless { declaresDeviceLabels(planContent) }
  }

  /** `ANDROID_SERIAL` when set and non-blank. */
  fun androidSerial(env: (String) -> String?): String? =
    env(ANDROID_SERIAL_ENV)?.trim()?.takeIf { it.isNotEmpty() }

  /**
   * How many devices the runner may spread tests across: one when `ANDROID_SERIAL` names the device
   * to use (or none when adb lists none), otherwise every device adb lists.
   */
  fun usableDeviceCount(adbDeviceCount: Int, env: (String) -> String?): Int =
    if (androidSerial(env) != null) adbDeviceCount.coerceAtMost(1) else adbDeviceCount

  internal fun declaresDeviceLabels(planContent: String): Boolean {
    val root =
      try {
        Yaml(SafeConstructor(LoaderOptions())).load<Any?>(planContent)
      } catch (e: YAMLException) {
        // An unparseable plan fails in the daemon with its own error; it just isn't multi-device.
        println("AutoMobile: could not parse plan to detect device labels: ${e.message}")
        null
      }
    return (root as? Map<*, *>)?.containsKey("devices") == true
  }
}
