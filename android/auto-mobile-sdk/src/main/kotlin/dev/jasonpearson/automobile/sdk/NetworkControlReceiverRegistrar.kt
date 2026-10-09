package dev.jasonpearson.automobile.sdk

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build

/**
 * The reply channel of a control broadcast CtrlProxy sent as an ordered broadcast, so a receiver
 * can answer the sender through the result data (issue #10101). A plain broadcast has none.
 */
internal interface ControlBroadcastReply {
  /** True only when the sender used an ordered broadcast and is waiting for a result. */
  val isOrdered: Boolean

  /** The result data an earlier receiver left, or null. Only meaningful when [isOrdered]. */
  var resultData: String?
}

private class BroadcastReceiverReply(private val receiver: BroadcastReceiver) :
  ControlBroadcastReply {
  override val isOrdered: Boolean
    get() = receiver.isOrderedBroadcast

  override var resultData: String?
    get() = receiver.resultData
    set(value) {
      receiver.resultData = value
    }
}

/** Registers a control callback protected by the CtrlProxy-owned signature permission. */
internal class NetworkControlReceiverRegistrar(
  private val onControlBroadcast: (Context?, Intent?, ControlBroadcastReply) -> Unit,
) {
  /** For callbacks that never answer the sender. */
  constructor(
    onControlBroadcast: (Context?, Intent?) -> Unit,
  ) : this({ context, intent, _ -> onControlBroadcast(context, intent) })

  private var receiver: BroadcastReceiver? = null

  @Synchronized
  fun register(context: Context, intentFilter: () -> IntentFilter) {
    if (receiver != null) return

    val registeredReceiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) =
          onControlBroadcast(context, intent, BroadcastReceiverReply(this))
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
