package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log

/** Debug-only opt-in, sampled once by CtrlProxy at service construction. */
internal fun readBaselineWrapperPruningEnabled(
  readProperty: (String) -> String? = ::readAndroidSystemProperty,
  warn: (String, Throwable) -> Unit = { message, error -> Log.w("CtrlProxy", message, error) },
): Boolean {
  val property = "debug.automobile.prune_baseline_wrappers"
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

private fun readAndroidSystemProperty(key: String): String? =
  Class.forName("android.os.SystemProperties")
    .getMethod("get", String::class.java)
    .invoke(null, key) as? String
