package dev.jasonpearson.automobile.ctrlproxy

import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager

/**
 * Whether [packageName] ships with the system image, including a system app updated from the store.
 * Null when the package cannot be read (uninstalled, or hidden from this service), after reporting
 * the cause to [onFailure].
 */
@Suppress("TooGenericExceptionCaught") // Any lookup failure means "unknown", never a crash.
internal fun PackageManager.systemAppFlag(
  packageName: String,
  onFailure: (Exception) -> Unit,
): Boolean? =
  try {
    val flags = getApplicationInfo(packageName, 0).flags
    (flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0
  } catch (e: Exception) {
    onFailure(e)
    null
  }
