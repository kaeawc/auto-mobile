package dev.jasonpearson.automobile.sdk

import android.os.Binder
import android.os.Process

/**
 * Keeps the exported debug inspector providers limited to the callers that need them.
 *
 * The providers must be exported for `adb shell content call` on modern Android, but exporting
 * without a provider-side check would let unrelated apps read or mutate the host app's data.
 */
internal object DebugInspectorAccess {

  fun isAuthorized(callingUid: Int, ownUid: Int): Boolean {
    return callingUid == Process.SHELL_UID || callingUid == Process.ROOT_UID || callingUid == ownUid
  }

  fun enforceCaller() {
    val callingUid = Binder.getCallingUid()
    if (!isAuthorized(callingUid, Process.myUid())) {
      throw SecurityException("Debug inspector access denied for uid $callingUid")
    }
  }
}
