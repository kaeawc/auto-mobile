package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.prototype.PrototypePlatform

/**
 * Closes CtrlProxy's service-owned platform modules when the service is destroyed. Every surface
 * shares them, so they close once, after the controller; one module's failure leaves no other open.
 */
internal fun closePrototypeModules(
  platform: PrototypePlatform,
  warn: (String, Throwable) -> Unit = { message, error ->
    Log.w("PrototypePlatform", message, error)
  },
) {
  for (module in platform.registry.modules) {
    try {
      module.close()
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      // Teardown keeps going: the service is being destroyed either way.
      warn("Closing platform module ${module.name} failed", error)
    }
  }
}
