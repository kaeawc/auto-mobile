package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.definitions
import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.limits
import dev.jasonpearson.automobile.protocol.PrototypeSpecInput.validateInput
import dev.jasonpearson.automobile.protocol.PrototypeStateBindings.boundKeys
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.checkedStateErrors
import dev.jasonpearson.automobile.protocol.PrototypeStructuralWalk.walk
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Canonical errors are computed from JSON structure, never from decoder exception strings. */
data class PrototypeSpecError(val path: String, val message: String)

sealed class PrototypeSpecValidation {
  data class Success(val spec: PrototypeSpec) : PrototypeSpecValidation()

  data class Failure(val error: PrototypeSpecError) : PrototypeSpecValidation()
}

/** Prepared rules for successive states of one unchanged spec structure. */
fun interface PrototypeStateWriteValidator {
  fun validate(state: Map<String, PrototypeScalar>): PrototypeSpecError?
}

object PrototypeSpecValidator {
  internal val stateKeyPattern = PrototypeSpecContract.stateKeyPattern

  internal val json = PrototypeSpecContract.json

  val MAX_PROTOTYPE_TEXT_SPANS: Int = limit("MAX_PROTOTYPE_TEXT_SPANS")
  val MAX_PROTOTYPE_NODES: Int = limit("MAX_PROTOTYPE_NODES")
  val MAX_PROTOTYPE_PAGER_DP: Int = limit("MAX_PROTOTYPE_PAGER_DP")
  val MAX_PROTOTYPE_DEPTH: Int = limit("MAX_PROTOTYPE_DEPTH")
  val MAX_PROTOTYPE_IMAGES: Int = limit("MAX_PROTOTYPE_IMAGES")
  val MAX_PROTOTYPE_EFFECTS: Int = limit("MAX_PROTOTYPE_EFFECTS")
  val MAX_PROTOTYPE_ANIMATED_EFFECTS: Int = limit("MAX_PROTOTYPE_ANIMATED_EFFECTS")
  val MAX_PROTOTYPE_SPEC_BYTES: Int = limit("MAX_PROTOTYPE_SPEC_BYTES")
  val MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES: Int = limit("MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES")
  val MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES: Int = limit("MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES")
  val MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH: Int = limit("MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH")
  val MAX_PROTOTYPE_SELECTOR_DEPTH: Int = limit("MAX_PROTOTYPE_SELECTOR_DEPTH")
  val MAX_PROTOTYPE_CONDITION_DEPTH: Int = limit("MAX_PROTOTYPE_CONDITION_DEPTH")
  val MAX_PROTOTYPE_PATCH_OPS: Int = limit("MAX_PROTOTYPE_PATCH_OPS")
  val MAX_PROTOTYPE_DATA_BYTES: Int = limit("MAX_PROTOTYPE_DATA_BYTES")
  val MAX_PROTOTYPE_DATA_WRITE_BYTES: Int = limit("MAX_PROTOTYPE_DATA_WRITE_BYTES")
  val MAX_PROTOTYPE_STORAGE_BYTES: Int = limit("MAX_PROTOTYPE_STORAGE_BYTES")
  val MAX_PROTOTYPE_STORAGE_KEYS: Int = limit("MAX_PROTOTYPE_STORAGE_KEYS")
  val MAX_PROTOTYPE_DATA_DEPTH: Int = limit("MAX_PROTOTYPE_DATA_DEPTH")
  val MAX_PROTOTYPE_LIST_ITEMS: Int = limit("MAX_PROTOTYPE_LIST_ITEMS")
  val MAX_PROTOTYPE_DATA_ARRAY_ITEMS: Int = limit("MAX_PROTOTYPE_DATA_ARRAY_ITEMS")
  val MAX_PROTOTYPE_REPEAT_PATH_CELLS: Int = limit("MAX_PROTOTYPE_REPEAT_PATH_CELLS")
  val MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH: Int = limit("MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH")
  val MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL: Int = limit("MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL")
  val MAX_PROTOTYPE_DATA_POINTER_LENGTH: Int = limit("MAX_PROTOTYPE_DATA_POINTER_LENGTH")
  val MAX_PROTOTYPE_STACK_SCREENS: Int = limit("MAX_PROTOTYPE_STACK_SCREENS")
  val MAX_PROTOTYPE_STACK_DEPTH: Int = limit("MAX_PROTOTYPE_STACK_DEPTH")
  val DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS: Int = limit("DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS")
  val MAX_PROTOTYPE_REQUEST_TIMEOUT_MS: Int = limit("MAX_PROTOTYPE_REQUEST_TIMEOUT_MS")
  val MAX_PROTOTYPE_RESPONSE_BYTES: Int = limit("MAX_PROTOTYPE_RESPONSE_BYTES")
  val MAX_PROTOTYPE_REQUESTS_IN_FLIGHT: Int = limit("MAX_PROTOTYPE_REQUESTS_IN_FLIGHT")
  val MAX_PROTOTYPE_ACTION_DEPTH: Int = limit("MAX_PROTOTYPE_ACTION_DEPTH")
  val MAX_PROTOTYPE_TIMERS: Int = limit("MAX_PROTOTYPE_TIMERS")
  val MAX_PROTOTYPE_TIMER_RUNS: Int = limit("MAX_PROTOTYPE_TIMER_RUNS")
  val MAX_PROTOTYPE_TIMER_MS: Int = limit("MAX_PROTOTYPE_TIMER_MS")
  internal val maxRepeatItems: Int =
    definitions
      .getValue("repeat")
      .jsonObject
      .getValue("fields")
      .jsonObject
      .getValue("items")
      .jsonObject
      .getValue("rule")
      .jsonObject
      .getValue("options")
      .jsonArray
      .first { it.jsonObject.text("kind") == "array" }
      .jsonObject
      .getValue("max")
      .jsonPrimitive
      .int
  val nodeTypes: Set<String> = variants("node")
  val actionTypes: Set<String> = variants("action")
  val placementTypes: Set<String> = variants("placement")

  private fun limit(name: String) = limits.getValue(name).jsonPrimitive.int

  private fun variants(name: String) =
    definitions.getValue(name).jsonObject.getValue("variants").jsonObject.keys

  fun validate(
    input: String,
    supportedCapabilities: Set<String>? = null,
    library: Boolean = false,
    shareAssetIds: Set<String>? = null,
  ): PrototypeSpecValidation {
    val context = Context()
    val result = PrototypeSpecInput.validateInput(input, context)
    if (result is PrototypeSpecValidation.Failure) return result
    val error =
      PrototypeStrictPolicy.error(
        checkNotNull(context.root).jsonObject,
        supportedCapabilities,
        library,
        context,
        shareAssetIds,
      )
    return if (error == null) result else PrototypeSpecValidation.Failure(error)
  }

  fun validate(
    input: ByteArray,
    supportedCapabilities: Set<String>? = null,
    library: Boolean = false,
    shareAssetIds: Set<String>? = null,
  ): PrototypeSpecValidation =
    if (input.size > MAX_PROTOTYPE_SPEC_BYTES)
      PrototypeSpecValidation.Failure(PrototypeSpecError("$", "Spec byte limit exceeded"))
    else
      try {
        validate(
          input.toString(Charsets.UTF_8).also {
            require(it.toByteArray(Charsets.UTF_8).contentEquals(input)) { "Invalid UTF-8" }
          },
          supportedCapabilities,
          library,
          shareAssetIds,
        )
      } catch (_: IllegalArgumentException) {
        PrototypeSpecValidation.Failure(PrototypeSpecError("$", "Invalid UTF-8"))
      }

  /** The caller supplies the same compact encoder it uses for full-spec writes. */
  fun prepareStateWrites(spec: PrototypeSpec, encoder: Json): PrototypeStateWriteValidator {
    val encoded =
      try {
        encoder.encodeToString(PrototypeSpec.serializer(), spec)
      } catch (_: IllegalArgumentException) {
        // An unserializable base may become serializable when the write replaces its state.
        // Defer to the full write path, which preserves its original exception or validation error.
        return fullStateWrites(spec, encoder)
      }
    val context = Context()
    if (PrototypeSpecInput.validateInput(encoded, context) !is PrototypeSpecValidation.Success) {
      return fullStateWrites(spec, encoder)
    }
    val value = checkNotNull(context.root).jsonObject
    val checked = checkNotNull(context.stateBindings)
    // Only bindings can change their verdict. Static-only nodes/actions passed full validation.
    checked.nodes.removeAll {
      boundKeys(it.value).isEmpty() &&
        it.value["enabledWhen"] == null &&
        it.value["visibleWhen"] == null &&
        it.value["styleWhen"] == null
    }
    checked.actions.removeAll {
      it.value.text("type") !in stateWriteActionTypes && it.value["requireValid"] == null
    }
    val serializer = MapSerializer(String.serializer(), PrototypeScalar.serializer())
    // An omitted state adds its field name and comma; a present state replaces only its value.
    // Compact serialization preserves all non-state bytes, including UTF-8 and escaped strings.
    val fixedBytes =
      encoded.toByteArray(Charsets.UTF_8).size -
        (value["state"]?.toString()?.toByteArray(Charsets.UTF_8)?.size ?: -",\"state\":".length)
    val stateRule =
      definitions
        .getValue("spec")
        .jsonObject
        .getValue("fields")
        .jsonObject
        .getValue("state")
        .jsonObject
        .getValue("rule")
        .jsonObject
    return PrototypeStateWriteValidator { state ->
      // Encoding first preserves serialization exceptions, including non-finite numbers.
      val encodedState = encoder.encodeToString(serializer, state)
      if (fixedBytes + encodedState.toByteArray(Charsets.UTF_8).size > MAX_PROTOTYPE_SPEC_BYTES) {
        fail("", "Spec byte limit exceeded")
      } else {
        try {
          val stored = json.parseToJsonElement(PrototypeStrictJson.prepare(encodedState))
          if (!validNumberTokens(stored)) fail("", "Invalid JSON")
          else
            walk(stored, stateRule, "state", Context(), 0)
              ?: PrototypeStorageValidation.error(
                JsonObject(value + ("state" to stored)),
                enforceBytes = false,
              )
              ?: PrototypeChannels.error(JsonObject(value + ("state" to stored)))
              ?: checkedStateErrors(checked, buildJsonObject { put("state", stored) })
        } catch (_: IllegalArgumentException) {
          fail("", "Invalid JSON")
        }
      }
    }
  }

  private val stateWriteActionTypes =
    setOf("setState", "toggle", "increment", "decrement", "request", "platform")

  private fun fullStateWrites(spec: PrototypeSpec, encoder: Json) =
    PrototypeStateWriteValidator { state ->
      (validate(encoder.encodeToString(PrototypeSpec.serializer(), spec.copy(state = state)))
          as? PrototypeSpecValidation.Failure)
        ?.error
    }

  internal fun validNumberTokens(root: JsonElement): Boolean =
    PrototypeSpecInput.validNumberTokens(root)

  internal fun dataWriteError(value: JsonObject): PrototypeSpecError? =
    PrototypeDataRules.dataWriteError(value)

  private val datePattern = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
  private val daysInMonth = intArrayOf(31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

  /** A `YYYY-MM-DD` calendar date in 1900..2100, the Material date picker's year range. */
  fun isPrototypeDate(value: String?): Boolean {
    if (value == null || !datePattern.matches(value)) return false
    val (year, month, day) = value.split("-").map(String::toInt)
    if (year !in 1900..2100 || month !in 1..12) return false
    val leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    val days = if (month == 2 && leap) 29 else daysInMonth[month - 1]
    return day in 1..days
  }
}
