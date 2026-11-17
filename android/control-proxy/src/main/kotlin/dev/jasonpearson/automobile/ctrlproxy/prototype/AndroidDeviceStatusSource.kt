package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject

/** Framework seam: every successful registration immediately supplies its matching cleanup. */
internal interface AndroidStatusGateway {
  fun read(): JsonObject

  fun observe(changed: () -> Unit, retain: (() -> Unit) -> Unit)
}

/** Shared lazy lifecycle for the three status sources; closing an unread source never starts it. */
internal class AndroidDeviceStatusSource(private val gateway: AndroidStatusGateway) :
  PrototypeDeviceStatusSource {
  private val tracker = DeviceStatusTracker()
  private val cleanups = mutableListOf<() -> Unit>()
  private var started = false
  private var closed = false

  override val state: StateFlow<JsonObject>
    get() {
      start()
      return tracker.state
    }

  @Synchronized
  private fun start() {
    if (started || closed) return
    started = true
    try {
      refresh()
      gateway.observe(::refresh, cleanups::add)
      // Cover a change between seeding and registration before exposing the baseline.
      refresh()
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      Log.w("PrototypeDeviceStatus", "Status observation failed", error)
      close()
    }
  }

  @Synchronized
  private fun refresh() {
    if (!closed) tracker.update(gateway.read())
  }

  @Synchronized
  override fun close() {
    closed = true
    cleanups.asReversed().forEach { cleanup ->
      try {
        cleanup()
      } catch (error: IllegalArgumentException) {
        Log.w("PrototypeDeviceStatus", "Status callback was already unregistered", error)
      }
    }
    cleanups.clear()
  }
}

/** Normal system broadcasts only; no runtime permissions or manifest receiver. */
internal fun observeStatusBroadcast(
  context: Context,
  action: String,
  changed: () -> Unit,
  retain: (() -> Unit) -> Unit,
) {
  val receiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == action) changed()
      }
    }
  ContextCompat.registerReceiver(
    context,
    receiver,
    IntentFilter(action),
    ContextCompat.RECEIVER_NOT_EXPORTED,
  )
  retain { context.unregisterReceiver(receiver) }
}
