package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

private const val LOCAL_NETWORK_API = 37
private const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"

fun interface LocalNetworkPermission {
  fun request()
}

/** Current platform grant; unlike [LocalNetworkPermission.request] it never prompts. */
fun interface LocalNetworkGrant {
  fun isGranted(context: Context): Boolean
}

/** Platforms before API 37 have no such permission, so nothing can be revoked there. */
object AndroidLocalNetworkGrant : LocalNetworkGrant {
  override fun isGranted(context: Context): Boolean =
    Build.VERSION.SDK_INT < LOCAL_NETWORK_API ||
      ContextCompat.checkSelfPermission(context, LOCAL_NETWORK_PERMISSION) ==
        PackageManager.PERMISSION_GRANTED
}

/**
 * The user can revoke the permission in system settings while the stored switch stays on. Call on
 * start, resume and window focus gain: a lost grant turns the switch off exactly like a denial.
 * True when it did.
 */
fun revokeNetworkIfLocalNetworkLost(
  settings: SettingsStore,
  grant: LocalNetworkGrant,
  context: Context,
): Boolean {
  if (!settings.allowNetwork.value || grant.isGranted(context)) return false
  settings.setAllowNetwork(false)
  return true
}

/** Recheck on foreground entry and focus gain, reporting a revocation to the owning surface. */
fun recheckLocalNetworkPermission(
  settings: SettingsStore,
  grant: LocalNetworkGrant,
  context: Context,
  onRevoked: () -> Unit = {},
) {
  if (revokeNetworkIfLocalNetworkLost(settings, grant, context)) onRevoked()
}

/** Construct during onCreate, before the activity starts. Only an explicit enable calls request. */
class AndroidLocalNetworkPermission(
  private val activity: ComponentActivity,
  private val result: (Boolean) -> Unit,
) : LocalNetworkPermission {
  private val launcher =
    activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      result(granted)
    }

  override fun request() {
    if (AndroidLocalNetworkGrant.isGranted(activity)) {
      result(true)
    } else {
      launcher.launch(LOCAL_NETWORK_PERMISSION)
    }
  }
}

/** No prompt on launch, on a repeated true value, or on platforms without this permission. */
class NetworkSettings(
  private val settings: SettingsStore,
  private val permission: LocalNetworkPermission,
  private val apiLevel: Int,
) {
  fun onPermissionResult(granted: Boolean) {
    if (!granted) settings.setAllowNetwork(false)
  }

  fun setEnabled(enabled: Boolean) {
    val enabling = enabled && !settings.allowNetwork.value
    settings.setAllowNetwork(enabled)
    if (enabling && apiLevel >= LOCAL_NETWORK_API) permission.request()
  }
}
