package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Lazy renderers resolve row data without expanding the template or copying the node tree. */
object PrototypeListRows {
  fun items(list: PrototypeListNode, data: JsonObject?): List<JsonObject> =
    list.repeat.itemsPath?.let { PrototypeRepeatData(data).items(it) }.orEmpty()

  /** Stable identity has the same scalar spelling used by repeat key validation. */
  fun key(list: PrototypeListNode, item: JsonObject): String =
    PrototypeRepeatTemplate.rendered(item.getValue(checkNotNull(list.repeat.key)) as JsonPrimitive)
}
