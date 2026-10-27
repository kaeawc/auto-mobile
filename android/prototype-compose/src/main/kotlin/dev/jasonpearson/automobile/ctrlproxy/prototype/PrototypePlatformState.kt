package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeDeviceContract
import kotlinx.serialization.json.*

/** Device-owned state and one trailing event; callers serialize updates and delivery. */
internal class PrototypePlatformState(
  private val scheduler: PrototypeScheduler,
  private val exclusively: suspend (suspend () -> Unit) -> Unit = { it() },
  private val deliver: suspend (String, JsonObject) -> Unit,
) {
  var snapshot: JsonObject = JsonObject(emptyMap())
    private set

  private var pending: PrototypeScheduledTask? = null
  private var generation = 0L
  private val eventKeys = setOf("widthClass", "heightClass", "sizeClass", "posture", "idiom")

  fun update(next: JsonObject): Boolean {
    require(
      next.toString().toByteArray(Charsets.UTF_8).size <= PrototypeDeviceContract.maxStateBytes,
    )
    if (next == snapshot) return false
    val before = snapshot["device"] as? JsonObject
    val device = next.getValue("device").jsonObject
    snapshot = next
    if (before != null && eventKeys.any { before[it] != device[it] }) {
      pending?.cancel()
      val token = ++generation
      pending =
        scheduler.schedule(PrototypeDeviceContract.debounceMs) {
          exclusively {
            if (token == generation) {
              pending = null
              deliver("device.changed", snapshot.getValue("device").jsonObject)
            }
          }
        }
    }
    return true
  }

  fun close() {
    generation++
    pending?.cancel()
    pending = null
  }
}
