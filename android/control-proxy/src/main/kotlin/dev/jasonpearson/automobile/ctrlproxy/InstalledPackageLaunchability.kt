package dev.jasonpearson.automobile.ctrlproxy

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * Package names owning at least one MAIN/LAUNCHER activity for the current user.
 *
 * Why not `getLaunchIntentForPackage`: it resolves `CATEGORY_INFO` before `CATEGORY_LAUNCHER`, so a
 * package that declares MAIN/INFO and no launcher entry still yields an intent. The adb fallback
 * `listApps` uses when CtrlProxy is unavailable (`cmd package query-activities ... -c
 * android.intent.category.LAUNCHER`) queries MAIN/LAUNCHER only, so the two sources would disagree
 * about the very same install and the default `listApps` result would change with CtrlProxy
 * availability. One batched query keeps both paths on the same criterion (#6924 review, #6798).
 *
 * One `queryIntentActivities` call answers the whole listing, so this stays inside the single
 * round-trip `installed_packages` already costs rather than adding per-package work. Best-effort:
 * PackageManager can throw (e.g. a `TransactionTooLargeException` on a very large result), and that
 * must degrade to "no launcher entry reported" instead of failing the whole enumeration.
 */
internal fun launchablePackageNames(packageManager: PackageManager): Set<String> {
  val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
  val resolved = runCatching {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      packageManager.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0L))
    } else {
      @Suppress("DEPRECATION") packageManager.queryIntentActivities(intent, 0)
    }
  }
    .getOrNull()
    .orEmpty()
  return resolved.mapNotNull { it.activityInfo?.packageName }.toSet()
}
