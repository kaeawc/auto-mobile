package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * A data action `value` of `{object: {member: binding}}` (#18826): an object of named members, each
 * one flat binding form, that `prototype_data_actions_v3` gates. Mirrors the TypeScript host.
 */
object PrototypeObjectDataValue {
  private val writeTypes = setOf("setData", "appendData", "prependData", "upsertData")

  /** A write whose `value` is an `{object}` of member bindings. */
  fun isObjectValueAction(action: JsonObject): Boolean =
    action.text("type") in writeTypes &&
      (action["value"] as? JsonObject)?.containsKey("object") == true

  /**
   * Static checks on the members of [value]'s `{object}`: an `upsertData` key's first pointer
   * segment must name a member, and when that member is a literal the rest must resolve non-null in
   * it; a literal member must be data.
   */
  internal fun literalError(
    value: JsonObject,
    members: JsonObject,
    path: String,
    budget: PrototypeRuntimeBudget,
  ): PrototypeSpecError? {
    if (value.text("type") == "upsertData" && !keyNamesMember(value.text("key").orEmpty(), members))
      return fail(
        "$path.key",
        "upsertData key pointer must start with an object value member, non-null when that member is a literal",
      )
    for (name in members.keys.sorted()) {
      val literal = (members[name] as? JsonObject)?.get("value") ?: continue
      if (PrototypeDataRules.dataError(JsonObject(mapOf("value" to literal)), budget) != null)
        return fail(
          "$path.value.object.$name.value",
          "A data write value must be a string, boolean, finite number, array or object",
        )
    }
    return null
  }

  private fun keyNamesMember(key: String, members: JsonObject): Boolean {
    val name = key.split('/').getOrNull(1).orEmpty()
    val member = members[name] as? JsonObject ?: return false
    val literal = member["value"] ?: return true
    val rest = key.drop(name.length + 1)
    val identity = if (rest.isEmpty()) literal else PrototypeDataPointer.resolve(literal, rest)
    return identity != null && identity !is JsonNull
  }

  /**
   * Each member resolves like a top-level value, in sorted name order (the order iOS and the host
   * use, so a `{generate}` member precedes a `{lastGenerated}` one identically); the first
   * unresolved member fails the write.
   */
  fun resolve(members: JsonObject?, inputs: EmitContextInputs): PrototypeDataValue {
    members ?: return invalid("An object data write value needs member bindings")
    val resolved = LinkedHashMap<String, JsonElement>()
    for ((name, member) in members.toSortedMap()) {
      val binding = member as? JsonObject
      val value =
        if (binding == null || "object" in binding)
          invalid("Object member $name must be a flat value binding")
        else PrototypeDataWriter.resolveValue(binding, inputs)
      when (value) {
        is PrototypeDataValue.Failure -> return value
        is PrototypeDataValue.Resolved -> resolved[name] = value.value
      }
    }
    return PrototypeDataValue.Resolved(JsonObject(resolved))
  }

  private fun invalid(message: String) =
    PrototypeDataValue.Failure(
      PrototypeDataWriteError(PrototypeDataWriteErrorCode.INVALID_VALUE, message),
    )

  /**
   * A data action's value bound to a repeat row: each `{object}` member binds with
   * [PrototypeRepeatTemplate.bindBinding]; any other value is one binding.
   */
  fun bindToRow(
    binding: EmitContextBinding,
    alias: String,
    item: Map<String, JsonElement>,
    index: Int,
  ): EmitContextBinding {
    val members =
      binding["object"] as? JsonObject
        ?: return PrototypeRepeatTemplate.bindBinding(binding, alias, item, index)
    val bound = members.mapValues { (_, member) ->
      (member as? JsonObject)?.let { PrototypeRepeatTemplate.bindBinding(it, alias, item, index) }
        ?: member
    }
    return JsonObject(binding + ("object" to JsonObject(bound)))
  }
}
