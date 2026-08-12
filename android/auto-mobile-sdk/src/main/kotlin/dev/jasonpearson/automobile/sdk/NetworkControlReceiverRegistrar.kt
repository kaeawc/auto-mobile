package dev.jasonpearson.automobile.sdk

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build

/** Registers a control callback protected by the CtrlProxy-owned signature permission. */
internal class NetworkControlReceiverRegistrar(
  private val onControlBroadcast: (Context?, Intent?) -> Unit
) {
  private var receiver: BroadcastReceiver? = null

  @Synchronized
  fun register(context: Context, intentFilter: () -> IntentFilter) {
    if (receiver != null) return

    val registeredReceiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) =
          onControlBroadcast(context, intent)
      }
    registerReceiver(
      context,
      registeredReceiver,
      intentFilter(),
      SdkConstants.PERMISSION_NETWORK_CONTROL,
    )
    receiver = registeredReceiver
  }

  @Synchronized
  fun unregister(context: Context) {
    val registeredReceiver = receiver ?: return
    try {
      context.unregisterReceiver(registeredReceiver)
    } catch (_: IllegalArgumentException) {
      // Receiver was already unregistered by the platform.
    } finally {
      receiver = null
    }
  }

  @SuppressLint("UnspecifiedRegisterReceiverFlag")
  private fun registerReceiver(
    context: Context,
    receiver: BroadcastReceiver,
    filter: IntentFilter,
    permission: String,
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(
        receiver,
        filter,
        permission,
        null,
        Context.RECEIVER_EXPORTED,
      )
    } else {
      context.registerReceiver(receiver, filter, permission, null)
    }
  }
}
