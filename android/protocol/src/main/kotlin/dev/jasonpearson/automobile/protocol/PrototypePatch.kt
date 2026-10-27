package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePatchNodes.replaceNode
import dev.jasonpearson.automobile.protocol.PrototypePatchShape.Rejection
import dev.jasonpearson.automobile.protocol.PrototypePatchShape.invalidSuffix
import dev.jasonpearson.automobile.protocol.PrototypePatchShape.reject
import dev.jasonpearson.automobile.protocol.PrototypePatchShape.shape
import dev.jasonpearson.automobile.protocol.PrototypePatchShape.text
import dev.jasonpearson.automobile.protocol.PrototypePatchValues.change
import dev.jasonpearson.automobile.protocol.PrototypePatchValues.member
import kotlinx.serialization.json.*

/** Pure patch applier; the caller validates the resulting spec separately (#11675). */
object PrototypePatch {
  enum class StateTests {
    EVALUATE,
    SKIP,
  }

  sealed class Result {
    data class Success(val spec: JsonObject) : Result()

    data class Failure(val error: PrototypeSpecError) : Result()
  }

  fun apply(
    spec: JsonElement,
    ops: JsonElement,
    stateTests: StateTests = StateTests.EVALUATE,
  ): Result =
    try {
      var current = spec as? JsonObject ?: reject("$", "Expected object")
      val operations = ops as? JsonArray ?: reject("ops", "Expected array")
      if (operations.size !in 1..PrototypeSpecValidator.MAX_PROTOTYPE_PATCH_OPS) {
        reject("ops", "Array length out of range")
      }
      operations.forEachIndexed { index, value ->
        val at = "ops[$index]"
        val op = shape(value, at)
        current = applyOp(current, op, at, stateTests)
      }
      Result.Success(current)
    } catch (failure: Rejection) {
      Result.Failure(failure.error)
    }

  fun touchesState(ops: JsonElement): Boolean =
    (ops as? JsonArray)?.any {
      val path = text((it as? JsonObject)?.get("path"))
      path == "/state" || path?.startsWith("/state/") == true
    } == true

  private fun applyOp(spec: JsonObject, op: JsonObject, at: String, tests: StateTests): JsonObject {
    if (text(op["op"]) == "replaceNode") return replaceNode(spec, op, at)
    val path = checkNotNull(text(op["path"]))
    val prefix = path.split('/').getOrNull(1)
    if (path.startsWith('/') && prefix in listOf("root", "window", "theme")) {
      reject(
        "$at.path",
        "Not patchable: use show for window, theme and root changes, or replaceNode for one node",
      )
    }
    val suffix = path.drop(if (prefix == "data") "/data".length else "/state".length)
    if (!path.startsWith('/') || prefix !in listOf("data", "state") || invalidSuffix(suffix)) {
      reject("$at.path", "Patch paths start with /data or /state")
    }
    val tokens = PrototypeDataPointer.tokens(suffix)
    return if (prefix == "state") applyState(spec, op, tokens, at, tests)
    else change(spec, listOf("data") + tokens, op, at) as JsonObject
  }

  private fun applyState(
    spec: JsonObject,
    op: JsonObject,
    tokens: List<String>,
    at: String,
    tests: StateTests,
  ): JsonObject {
    if (tokens.size != 1) reject("$at.path", "State patches address one key: /state/<key>")
    val key = tokens.first()
    if (!PrototypeRepeatTemplate.isFieldName(key)) reject("$at.path", "Invalid state key")
    val name = text(op["op"])
    if (name != "remove" && !PrototypeDataValues.isScalar(op["value"])) {
      reject("$at.value", "Invalid scalar value")
    }
    val state = spec["state"] as? JsonObject ?: JsonObject(emptyMap())
    if (name != "add" && key !in state) reject("$at.path", "Path does not exist")
    if (name == "test" && tests == StateTests.SKIP) return spec
    var changed = member(state, key, op, at)
    if (name != "test") changed = clampPagerState(spec, changed, key)
    return if (name == "test") spec else JsonObject(spec + ("state" to changed))
  }

  /** An integer written to a pager's state key stays inside that pager's page range. */
  private fun clampPagerState(spec: JsonObject, changed: JsonObject, key: String): JsonObject {
    val value = (changed[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
    if (value == null || !value.isFinite() || value % 1.0 != 0.0) return changed
    val pager =
      PrototypeBundleSpec.nodes(spec).firstOrNull {
        text(it["type"]) == "pager" && text(it["stateKey"]) == key
      }
    val count = (pager?.get("children") as? JsonArray)?.size ?: 0
    return if (count > 0)
      JsonObject(changed + (key to JsonPrimitive(value.coerceIn(0.0, (count - 1).toDouble()))))
    else changed
  }
}
