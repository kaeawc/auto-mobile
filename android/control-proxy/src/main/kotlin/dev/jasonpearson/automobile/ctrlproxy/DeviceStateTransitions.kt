package dev.jasonpearson.automobile.ctrlproxy

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import java.lang.reflect.Proxy
import java.util.concurrent.Executor

/**
 * Best-effort posture notifications through the hidden/system DeviceStateManager API. There is no
 * public API for the raw device-state integer consumed by
 * DisplayRotationChangeSignal.emitDeviceState. The hidden-API list treats this as
 * unsupported/system API, so newer target SDKs may block access. Probe the capability explicitly
 * and warn when fold-posture events cannot be observed.
 */
internal object DeviceStateTransitions {
  internal class StateObserver(private val onChange: (Int) -> Unit) {
    private var lastState: Int? = null

    fun accept(state: Int) {
      val previous = lastState
      lastState = state
      if (previous != null && previous != state) onChange(state)
    }
  }

  internal fun callback(callbackClass: Class<*>, onState: (Int) -> Unit): Any {
    val observer = StateObserver(onState)
    return Proxy.newProxyInstance(callbackClass.classLoader, arrayOf(callbackClass)) {
      proxy,
      method,
      args ->
      when (method.name) {
        "equals" -> proxy === args?.firstOrNull()
        "hashCode" -> System.identityHashCode(proxy)
        "toString" -> "DeviceStateCallback@${System.identityHashCode(proxy).toString(16)}"
        "onStateChanged",
        "onDeviceStateChanged" -> {
          val value = args?.firstOrNull()
          val state =
            (value as? Number)?.toInt()
              ?: (value?.javaClass?.getMethod("getIdentifier")?.invoke(value) as? Number)?.toInt()
          if (state != null) observer.accept(state)
          null
        }
        else -> null
      }
    }
  }

  fun register(
    context: Context,
    sdkInt: Int = Build.VERSION.SDK_INT,
    loadClass: (String) -> Class<*> = { Class.forName(it) },
    onState: (Int) -> Unit,
  ): AutoCloseable? {
    if (sdkInt < Build.VERSION_CODES.S) return null
    var capability = "android.hardware.devicestate.DeviceStateManager class"
    return try {
      val managerClass = loadClass("android.hardware.devicestate.DeviceStateManager")
      capability = "DeviceStateManager\$DeviceStateCallback class"
      val callbackClass =
        loadClass("android.hardware.devicestate.DeviceStateManager\$DeviceStateCallback")
      if (!callbackClass.isInterface) {
        Log.w(
          "CtrlProxyDeviceState",
          "$capability is not an interface; fold-posture events are lost",
        )
        return null
      }
      capability = "DeviceStateManager.registerCallback(Executor, DeviceStateCallback)"
      val register = managerClass.getMethod("registerCallback", Executor::class.java, callbackClass)
      capability = "DeviceStateManager.unregisterCallback(DeviceStateCallback)"
      val unregister = managerClass.getMethod("unregisterCallback", callbackClass)
      capability = "device_state service"
      val manager = context.getSystemService("device_state")
      if (manager == null) {
        Log.w("CtrlProxyDeviceState", "$capability is missing; fold-posture events are lost")
        return null
      }
      capability = "DeviceStateCallback proxy"
      val callback = callback(callbackClass, onState)
      capability = "DeviceStateManager.registerCallback invocation"
      register.invoke(manager, ContextCompat.getMainExecutor(context), callback)
      AutoCloseable { unregister.invoke(manager, callback) }
    } catch (e: ReflectiveOperationException) {
      Log.w("CtrlProxyDeviceState", "$capability unavailable; fold-posture events are lost", e)
      null
    } catch (e: SecurityException) {
      Log.w("CtrlProxyDeviceState", "$capability access denied; fold-posture events are lost", e)
      null
    } catch (e: LinkageError) {
      Log.w("CtrlProxyDeviceState", "$capability linkage failed; fold-posture events are lost", e)
      null
    }
  }
}
