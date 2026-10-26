package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Device module policy shared by validation and native renderers. */
object PrototypeDeviceContract {
  private val device =
    PrototypeSpecContract.contract
      .getValue("platformModules")
      .jsonObject
      .getValue("device")
      .jsonObject

  fun breakpoints(key: String): List<Int> =
    device
      .getValue("state")
      .jsonObject
      .getValue(key)
      .jsonObject
      .getValue("breakpoints")
      .jsonArray
      .map { it.jsonPrimitive.int }

  val debounceMs: Long =
    device
      .getValue("events")
      .jsonObject
      .getValue("changed")
      .jsonObject
      .getValue("debounceMs")
      .jsonPrimitive
      .int
      .toLong()
  val maxStateBytes: Int =
    PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_PLATFORM_STATE_BYTES").jsonPrimitive.int
}
