package dev.jasonpearson.automobile.protocol

import java.time.DateTimeException
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.regex.Pattern
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement

const val MAX_PROTOTYPE_CHECK_VALUE_LENGTH = 4096

data class PrototypeCheckEvaluation(val valid: Boolean, val firstFailingMessage: String? = null)

/** Pure checks over a scalar; time pickers call this independently for hour and minute bindings. */
object PrototypeChecks {
  // ECMAScript whitespace for required and formats; portable pattern s is ASCII instead.
  // Keep these as literals so the source-level ICU guard can inspect each complete pattern.
  private val blank =
    Pattern.compile(
      "[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*"
    )
  private val formats =
    mapOf(
      PrototypeCheckFormat.EMAIL to
        Pattern.compile(
          "[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF@]+@[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF@]+\\.[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF@]+"
        ),
      PrototypeCheckFormat.PHONE to Pattern.compile("\\+?[0-9 ()-]{7,15}"),
      PrototypeCheckFormat.DIGITS to Pattern.compile("[0-9]+"),
      PrototypeCheckFormat.DECIMAL to Pattern.compile("-?[0-9]+(\\.[0-9]+)?"),
      PrototypeCheckFormat.URL to
        Pattern.compile(
          "https?://[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF/?#]+([/?#][^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*)?"
        ),
    )

  fun formatPasses(text: String, format: PrototypeCheckFormat): Boolean =
    formats.getValue(format).matcher(text).matches() &&
      (format != PrototypeCheckFormat.PHONE || text.count { it in '0'..'9' } >= 7)

  fun evaluate(
    value: PrototypeScalar?,
    checks: List<PrototypeCheck>,
    nodeType: String,
  ): PrototypeCheckEvaluation =
    evaluate(
      value?.let { Json.encodeToJsonElement(PrototypeScalar.serializer(), it) },
      checks,
      nodeType,
    )

  fun evaluate(
    value: JsonElement?,
    checks: List<PrototypeCheck>,
    nodeType: String,
  ): PrototypeCheckEvaluation {
    val failed = checks.firstOrNull { !passes(value, it, nodeType) }
    return if (failed == null) PrototypeCheckEvaluation(true)
    else PrototypeCheckEvaluation(false, failed.message)
  }

  private fun required(value: JsonPrimitive?, nodeType: String): Boolean =
    when (nodeType) {
      "checkbox",
      "switch" -> value?.isString == false && value.booleanOrNull == true
      "slider",
      "timePicker" -> value?.isString == false && value.doubleOrNull?.isFinite() == true
      else -> value?.isString == true && !blank.matcher(value.content).matches()
    }

  private fun passes(value: JsonElement?, check: PrototypeCheck, nodeType: String): Boolean {
    val primitive = value as? JsonPrimitive
    if (check is PrototypeCheck.Required) return required(primitive, nodeType)
    if (
      value == null ||
        value == JsonNull ||
        (primitive?.isString == true && primitive.content.isEmpty())
    )
      return true
    val text = primitive?.takeIf { it.isString }?.content.orEmpty()
    return when (check) {
      is PrototypeCheck.Required -> required(primitive, nodeType)
      is PrototypeCheck.MinLength -> text.length >= check.minLength
      is PrototypeCheck.MaxLength -> text.length <= check.maxLength
      is PrototypeCheck.Pattern ->
        PrototypeCheckPattern.matches(check.pattern, text.take(MAX_PROTOTYPE_CHECK_VALUE_LENGTH))
      is PrototypeCheck.Format ->
        formatPasses(text.take(MAX_PROTOTYPE_CHECK_VALUE_LENGTH), check.format)
      is PrototypeCheck.Min -> numeric(value, nodeType)?.let { it >= check.min } == true
      is PrototypeCheck.Max -> numeric(value, nodeType)?.let { it <= check.max } == true
    }
  }

  private fun numeric(value: JsonElement, nodeType: String): Double? {
    val primitive = value as? JsonPrimitive ?: return null
    if (nodeType == "datePicker" && primitive.isString) {
      return try {
        // Date.parse normalizes overflow days in a valid month; reproduce that JS behavior.
        val parts = primitive.content.split('-')
        if (parts.size != 3 || parts[0].length != 4 || parts[1].length != 2 || parts[2].length != 2)
          return null
        if (parts.any { part -> part.any { it !in '0'..'9' } }) return null
        val year = parts[0].toIntOrNull() ?: return null
        val month = parts[1].toIntOrNull() ?: return null
        val day = parts[2].toIntOrNull() ?: return null
        if (month !in 1..12 || day !in 1..31) return null
        LocalDate.of(year, month, 1)
          .plusDays((day - 1).toLong())
          .atStartOfDay()
          .toInstant(ZoneOffset.UTC)
          .toEpochMilli()
          .toDouble()
      } catch (_: DateTimeException) {
        null
      }
    }
    return primitive.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
  }
}
