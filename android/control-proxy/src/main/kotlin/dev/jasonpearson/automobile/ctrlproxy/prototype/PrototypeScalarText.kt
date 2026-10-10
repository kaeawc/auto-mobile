package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeScalar
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode

/**
 * The text a scalar renders as wherever a spec string interpolates one: `{key}` state placeholders
 * and `repeat` field bindings share this, so a value reads the same in both.
 */
internal fun PrototypeScalar.renderedText(): String =
  when (this) {
    is PrototypeScalar.Text -> value
    is PrototypeScalar.BooleanValue -> value.toString()
    is PrototypeScalar.Numeric -> prototypeNumberText(value)
  }

/**
 * A number as the TypeScript host renders it (`renderScalar` in `prototypeTemplate.ts`). An
 * integral value prints every digit with no decimal point or exponent at any magnitude, and
 * negative zero prints `0`. Any other finite value prints as JavaScript's `String(number)`: the
 * shortest decimal digits that read back as the same double, in plain notation down to `0.000001`
 * and as `<digits>e-<exponent>` below that (`1.5e-7`).
 */
internal fun prototypeNumberText(value: Double): String {
  // JSON cannot carry these and the runtime refuses to step to them; shown as JavaScript would.
  if (!value.isFinite()) return value.toString()
  val exact = BigDecimal(value)
  if (exact.signum() == 0) return "0"
  if (value == Math.floor(value)) return exact.toPlainString()
  val shortest = shortestRoundTrip(value, exact)
  val digits = shortest.unscaledValue().abs().toString()
  // The decimal point sits `pointAt` digits into `digits` (zero or negative: leading zeros).
  val pointAt = digits.length - shortest.scale()
  if (pointAt > MIN_PLAIN_POINT) return shortest.toPlainString()
  val sign = if (shortest.signum() < 0) "-" else ""
  val fraction = if (digits.length > 1) "." + digits.substring(1) else ""
  return "$sign${digits[0]}${fraction}e${pointAt - 1}"
}

/**
 * The fewest significant digits that still parse back to [value]. Rounding the exact binary value
 * half-even gives the nearest decimal of each length, which is the one JavaScript picks. Does not
 * depend on the platform's `Double.toString`, which is not shortest on older runtimes.
 */
private fun shortestRoundTrip(value: Double, exact: BigDecimal): BigDecimal =
  (1..MAX_DOUBLE_DIGITS)
    .asSequence()
    .map { exact.round(MathContext(it, RoundingMode.HALF_EVEN)) }
    .first { it.toDouble() == value }
    .stripTrailingZeros()

/** JavaScript switches to exponent notation once the value is below 1e-6. */
private const val MIN_PLAIN_POINT = -6

/** Seventeen significant digits identify every double. */
private const val MAX_DOUBLE_DIGITS = 17
