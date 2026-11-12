package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeCollectionRules.primitiveValid
import dev.jasonpearson.automobile.protocol.PrototypeCollectionRules.visitArray
import dev.jasonpearson.automobile.protocol.PrototypeCollectionRules.visitChoice
import dev.jasonpearson.automobile.protocol.PrototypeCollectionRules.visitMap
import dev.jasonpearson.automobile.protocol.PrototypeCollectionRules.visitRecord
import dev.jasonpearson.automobile.protocol.PrototypeCollectionRules.visitScreenMap
import dev.jasonpearson.automobile.protocol.PrototypeDataRules.dataError
import dev.jasonpearson.automobile.protocol.PrototypeObjectRules.visitObject
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.definitions
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_ACTION_DEPTH
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_CONDITION_DEPTH
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_DEPTH
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_SELECTOR_DEPTH
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

internal object PrototypeStructuralWalk {
  fun walk(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? =
    when (rule.text("kind")) {
      "ref" -> visitReference(value, rule, path, context, depth)
      "tagged" -> visitTagged(value, rule, path, context, depth)
      "object" -> visitObject(value, rule, path, context, depth)
      "array" -> visitArray(value, rule, path, context, depth)
      "map" -> visitMap(value, rule, path, context, depth)
      "screenMap" -> visitScreenMap(value, rule, path, context, depth)
      "record" -> visitRecord(value, rule, path, context, depth)
      "choice" -> visitChoice(value, rule, path, context, depth)
      "data" -> dataError(value)
      "strings" -> PrototypeStringsRules.tableError(value)
      else ->
        if (primitiveValid(value, rule)) null
        else
          fail(path, "Invalid ${rule.text("kind").takeUnless { it == "boundKey" } ?: "key"} value")
    }

  fun visitReference(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val target = definitions.getValue(checkNotNull(rule.text("name"))).jsonObject
    if (rule.text("name") == "iconName" && !primitiveValid(value, target)) {
      return fail(path, iconNameError(value, target))
    }
    if (rule.text("name") == "container") return visitContainer(value, target, path, context, depth)
    val itemImages =
      if (rule.text("name") == "item") prototypeImageSlotUses((value as? JsonObject)?.get("image"))
      else 0
    if (itemImages > 0) {
      context.screens.charge(0, itemImages)?.let {
        return fail("$path.image", it.message)
      }
    }
    if (rule.text("name") == "condition") return visitCondition(value, target, path, context, depth)
    if (rule.text("name") == "action") return visitAction(value, target, path, context, depth)
    if (rule.text("name") != "node") return walk(value, target, path, context, depth)
    return visitNode(value, target, path, context, depth)
  }

  private fun iconNameError(value: JsonElement, target: JsonObject): String {
    val query = (value as? JsonPrimitive)?.content.orEmpty().lowercase().take(128)
    val suggestions =
      target
        .getValue("values")
        .jsonArray
        .map { (it as JsonPrimitive).content }
        .filter { query.isNotEmpty() && (it.contains(query) || query.contains(it)) }
        .sortedWith(compareBy<String> { kotlin.math.abs(it.length - query.length) }.thenBy { it })
        .take(3)
    val hint =
      if (suggestions.isEmpty()) " Choose an allowed icon name."
      else " Did you mean ${suggestions.joinToString { "\"$it\"" }}?"
    return "Invalid enum value: Unknown prototype icon name $value.$hint Browse automobile:prototype/icons?query=<substring> for allowed names."
  }

  private fun visitNode(
    value: JsonElement,
    target: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    if (onAppearNeedsVisibility(value, path))
      return fail("$path.onAppear", "onAppear requires visibleWhen or the root")
    val node = value as? JsonObject ?: return fail(path, "Expected object")
    context.nodes.add(Located(node, path))
    context.screens.charge(1, 0)?.let {
      return fail(path, it.message)
    }
    if (depth + 1 > MAX_PROTOTYPE_DEPTH) return fail(path, "Tree depth limit exceeded")
    context.screens.charge(0, prototypeNodeImageUses(node))?.let {
      return fail(path, it.message)
    }
    if (
      "keyframes" in node &&
        ++context.keyframeNodes > PrototypeSpecValidator.MAX_PROTOTYPE_KEYFRAME_NODES
    )
      return fail("$path.keyframes", "Keyframe node limit exceeded")
    if ("attentionLoop" in node && ++context.loopNodes > PrototypeSpecValidator.MAX_PROTOTYPE_LOOPS)
      return fail("$path.attentionLoop", "Loop node limit exceeded")
    if (prototypeVideoNodeOverLimit(node) { ++context.videoNodes })
      return fail(path, "Video node limit exceeded")
    PrototypeEffectRules.charge(node, path, context)?.let {
      return it
    }
    return walk(value, target, path, context, depth + 1)
  }

  private fun onAppearNeedsVisibility(value: JsonElement, path: String): Boolean =
    value is JsonObject &&
      value["onAppear"] != null &&
      path != "root" &&
      value["visibleWhen"] == null

  fun visitContainer(
    value: JsonElement,
    target: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    context.selectorDepth++
    if (context.selectorDepth > MAX_PROTOTYPE_SELECTOR_DEPTH)
      return fail(path, "Selector depth limit exceeded")
    val error = walk(value, target, path, context, depth)
    context.selectorDepth--
    return error
  }

  fun visitCondition(
    value: JsonElement,
    target: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    context.conditionDepth++
    if (context.conditionDepth > MAX_PROTOTYPE_CONDITION_DEPTH)
      return fail(path, "Condition depth limit exceeded")
    val error = walk(value, target, path, context, depth)
    context.conditionDepth--
    return error
  }

  /** A `request` nests actions in `onSuccess` and `onError`; a top-level action is level 1. */
  fun visitAction(
    value: JsonElement,
    target: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    context.actionDepth++
    if (context.actionDepth > MAX_PROTOTYPE_ACTION_DEPTH)
      return fail(path, "Action nesting limit exceeded")
    val error = walk(value, target, path, context, depth)
    context.actionDepth--
    return error
  }

  fun visitTagged(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val data = value as? JsonObject ?: return fail(path, "Expected object")
    val variant =
      rule.getValue("variants").jsonObject[data.text("type")] as? JsonObject
        ?: return fail(keyPath(path, "type"), "Unknown or missing discriminator")
    if (rule === definitions["action"]) context.actions.add(Located(data, path))
    return walk(data, variant, path, context, depth)
  }
}
