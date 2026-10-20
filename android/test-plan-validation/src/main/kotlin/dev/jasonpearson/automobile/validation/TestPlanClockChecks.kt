package dev.jasonpearson.automobile.validation

import dev.jasonpearson.automobile.validation.TestPlanDevices.effectiveCoordinationField
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

internal object TestPlanClockChecks {
  // Same inclusive UTC instants as DeviceClock.ts; compare Instants, never local years.
  val MIN_DEVICE_CLOCK_INSTANT: Instant = Instant.parse("2000-01-01T00:00:00Z")
  val MAX_DEVICE_CLOCK_INSTANT: Instant = Instant.parse("2100-01-01T00:00:00Z")

  /** networknt draft-07 ignores formatMinimum/Maximum; match the TS semantic check. */
  fun validateClockInstantWindows(parsedObject: Any?): List<ValidationError> {
    val steps = (parsedObject as? Map<*, *>)?.get("steps") as? List<*> ?: return emptyList()
    return steps.flatMapIndexed { index, raw ->
      val step = raw as? Map<*, *> ?: return@flatMapIndexed emptyList()
      if (step["tool"] != "setDeviceState") return@flatMapIndexed emptyList()
      val clock =
        effectiveCoordinationField(step, "clock") as? Map<*, *> ?: return@flatMapIndexed emptyList()
      if (clock["mode"] != "set") return@flatMapIndexed emptyList()
      val text = clock["instant"] as? String ?: return@flatMapIndexed emptyList()
      val instant =
        try {
          OffsetDateTime.parse(normalizeClockInstantFraction(text)).toInstant()
        } catch (e: DateTimeParseException) {
          // Schema syntax errors are reported separately; retain a useful field error too.
          null
        }
      if (
        instant != null &&
          instant >= MIN_DEVICE_CLOCK_INSTANT &&
          instant <= MAX_DEVICE_CLOCK_INSTANT
      ) {
        emptyList()
      } else {
        val params = step["params"] as? Map<*, *>
        val prefix = if (params?.containsKey("clock") == true) "params." else ""
        listOf(
          ValidationError(
            field = "steps[$index].${prefix}clock.instant",
            message =
              "Clock instant must be within 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z (inclusive, after offset normalization).",
            severity = ValidationSeverity.ERROR,
          ),
        )
      }
    }
  }

  fun normalizeClockInstantFraction(text: String): String {
    return text.replace(Regex("\\.(\\d{10,})")) { match ->
      val digits = match.groupValues[1]
      val retained = digits.take(9)
      // Preserve a positive subnanosecond fraction at the inclusive window boundaries.
      val fraction =
        if (retained.all { it == '0' } && digits.drop(9).any { it != '0' }) "000000001"
        else retained
      ".$fraction"
    }
  }

  /** The schema's date-time format checker also limits fractions to nanoseconds. */
  fun normalizeClockFractionsForSchema(parsedObject: Any?): Any? {
    val plan = parsedObject as? Map<*, *> ?: return parsedObject
    val steps = plan["steps"] as? List<*> ?: return parsedObject
    fun normalizeFields(fields: Map<*, *>): Map<*, *> {
      val clock = fields["clock"] as? Map<*, *> ?: return fields
      if (clock["mode"] != "set") return fields
      val text = clock["instant"] as? String ?: return fields
      return fields + ("clock" to (clock + ("instant" to normalizeClockInstantFraction(text))))
    }
    return plan +
      ("steps" to
        steps.map { raw ->
          val step = raw as? Map<*, *> ?: return@map raw
          if (step["tool"] != "setDeviceState") return@map raw
          val inline = normalizeFields(step)
          val params = step["params"] as? Map<*, *> ?: return@map inline
          inline + ("params" to normalizeFields(params))
        })
  }
}
