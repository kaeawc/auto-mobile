package dev.jasonpearson.automobile.ctrlproxy

import android.annotation.SuppressLint
import android.os.Build
import android.util.Log

internal const val BASELINE_WRAPPER_PRUNING_PROPERTY = "debug.automobile.prune_wrappers"

/** First API level where wrapper pruning is on by default (owner decision on #13956). */
internal const val BASELINE_WRAPPER_PRUNING_MIN_SDK = 30

/**
 * Whether [pruneBaselineWrappers][ViewHierarchyExtractor] is on, sampled once by CtrlProxy at
 * service construction. On from API 30; the debug property forces it on (`true`) or off (`false`)
 * on any API, and any other value, or an unreadable property, keeps the API default.
 */
internal fun readBaselineWrapperPruningEnabled(
  readProperty: (String) -> String? = ::readAndroidSystemProperty,
  sdkInt: Int = Build.VERSION.SDK_INT,
  warn: (String, Throwable) -> Unit = { message, error -> Log.w("CtrlProxy", message, error) },
): Boolean {
  val property = BASELINE_WRAPPER_PRUNING_PROPERTY
  val override =
    try {
      readProperty(property)
    } catch (error: ReflectiveOperationException) {
      warn("Unable to read $property; baseline wrapper pruning uses the API default", error)
      null
    } catch (error: SecurityException) {
      warn("Unable to read $property; baseline wrapper pruning uses the API default", error)
      null
    }
  return when (override) {
    "true" -> true
    "false" -> false
    else -> sdkInt >= BASELINE_WRAPPER_PRUNING_MIN_SDK
  }
}

// android.os.SystemProperties is hidden from the SDK. The reflective read is deliberate: it only
// only overrides an API default, and readBaselineWrapperPruningEnabled treats any reflective or
// security failure as "no override".
@SuppressLint("PrivateApi")
private fun readAndroidSystemProperty(key: String): String? =
  Class.forName("android.os.SystemProperties")
    .getMethod("get", String::class.java)
    .invoke(null, key) as? String
