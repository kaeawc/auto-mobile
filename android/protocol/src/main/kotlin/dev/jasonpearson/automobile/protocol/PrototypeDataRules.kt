package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeSpecInput.canonicalString
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_DATA_ARRAY_ITEMS
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_DATA_BYTES
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_DATA_DEPTH
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_DATA_WRITE_BYTES
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

internal object PrototypeDataRules {
  fun dataError(value: JsonElement): PrototypeSpecError? {
    if (value !is JsonObject) return fail("data", "Expected object")
    return walkDataValue(value, "data", 1)
      ?: if (jsonCost(value) > MAX_PROTOTYPE_DATA_BYTES) fail("data", "Data byte limit exceeded")
      else null
  }

  /**
   * The data a device write leaves behind must stay inside the data limits, with the write byte cap
   * in place of the spec's own. A message containing "limit" is a limit refusal; any other is a
   * value data cannot hold.
   */
  internal fun dataWriteError(value: JsonObject): PrototypeSpecError? =
    walkDataValue(value, "data", 1)
      ?: if (jsonCost(value) > MAX_PROTOTYPE_DATA_WRITE_BYTES)
        fail("data", "Data byte limit exceeded")
      else null

  val dataActionTypes = setOf("setData", "appendData", "prependData", "removeData")

  /**
   * Static checks for `setData`, `appendData`, `prependData` and `removeData` (#12519) that the contract cannot
   * express: the `/data/<pointer>` path, a literal value data can hold, and an `appendData` target
   * the spec's own data already defines as something other than an array. A target under `{index}`
   * or one only an earlier write creates is the device's to check.
   */
  fun dataActionErrors(context: Context, root: JsonElement): PrototypeSpecError? {
    val data = (root as? JsonObject)?.get("data") as? JsonObject
    for ((value, path) in context.actions) {
      val type = value.text("type")
      if (type !in dataActionTypes) continue
      val actionPath = value.text("path").orEmpty()
      val pointer =
        PrototypeDataWriter.pathPointer(PrototypeRepeatTemplate.bindDataPath(actionPath, 0))
          ?: return fail(
            "$path.path",
            "Data action paths are /data/<RFC 6901 pointer> and address a member of data",
          )
      val literal = (value["value"] as? JsonObject)?.get("value")
      if (literal != null && dataError(JsonObject(mapOf("value" to literal))) != null) {
        return fail(
          "$path.value.value",
          "A data write value must be a string, boolean, finite number, array or object",
        )
      }
      if (
        type in setOf("appendData", "prependData") &&
          !PrototypeRepeatTemplate.dataPathHasIndex(actionPath)
      ) {
        val target = PrototypeDataPointer.resolve(data, pointer)
        if (target != null && target !is JsonArray) {
          return fail("$path.path", "$type target is not an array")
        }
      }
    }
    return null
  }

  fun isScalarLiteral(value: JsonPrimitive): Boolean =
    value.isString || value.booleanOrNull != null || value.doubleOrNull != null

  fun dataChildren(value: JsonElement, path: String): List<Pair<JsonElement, String>> =
    when (value) {
      is JsonObject -> value.keys.sorted().map { value.getValue(it) to keyPath(path, it) }
      is JsonArray -> value.mapIndexed { index, child -> child to "$path[$index]" }
      else -> emptyList()
    }

  fun walkDataValue(value: JsonElement, path: String, depth: Int): PrototypeSpecError? {
    if (value !is JsonObject && value !is JsonArray) {
      return if (PrototypeDataValues.isScalar(value)) null else fail(path, "Invalid data value")
    }
    if (depth > MAX_PROTOTYPE_DATA_DEPTH) return fail(path, "Data depth limit exceeded")
    if (value is JsonArray && value.size > MAX_PROTOTYPE_DATA_ARRAY_ITEMS) {
      return fail(path, "Data array limit exceeded")
    }
    return dataChildren(value, path).firstNotNullOfOrNull { (child, childPath) ->
      walkDataValue(child, childPath, depth + 1)
    }
  }

  // Numeric reserve avoids depending on JSON number token spellings across runtimes.
  fun jsonCost(value: JsonElement, depth: Int = 0): Double {
    if (depth > MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH) return Double.POSITIVE_INFINITY
    return when (value) {
      JsonNull -> 4.0
      is JsonObject ->
        2.0 +
          maxOf(0, value.size - 1) +
          value.entries.sumOf { (key, child) ->
            canonicalString(key).toByteArray(Charsets.UTF_8).size + 1 + jsonCost(child, depth + 1)
          }
      is JsonArray -> 2.0 + maxOf(0, value.size - 1) + value.sumOf { jsonCost(it, depth + 1) }
      is JsonPrimitive -> primitiveJsonCost(value)
    }
  }

  fun primitiveJsonCost(value: JsonPrimitive): Double {
    if (value.isString)
      return canonicalString(value.content).toByteArray(Charsets.UTF_8).size.toDouble()
    if (value.booleanOrNull != null) return value.toString().length.toDouble()
    return if (value.doubleOrNull?.isFinite() == true) 32.0 else Double.POSITIVE_INFINITY
  }
}
