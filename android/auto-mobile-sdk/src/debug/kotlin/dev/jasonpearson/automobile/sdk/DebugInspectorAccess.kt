package dev.jasonpearson.automobile.sdk

import android.content.Context
import android.os.Binder
import android.os.Process

/**
 * Keeps the exported debug inspector providers limited to the callers that need them.
 *
 * The providers must be exported for `adb shell content call` on modern Android, but exporting
 * without a provider-side check would let unrelated apps read or mutate the host app's data.
 */
internal object DebugInspectorAccess {

  fun isAuthorized(
    callingUid: Int,
    ownUid: Int,
    callingPackages: Set<String> = emptySet(),
  ): Boolean {
    return callingUid == Process.SHELL_UID ||
      callingUid == Process.ROOT_UID ||
      callingUid == ownUid ||
      SdkConstants.CTRL_PROXY_PACKAGE in callingPackages
  }

  fun enforceCaller(context: Context?) {
    val callingUid = Binder.getCallingUid()
    val callingPackages = context?.packageManager?.getPackagesForUid(callingUid)?.toSet().orEmpty()
    if (!isAuthorized(callingUid, Process.myUid(), callingPackages)) {
      throw SecurityException("Debug inspector access denied for uid $callingUid")
    }
  }
}
