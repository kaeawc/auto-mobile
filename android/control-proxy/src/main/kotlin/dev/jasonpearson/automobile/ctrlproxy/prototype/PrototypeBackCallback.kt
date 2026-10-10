package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.SuppressLint
import android.view.View
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher

/** From this API level the platform routes Back to registered callbacks, not to KEYCODE_BACK. */
const val PROTOTYPE_BACK_CALLBACK_MIN_SDK = 33

/** Narrow seam over the window's predictive-back dispatcher so the policy is device-free. */
interface PrototypeBackCallbackRegistrar {
  /** Registers [onBack]; false when the window has no dispatcher yet (retried on the next sync). */
  fun register(onBack: () -> Unit): Boolean

  fun unregister()
}

/**
 * Registers the Back callback exactly while the prototype window is focusable (a text field is
 * visible) and the platform delivers Back as a callback. Below [PROTOTYPE_BACK_CALLBACK_MIN_SDK]
 * the key-event path in the window root is the only route, so nothing is ever registered. Both
 * routes end in the same [onBack] target; the controller makes a repeated dismissal a no-op.
 */
internal class PrototypeBackBinding(
  private val sdkInt: Int,
  private val registrar: PrototypeBackCallbackRegistrar,
  private val onBack: () -> Unit,
) {
  var registered: Boolean = false
    private set

  fun sync(focusable: Boolean) {
    val wanted = focusable && sdkInt >= PROTOTYPE_BACK_CALLBACK_MIN_SDK
    if (wanted == registered) return
    if (wanted) registered = registrar.register(onBack)
    else {
      registrar.unregister()
      registered = false
    }
  }

  /** Window gone, dismissed or lost: nothing may stay registered on a dead dispatcher. */
  fun release() = sync(false)
}

/** Never registers; used below API 33 where [PROTOTYPE_BACK_CALLBACK_MIN_SDK] gates the binding. */
internal object NoPrototypeBackCallbackRegistrar : PrototypeBackCallbackRegistrar {
  override fun register(onBack: () -> Unit) = false

  override fun unregister() = Unit
}

/**
 * Registers at PRIORITY_DEFAULT, not PRIORITY_OVERLAY. The keyboard registers its own default
 * priority callback when it shows, after the field took focus, and the most recent callback at a
 * priority is tried first, so the first Back hides the keyboard and the next one reaches the
 * prototype. A prototype priority would always win and dismiss the prototype with the keyboard
 * open. Not verified on a device.
 */
@SuppressLint("NewApi")
internal class AndroidPrototypeBackRegistrar(private val view: View) :
  PrototypeBackCallbackRegistrar {
  private var registration: Pair<OnBackInvokedDispatcher, OnBackInvokedCallback>? = null

  override fun register(onBack: () -> Unit): Boolean {
    if (registration != null) return true
    val dispatcher = view.findOnBackInvokedDispatcher() ?: return false
    val callback = OnBackInvokedCallback { onBack() }
    dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
    registration = dispatcher to callback
    return true
  }

  override fun unregister() {
    val (dispatcher, callback) = registration ?: return
    registration = null
    dispatcher.unregisterOnBackInvokedCallback(callback)
  }
}
