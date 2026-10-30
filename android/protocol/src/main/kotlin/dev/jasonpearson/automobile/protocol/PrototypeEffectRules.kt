package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.definitions
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * `style.effects` count limits (#15128), the Kotlin twin of `prototypeEffects.ts`: every declared
 * effect counts against `MAX_PROTOTYPE_EFFECTS`, and those with an `animate` also against
 * `MAX_PROTOTYPE_ANIMATED_EFFECTS`, over the node's own style and every `styleWhen` style.
 */
internal object PrototypeEffectRules {
  class Uses(val total: Int, val animated: Int)

  /** The contract's per-list maximum; a longer list is a structural error the walk reports. */
  private val maxPerList: Int =
    definitions
      .getValue("style")
      .jsonObject
      .getValue("fields")
      .jsonObject
      .getValue("effects")
      .jsonObject
      .getValue("rule")
      .jsonObject
      .getValue("max")
      .jsonPrimitive
      .int

  fun uses(node: JsonObject): Uses {
    val styles =
      listOf(node["style"]) +
        (node["styleWhen"] as? JsonArray).orEmpty().map { (it as? JsonObject)?.get("style") }
    val repeatedIcon =
      node["type"]?.jsonPrimitive?.content == "icon" &&
        (node["effect"] as? JsonObject)?.containsKey("repeat") == true
    var total = 0
    var animated = if (repeatedIcon) 1 else 0
    for (style in styles) {
      val effects =
        ((style as? JsonObject)?.get("effects") as? JsonArray).orEmpty().take(maxPerList)
      total += effects.size
      animated += effects.count { (it as? JsonObject)?.containsKey("animate") == true }
    }
    return Uses(total, animated)
  }

  /** Adds [node]'s effects to the spec-wide totals; the node that crosses a limit is reported. */
  fun charge(node: JsonObject, path: String, context: Context): PrototypeSpecError? {
    val uses = uses(node)
    context.effects += uses.total
    context.animatedEffects += uses.animated
    return when {
      context.effects > PrototypeSpecValidator.MAX_PROTOTYPE_EFFECTS ->
        fail(path, "Effect limit exceeded")
      context.animatedEffects > PrototypeSpecValidator.MAX_PROTOTYPE_ANIMATED_EFFECTS ->
        fail(path, "Animated effect limit exceeded")
      else -> null
    }
  }

  /** The expanded-tree counterpart: [at] is the node, or its enclosing `repeat` for a template. */
  fun chargeExpanded(
    node: JsonObject,
    at: String,
    budget: PrototypeRepeatTree.Budget,
  ): PrototypeSpecError? {
    val uses = uses(node)
    budget.effects += uses.total
    budget.animatedEffects += uses.animated
    return when {
      budget.effects > PrototypeSpecValidator.MAX_PROTOTYPE_EFFECTS ->
        fail(at, "Expanded effect limit exceeded")
      budget.animatedEffects > PrototypeSpecValidator.MAX_PROTOTYPE_ANIMATED_EFFECTS ->
        fail(at, "Expanded animated effect limit exceeded")
      else -> null
    }
  }
}
