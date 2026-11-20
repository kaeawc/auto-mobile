package dev.jasonpearson.automobile.protocol

import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import kotlinx.serialization.json.*

fun interface PrototypeIdGenerator {
  fun next(): String
}

fun interface PrototypeClock {
  fun nowEpochMs(): Long
}

object SystemPrototypeIdGenerator : PrototypeIdGenerator {
  override fun next(): String = UUID.randomUUID().toString()
}

object SystemPrototypeClock : PrototypeClock {
  override fun nowEpochMs(): Long = System.currentTimeMillis()
}

/** Mutable per invocation; a request captures a copy after resolving all its bindings. */
data class PrototypeActionContext(
  val ids: PrototypeIdGenerator = SystemPrototypeIdGenerator,
  val clock: PrototypeClock = SystemPrototypeClock,
  var lastGenerated: String? = null,
)

/** Exact markers only; literal objects traverse in UTF-16 key order, arrays in index order. */
object PrototypeGeneratedValues {
  private val iso = DateTimeFormatterBuilder().appendInstant(3).toFormatter()

  fun form(value: JsonElement?): String? {
    val binding = value as? JsonObject ?: return null
    if (binding.size != 1) return null
    return when {
      binding["generate"] == JsonPrimitive("id") -> "generate"
      binding["now"] in listOf(JsonPrimitive("epochMs"), JsonPrimitive("iso")) -> "now"
      binding["lastGenerated"] == JsonPrimitive(true) -> "lastGenerated"
      else -> null
    }
  }

  fun forms(binding: JsonElement?): List<String> =
    form(binding)?.let(::listOf)
      ?: (binding as? JsonObject)?.get("value")?.let(::literalForms).orEmpty()

  private fun literalForms(value: JsonElement): List<String> =
    form(value)?.let(::listOf) ?: children(value).flatMap(::literalForms)

  private fun children(value: JsonElement): List<JsonElement> =
    when (value) {
      is JsonObject -> value.toSortedMap().values.toList()
      is JsonArray -> value
      else -> emptyList()
    }

  fun resolve(value: JsonElement, context: PrototypeActionContext): JsonElement =
    when (form(value)) {
      "generate" -> JsonPrimitive(context.ids.next().also { context.lastGenerated = it })
      "lastGenerated" -> JsonPrimitive(checkNotNull(context.lastGenerated))
      "now" -> {
        val ms = context.clock.nowEpochMs()
        if ((value as JsonObject)["now"] == JsonPrimitive("iso"))
          JsonPrimitive(iso.format(Instant.ofEpochMilli(ms)))
        else JsonPrimitive(ms)
      }
      else ->
        when (value) {
          is JsonObject -> JsonObject(value.toSortedMap().mapValues { resolve(it.value, context) })
          is JsonArray -> JsonArray(value.map { resolve(it, context) })
          else -> value
        }
    }

  /** Returns null for an ordinary binding, or a resolved value/typed refusal for generated JSON. */
  fun resolveBinding(binding: JsonObject, context: PrototypeActionContext?): PrototypeDataValue? {
    val forms = forms(binding)
    if (forms.isEmpty()) return null
    fun fail(code: PrototypeDataWriteErrorCode, message: String) =
      PrototypeDataValue.Failure(PrototypeDataWriteError(code, message))
    if (context == null)
      return fail(
        if (forms.first() == "lastGenerated") PrototypeDataWriteErrorCode.LAST_GENERATED_UNSET
        else PrototypeDataWriteErrorCode.INVALID_VALUE,
        "Generated bindings require an action-list context",
      )
    var generated = context.lastGenerated != null
    for (form in forms) {
      if (form == "generate") generated = true
      if (form == "lastGenerated" && !generated)
        return fail(
          PrototypeDataWriteErrorCode.LAST_GENERATED_UNSET,
          "No preceding generate in this action list",
        )
    }
    return PrototypeDataValue.Resolved(resolve(binding["value"] ?: binding, context))
  }

  /**
   * Binding destinations only; payloads and callback lists are never scanned as literals. An
   * `{object}` data value contributes its member bindings in sorted name order (#18826).
   */
  fun bindings(action: JsonObject): List<JsonElement> = buildList {
    val type = (action["type"] as? JsonPrimitive)?.content
    if (type in setOf("setData", "appendData", "upsertData", "prependData")) {
      val members = (action["value"] as? JsonObject)?.get("object") as? JsonObject
      if (members != null) addAll(members.toSortedMap().values) else action["value"]?.let(::add)
    }
    if (type == "setState") action["value"]?.let(::add)
    if (type == "request") {
      for (field in listOf("headers", "query")) addAll(
        (action[field] as? JsonObject).orEmpty().toSortedMap().values,
      )
      val body = action["body"] as? JsonObject
      when {
        body?.get("form") is JsonObject ->
          addAll(body.getValue("form").jsonObject.toSortedMap().values)
        body?.get("multipart") is JsonArray ->
          addAll(
            body.getValue("multipart").jsonArray.mapNotNull { (it as? JsonObject)?.get("value") },
          )
        else -> action["body"]?.let(::add)
      }
    }
    if (type in setOf("setData", "removeData", "request"))
      (action["where"] as? JsonObject)?.get("equals")?.let(::add)
  }

  fun needsDataV2(action: JsonObject): Boolean {
    val type = (action["type"] as? JsonPrimitive)?.content
    if (
      type !in
        setOf(
          "setData",
          "appendData",
          "upsertData",
          "prependData",
          "removeData",
          "setState",
          "request",
        )
    )
      return false
    return "where" in action ||
      "member" in action ||
      bindings(action).any { forms(it).isNotEmpty() }
  }

  internal fun error(actions: List<PrototypeStateChecks.Located>): PrototypeSpecError? {
    val lists = actions.groupBy { it.path.substringBeforeLast('[') }
    fun check(path: String, inherited: Boolean): PrototypeSpecError? {
      var generated = inherited
      for (action in lists[path].orEmpty()) {
        for (form in bindings(action.value).flatMap(::forms)) {
          if (form == "generate") generated = true
          if (form == "lastGenerated" && !generated)
            return PrototypeSpecError(
              action.path,
              "lastGenerated_unset: no preceding generate in this action list",
            )
        }
        for (branch in listOf("onSuccess", "onError")) check("${action.path}.$branch", generated)
          ?.let {
            return it
          }
      }
      return null
    }
    return lists.keys
      .filterNot { it.endsWith(".onSuccess") || it.endsWith(".onError") }
      .firstNotNullOfOrNull { check(it, false) }
  }
}
