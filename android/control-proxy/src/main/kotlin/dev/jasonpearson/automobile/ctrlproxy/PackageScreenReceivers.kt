package dev.jasonpearson.automobile.ctrlproxy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

private const val TAG = "CtrlProxy"

/** A package install, replace or removal, normalised from the platform package broadcast. */
internal data class PackageBroadcastEvent(
  val action: String,
  val packageName: String,
  val userId: Int,
  val uid: Int?,
  val isSystem: Boolean?,
  val removedForAllUsers: Boolean,
)

/** The service members the package receiver needs: system-app lookup and the client broadcast. */
internal interface PackageEventHost {
  fun isSystemApp(packageName: String): Boolean?

  suspend fun onPackageEvent(event: PackageBroadcastEvent)
}

/** Receives package added/removed/replaced broadcasts and forwards them to [host] on [scope]. */
internal class PackageEventReceiver(
  private val scope: CoroutineScope,
  private val host: PackageEventHost,
) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent == null) {
      return
    }

    val action = intent.action ?: return
    if (
      action != Intent.ACTION_PACKAGE_ADDED &&
        action != Intent.ACTION_PACKAGE_REMOVED &&
        action != Intent.ACTION_PACKAGE_REPLACED
    ) {
      return
    }

    val packageName = intent.data?.schemeSpecificPart ?: return
    val uid = intent.getIntExtra(Intent.EXTRA_UID, -1)
    val userId = packageEventUserId(uid)
    val isReplacing = intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)
    // EXTRA_REMOVED_FOR_ALL_USERS may not be available in all SDK versions, use string literal
    val removedForAllUsers =
      intent.getBooleanExtra("android.intent.extra.REMOVED_FOR_ALL_USERS", false)

    val eventAction = packageEventAction(action, isReplacing) ?: return

    val isSystem = if (eventAction == "removed") null else host.isSystemApp(packageName)

    Log.d(
      TAG,
      "Package event: $eventAction $packageName (userId=$userId, removedForAllUsers=$removedForAllUsers)",
    )

    scope.launch {
      host.onPackageEvent(
        PackageBroadcastEvent(
          action = eventAction,
          packageName = packageName,
          userId = userId,
          uid = uid.takeIf { it >= 0 },
          isSystem = isSystem,
          removedForAllUsers = removedForAllUsers,
        ),
      )
    }
  }
}

/** The service members the screen-state receiver needs. */
internal interface ScreenStateHost {
  fun refreshPrototypeWindow()

  /** Extracts the hierarchy immediately; a no-op until the debouncer exists. */
  fun extractHierarchyNow()
}

/** Refreshes the prototype window and re-extracts the hierarchy when the screen turns on or off. */
internal class ScreenStateReceiver(private val host: ScreenStateHost) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    host.refreshPrototypeWindow()
    when (intent?.action) {
      Intent.ACTION_SCREEN_ON -> {
        Log.i(TAG, "Screen turned ON, triggering hierarchy extraction")
        host.extractHierarchyNow()
      }
      Intent.ACTION_SCREEN_OFF -> {
        Log.i(TAG, "Screen turned OFF, triggering hierarchy extraction")
        host.extractHierarchyNow()
      }
    }
  }
}

private fun packageEventAction(action: String, isReplacing: Boolean): String? =
  when (action) {
    Intent.ACTION_PACKAGE_ADDED -> if (isReplacing) "replaced" else "added"
    Intent.ACTION_PACKAGE_REMOVED -> if (isReplacing) null else "removed"
    Intent.ACTION_PACKAGE_REPLACED -> "replaced"
    else -> null
  }
