package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Lazy renderers resolve row data without expanding the template or copying the node tree. */
object PrototypeListRows {
  fun items(list: PrototypeListNode, data: JsonObject?): List<JsonObject> =
    list.repeat.itemsPath?.let { PrototypeRepeatData(data).items(it) }.orEmpty()

  /** Stable identity has the same scalar spelling used by repeat key validation. */
  fun key(list: PrototypeListNode, item: JsonObject): String = key(list, item, 0)

  /** Invalid rows get a separate key namespace so an intervening render cannot throw. */
  fun key(list: PrototypeListNode, item: JsonObject, index: Int): String {
    val value = list.repeat.key?.let(item::get) as? JsonPrimitive
    return if (value != null && PrototypeDataValues.isScalar(value))
      PrototypeRepeatTemplate.rendered(value)
    else "\u0000missing-row:$index"
  }
}
