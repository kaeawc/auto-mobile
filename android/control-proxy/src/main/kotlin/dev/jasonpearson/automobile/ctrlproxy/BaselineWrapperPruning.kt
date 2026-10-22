package dev.jasonpearson.automobile.ctrlproxy

import android.annotation.SuppressLint
import android.util.Log

internal const val BASELINE_WRAPPER_PRUNING_PROPERTY = "debug.automobile.prune_wrappers"

/** Debug-only opt-in, sampled once by CtrlProxy at service construction. */
internal fun readBaselineWrapperPruningEnabled(
  readProperty: (String) -> String? = ::readAndroidSystemProperty,
  warn: (String, Throwable) -> Unit = { message, error -> Log.w("CtrlProxy", message, error) },
): Boolean {
  val property = BASELINE_WRAPPER_PRUNING_PROPERTY
  return try {
    readProperty(property) == "true"
  } catch (error: ReflectiveOperationException) {
    warn("Unable to read $property; baseline wrapper pruning remains disabled", error)
    false
  } catch (error: SecurityException) {
    warn("Unable to read $property; baseline wrapper pruning remains disabled", error)
    false
  }
}

// android.os.SystemProperties is hidden from the SDK. The reflective read is deliberate: it only
// gates a debug opt-in, and readBaselineWrapperPruningEnabled treats any reflective or security
// failure as "disabled".
@SuppressLint("PrivateApi")
private fun readAndroidSystemProperty(key: String): String? =
  Class.forName("android.os.SystemProperties")
    .getMethod("get", String::class.java)
    .invoke(null, key) as? String
