package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeRepeatKeyBindings.bound
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTextChecks.RepeatState
import dev.jasonpearson.automobile.protocol.PrototypeRepeatValidator.Scope
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.stateKeyPattern
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object PrototypeRepeatFields {
  fun fail(path: String, message: String) = PrototypeSpecError(path, message)

  fun JsonObject.text(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

  fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

  fun hasPlaceholder(text: String, alias: String): Boolean =
    PrototypeRepeatTemplate.segments(text, alias).any { it !is PrototypeRepeatSegment.Literal }

  fun unknownField(
    segments: List<PrototypeRepeatSegment>,
    path: String,
    scope: Scope,
  ): PrototypeSpecError? {
    val names = segments.filterIsInstance<PrototypeRepeatSegment.Field>().map { it.name }.distinct()
    for (name in names) {
      if (!scope.items.all { it.containsKey(name) }) {
        return fail(path, "Unknown repeat field ${JsonPrimitive(name)}")
      }
    }
    return null
  }

  /** An emit name must stay non-empty for every item once its placeholders are bound. */
  fun emptyEmitName(
    segments: List<PrototypeRepeatSegment>,
    path: String,
    scope: Scope,
  ): PrototypeSpecError? {
    val empty =
      scope.items.withIndex().indexOfFirst { (index, item) ->
        PrototypeRepeatTokens.bind(segments, scope.alias, item, index).isEmpty()
      }
    return if (empty < 0) null else fail(path, "Expanded emit name is empty for item $empty")
  }

  /** A state key must bind to a literal key for every item; the failing item is reported. */
  fun invalidBoundKey(
    key: String,
    segments: List<PrototypeRepeatSegment>,
    path: String,
    scope: Scope,
  ): PrototypeSpecError? {
    val pattern =
      if (scope.alias != "route" && PrototypeRouteRules.fields(key).isNotEmpty())
        PrototypeSpecContract.patterns.getValue("boundKey")
      else stateKeyPattern
    if (segments.all { it is PrototypeRepeatSegment.Literal }) {
      return if (pattern.matches(key)) null else fail(path, "Invalid key value")
    }
    for ((index, item) in scope.items.withIndex()) {
      val bound = PrototypeRepeatTokens.bind(segments, scope.alias, item, index)
      val invalidRepeatPart =
        segments.filterIsInstance<PrototypeRepeatSegment.Field>().any {
          !PrototypeSpecContract.pathKeyPattern.matches(
            "_" +
              PrototypeRepeatTemplate.bind("{${scope.alias}.${it.name}}", scope.alias, item, index),
          )
        }
      if (invalidRepeatPart || !pattern.matches(bound)) {
        return fail(
          if (scope.pathBound) "${scope.path}.repeat.items.path"
          else "${scope.path}.repeat.items[$index]",
          "Bound state key ${JsonPrimitive(bound)} is invalid" +
            if (scope.pathBound) " (repeat item $index)" else "",
        )
      }
    }
    return null
  }

  fun chargeText(state: RepeatState, length: Long): Boolean {
    state.total += length
    return state.total <= PrototypeSpecValidator.MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL
  }

  fun dataTextError(path: String, state: RepeatState): PrototypeSpecError =
    fail(
      path,
      if (state.total > PrototypeSpecValidator.MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL)
        "Substituted text total limit exceeded"
      else "Substituted text length limit exceeded",
    )
}
