package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.icu.text.CompactDecimalFormat
import android.icu.text.DateFormat
import android.icu.text.DisplayContext
import android.icu.text.NumberFormat
import android.icu.text.RelativeDateTimeFormatter
import android.icu.util.Currency
import android.icu.util.ULocale
import dev.jasonpearson.automobile.protocol.PrototypeDerivedEntry
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.json.*

internal fun interface PrototypeClock {
  fun nowMillis(): Long
}

internal fun interface PrototypeValueFormatter {
  fun format(entry: PrototypeDerivedEntry, input: JsonElement?): String
}

/** Native ICU formatting. Defaults are resolved at use time so localization changes take effect. */
internal class AndroidPrototypeValueFormatter(
  private val locale: Locale? = null,
  private val timeZone: TimeZone? = null,
  private val clock: PrototypeClock = PrototypeClock(System::currentTimeMillis),
) : PrototypeValueFormatter {
  override fun format(entry: PrototypeDerivedEntry, input: JsonElement?): String =
    try {
      val selectedLocale =
        entry.locale?.let(Locale::forLanguageTag) ?: locale ?: Locale.getDefault()
      val kind = entry.format.keys.single()
      val options = entry.format.getValue(kind).jsonObject
      when (kind) {
        "date",
        "time",
        "relative" -> temporal(kind, options, input, selectedLocale, entry.timeZone)
        else -> numeric(kind, options, input, selectedLocale)
      }
    } catch (_: IllegalArgumentException) {
      // Unsupported authored locale, currency or options display as empty text.
      ""
    }

  private fun temporal(
    kind: String,
    options: JsonObject,
    input: JsonElement?,
    locale: Locale,
    zoneOverride: String?,
  ): String {
    val millis = PrototypeFormatTime.epoch(input) ?: return ""
    if (kind == "relative") return relative(millis, locale, options)
    val zone = zoneOverride ?: timeZone?.id ?: TimeZone.getDefault().id
    if (android.icu.util.TimeZone.getCanonicalID(zone) == null) return ""
    val style =
      when (options["style"]?.jsonPrimitive?.content ?: if (kind == "date") "medium" else "short") {
        "long" -> DateFormat.LONG
        "medium" -> DateFormat.MEDIUM
        else -> DateFormat.SHORT
      }
    val formatter =
      if (kind == "date") DateFormat.getDateInstance(style, locale)
      else DateFormat.getTimeInstance(style, locale)
    formatter.timeZone = android.icu.util.TimeZone.getTimeZone(zone)
    return formatter.format(Date(millis))
  }

  private fun numeric(
    kind: String,
    options: JsonObject,
    input: JsonElement?,
    locale: Locale,
  ): String {
    val primitive = input as? JsonPrimitive ?: return ""
    if (primitive.isString) return ""
    val number = primitive.doubleOrNull?.takeIf { it.isFinite() } ?: return ""
    val formatter =
      when (kind) {
        "number" -> NumberFormat.getNumberInstance(locale)
        "percent" -> NumberFormat.getPercentInstance(locale)
        "currency" ->
          NumberFormat.getCurrencyInstance(locale).apply {
            currency = Currency.getInstance(options.getValue("code").jsonPrimitive.content)
          }
        "compact" ->
          CompactDecimalFormat.getInstance(
            ULocale.forLocale(locale),
            if (options["style"]?.jsonPrimitive?.content == "long")
              CompactDecimalFormat.CompactStyle.LONG
            else CompactDecimalFormat.CompactStyle.SHORT,
          )
        else -> return ""
      }
    // Intl uses half-expand; ICU defaults to half-even, which disagrees at currency ties.
    formatter.roundingMode = android.icu.math.BigDecimal.ROUND_HALF_UP
    options["minFraction"]?.jsonPrimitive?.int?.let {
      formatter.minimumFractionDigits = it
      formatter.maximumFractionDigits = maxOf(it, formatter.maximumFractionDigits)
    }
    options["maxFraction"]?.jsonPrimitive?.int?.let {
      formatter.maximumFractionDigits = it
      formatter.minimumFractionDigits = minOf(it, formatter.minimumFractionDigits)
    }
    options["grouping"]?.jsonPrimitive?.boolean?.let { formatter.isGroupingUsed = it }
    return formatter.format(number)
  }

  private fun relative(millis: Long, locale: Locale, options: JsonObject): String {
    val style =
      when (options["style"]?.jsonPrimitive?.content) {
        "short" -> RelativeDateTimeFormatter.Style.SHORT
        "narrow" -> RelativeDateTimeFormatter.Style.NARROW
        else -> RelativeDateTimeFormatter.Style.LONG
      }
    val formatter =
      RelativeDateTimeFormatter.getInstance(
        ULocale.forLocale(locale),
        null,
        style,
        DisplayContext.CAPITALIZATION_NONE,
      )
    val diff = millis - clock.nowMillis()
    if (kotlin.math.abs(diff) < 1000)
      return formatter.format(
        RelativeDateTimeFormatter.Direction.PLAIN,
        RelativeDateTimeFormatter.AbsoluteUnit.NOW,
      )
    val unit = PrototypeFormatTime.relativeUnit(diff)
    val nativeUnit =
      when (unit.second) {
        "year" -> RelativeDateTimeFormatter.RelativeUnit.YEARS
        "month" -> RelativeDateTimeFormatter.RelativeUnit.MONTHS
        "day" -> RelativeDateTimeFormatter.RelativeUnit.DAYS
        "hour" -> RelativeDateTimeFormatter.RelativeUnit.HOURS
        "minute" -> RelativeDateTimeFormatter.RelativeUnit.MINUTES
        else -> RelativeDateTimeFormatter.RelativeUnit.SECONDS
      }
    return formatter.format(
      kotlin.math.abs(diff / unit.first).toDouble(),
      if (diff < 0) RelativeDateTimeFormatter.Direction.LAST
      else RelativeDateTimeFormatter.Direction.NEXT,
      nativeUnit,
    )
  }
}
