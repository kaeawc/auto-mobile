package dev.jasonpearson.automobile.protoviewer

import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

fun interface LocalNetworkPermission {
  fun request()
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
    if (
      ContextCompat.checkSelfPermission(activity, PERMISSION) == PackageManager.PERMISSION_GRANTED
    ) {
      result(true)
    } else {
      launcher.launch(PERMISSION)
    }
  }

  private companion object {
    const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
  }
}

/** No prompt on launch, on a repeated true value, or on platforms without this permission. */
class NetworkSettings(
  private val settings: SettingsStore,
  private val permission: LocalNetworkPermission,
  private val apiLevel: Int,
) {
  fun setEnabled(enabled: Boolean) {
    val enabling = enabled && !settings.allowNetwork.value
    settings.setAllowNetwork(enabled)
    if (enabling && apiLevel >= LOCAL_NETWORK_API) permission.request()
  }

  private companion object {
    const val LOCAL_NETWORK_API = 37
  }
}
