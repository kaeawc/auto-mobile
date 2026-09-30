package dev.jasonpearson.automobile.ctrlproxy

import android.content.Context
import android.os.Build
import android.util.Log
import java.lang.reflect.Proxy
import java.util.concurrent.Executor

/** Best-effort posture notifications on builds that expose DeviceStateManager to apps. */
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

  fun register(context: Context, onState: (Int) -> Unit): AutoCloseable? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
    return try {
      val managerClass = Class.forName("android.hardware.devicestate.DeviceStateManager")
      val callbackClass =
        Class.forName("android.hardware.devicestate.DeviceStateManager\$DeviceStateCallback")
      if (!callbackClass.isInterface) return null
      val manager = context.getSystemService("device_state") ?: return null
      val callback = callback(callbackClass, onState)
      val register = managerClass.getMethod("registerCallback", Executor::class.java, callbackClass)
      register.invoke(manager, context.mainExecutor, callback)
      AutoCloseable {
        managerClass.getMethod("unregisterCallback", callbackClass).invoke(manager, callback)
      }
    } catch (e: ReflectiveOperationException) {
      Log.d("CtrlProxyDeviceState", "DeviceStateManager unavailable", e)
      null
    } catch (e: SecurityException) {
      Log.d("CtrlProxyDeviceState", "Device state access denied", e)
      null
    }
  }
}
