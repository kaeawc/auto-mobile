package dev.jasonpearson.automobile.sdk

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build

/**
 * Registers a control callback for both current and legacy CtrlProxy permissions.
 *
 * Android accepts only one sender permission per dynamically registered receiver. Separate receiver
 * instances make the accepted permissions an OR condition. A sender that holds both permissions can
 * deliver the same idempotent state-setting control broadcast twice.
 */
internal class NetworkControlReceiverRegistrar(
  private val onControlBroadcast: (Context?, Intent?) -> Unit
) {
  private val receivers = mutableListOf<BroadcastReceiver>()

  @Synchronized
  fun register(context: Context, intentFilter: () -> IntentFilter) {
    if (receivers.isNotEmpty()) return

    val registeredReceivers = mutableListOf<BroadcastReceiver>()
    try {
      for (permission in SdkConstants.NETWORK_CONTROL_PERMISSIONS) {
        val receiver =
          object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) =
              onControlBroadcast(context, intent)
          }
        registerReceiver(context, receiver, intentFilter(), permission)
        registeredReceivers += receiver
      }
      receivers += registeredReceivers
    } catch (e: Exception) {
      unregister(context, registeredReceivers)
      throw e
    }
  }

  @Synchronized
  fun unregister(context: Context) {
    unregister(context, receivers)
    receivers.clear()
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

  private fun unregister(context: Context, receivers: Collection<BroadcastReceiver>) {
    for (receiver in receivers) {
      try {
        context.unregisterReceiver(receiver)
      } catch (_: IllegalArgumentException) {
        // Receiver was already unregistered by the platform.
      }
    }
  }
}
