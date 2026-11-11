package dev.jasonpearson.automobile.sdk

import android.content.Context
import android.os.Binder
import android.os.Process
import android.util.Log

/**
 * Keeps the exported debug inspector providers limited to the callers that need them.
 *
 * The providers must be exported for `adb shell content call` on modern Android, but exporting
 * without a provider-side check would let unrelated apps read or mutate the host app's data.
 */
internal object DebugInspectorAccess {

  private const val TAG = "DebugInspectorAccess"

  // Stable Android/Linux UIDs; Process exposes these constants only from API 29.
  private const val ROOT_UID = 0
  private const val SHELL_UID = 2000

  /** Resolves the packages that share a calling uid; narrow seam over `PackageManager.getPackagesForUid`. */
  fun interface CallingPackageResolver {
    fun packagesForUid(uid: Int): Array<String>?
  }

  fun isAuthorized(
    callingUid: Int,
    ownUid: Int,
    callingPackages: Set<String> = emptySet(),
  ): Boolean = isAuthorized(callingUid, ownUid) { callingPackages }

  /**
   * Checks the cheap uid identities first and resolves [callingPackages] only when none match, so a
   * shell, root or same-uid caller never triggers a package lookup. That lookup is cross-user on
   * AAOS (host app in a secondary user, shell in user 0) and can throw.
   */
  fun isAuthorized(callingUid: Int, ownUid: Int, callingPackages: () -> Set<String>): Boolean {
    return callingUid == SHELL_UID ||
      callingUid == ROOT_UID ||
      callingUid == ownUid ||
      SdkConstants.CTRL_PROXY_PACKAGE in callingPackages()
  }

  fun enforceCaller(context: Context?) {
    val packageManager = context?.packageManager
    enforceCaller(
      callingUid = Binder.getCallingUid(),
      ownUid = Process.myUid(),
      resolver = { uid -> packageManager?.getPackagesForUid(uid) },
    )
  }

  fun enforceCaller(callingUid: Int, ownUid: Int, resolver: CallingPackageResolver) {
    val authorized =
      isAuthorized(callingUid, ownUid) { resolveCallingPackages(callingUid, resolver) }
    if (!authorized) {
      throw SecurityException("Debug inspector access denied for uid $callingUid")
    }
  }

  private fun resolveCallingPackages(
    callingUid: Int,
    resolver: CallingPackageResolver,
  ): Set<String> {
    return try {
      resolver.packagesForUid(callingUid)?.toSet().orEmpty()
    } catch (e: SecurityException) {
      // A cross-user lookup (e.g. AAOS secondary user) is not permitted; an unresolvable caller
      // simply is not the CtrlProxy, so deny instead of crashing the provider call.
      Log.d(TAG, "Package lookup for uid $callingUid not permitted; treating as unauthorized", e)
      emptySet()
    }
  }
}
