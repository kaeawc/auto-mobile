package dev.jasonpearson.automobile.validation

import dev.jasonpearson.automobile.validation.TestPlanDevices.effectiveCoordinationField
import dev.jasonpearson.automobile.validation.TestPlanYaml.convertToJsonElement

internal object TestPlanCoordinationParams {
  /** One criticalSection step's view of a lock: its index and effective device/deviceCount. */
  class CriticalSectionOccurrence(
    val stepIndex: Int,
    val device: Any?,
    val deviceCount: Any?,
  )

  /** The JS `Number.isInteger` equivalent: a finite number with no fractional part. */
  fun isJsInteger(value: Any?): Boolean {
    if (value !is Number) return false
    val d = value.toDouble()
    return d.isFinite() && d == kotlin.math.floor(d)
  }

  /** Renders a number the way ECMAScript `Number::toString` does (shortest digits, JS exponent). */
  fun jsNumberString(value: Number): String {
    val d = value.toDouble()
    if (d.isNaN()) return "NaN"
    if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
    if (d == 0.0) return "0"
    val sign = if (d < 0) "-" else ""
    // Double.toString yields the shortest round-tripping digits; re-layout them per ECMAScript.
    val decimal = java.math.BigDecimal(kotlin.math.abs(d).toString()).stripTrailingZeros()
    val digits = decimal.unscaledValue().toString()
    val k = digits.length
    // The value is 0.<digits> x 10^n.
    val n = k - decimal.scale()
    val body =
      when {
        n in k..21 -> digits + "0".repeat(n - k)
        n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
        n in -5..0 -> "0." + "0".repeat(-n) + digits
        else -> {
          val exponent = n - 1
          val mantissa = if (k == 1) digits else digits[0] + "." + digits.substring(1)
          mantissa + "e" + (if (exponent < 0) "-" else "+") + kotlin.math.abs(exponent)
        }
      }
    return sign + body
  }

  fun coordinationFieldPresent(step: Map<*, *>, field: String): Boolean {
    val params = step["params"] as? Map<*, *>
    return if (params != null && params.containsKey(field)) true else step.containsKey(field)
  }

  /** JS `String(value)` of a coordination field; an absent field renders as "undefined". */
  fun jsString(step: Map<*, *>, field: String): String {
    val value = effectiveCoordinationField(step, field)
    return when {
      value == null -> if (coordinationFieldPresent(step, field)) "null" else "undefined"
      value is Number -> jsNumberString(value)
      else -> value.toString()
    }
  }

  /** JS `JSON.stringify(value)` of a coordination field (absent renders as "undefined"). */
  fun jsonStringifyField(step: Map<*, *>, field: String): String {
    val value = effectiveCoordinationField(step, field)
    return when {
      value == null -> if (coordinationFieldPresent(step, field)) "null" else "undefined"
      value is Number -> if (value.toDouble().isFinite()) jsNumberString(value) else "null"
      else -> convertToJsonElement(value).toString()
    }
  }

  fun errorsOf(messages: List<String>): List<ValidationError> = messages.map {
    ValidationError(field = "steps", message = it, severity = ValidationSeverity.ERROR)
  }

  /**
   * Validates cross-step criticalSection lock consistency (a lock is entered at most once per
   * device and by exactly deviceCount steps) -- mirrors the daemon's
   * PlanValidator.validateCriticalSectionLocks, message for message.
   */
  fun validateCriticalSectionLocks(steps: List<*>): List<ValidationError> {
    val usage = linkedMapOf<String, MutableList<CriticalSectionOccurrence>>()
    for ((index, step) in steps.withIndex()) {
      if (step !is Map<*, *> || step["tool"] as? String != "criticalSection") {
        continue
      }
      val lock = effectiveCoordinationField(step, "lock")
      if (lock !is String || lock.isEmpty()) {
        // Schema-level requirements are validated elsewhere; skip silently.
        continue
      }
      usage
        .getOrPut(lock) { mutableListOf() }
        .add(
          CriticalSectionOccurrence(
            index,
            effectiveCoordinationField(step, "device"),
            effectiveCoordinationField(step, "deviceCount"),
          ),
        )
    }
    val messages = mutableListOf<String>()
    for ((lock, occurrences) in usage) {
      validateCriticalSectionLock(lock, occurrences, steps, messages)
    }
    return errorsOf(messages)
  }

  fun validateCriticalSectionLock(
    lock: String,
    occurrences: List<CriticalSectionOccurrence>,
    steps: List<*>,
    messages: MutableList<String>,
  ) {
    val numeric = occurrences.filter { it.deviceCount is Number }
    val distinctCounts = numeric.map { (it.deviceCount as Number).toDouble() }.toSet()
    if (distinctCounts.size > 1) {
      val detail =
        occurrences.joinToString(", ") {
          val step = steps[it.stepIndex] as Map<*, *>
          "step ${it.stepIndex} deviceCount=${jsString(step, "deviceCount")}"
        }
      messages.add(
        "criticalSection lock \"$lock\" has inconsistent deviceCount values: $detail. All steps sharing a lock must declare the same deviceCount.",
      )
      return
    }
    if (distinctCounts.size == 1 && occurrences.size.toDouble() != distinctCounts.first()) {
      val declared = jsNumberString(numeric.first().deviceCount as Number)
      val n = occurrences.size
      val plural = if (n == 1) "" else "s"
      val verb = if (n == 1) "s" else ""
      messages.add(
        "criticalSection lock \"$lock\" declares deviceCount=$declared but $n step$plural reference$verb it. Every participating device needs its own criticalSection step with this lock.",
      )
    }
    val devicesSeen = linkedMapOf<String, MutableList<Int>>()
    for (o in occurrences) {
      val device = o.device
      if (device is String && device.isNotEmpty()) {
        devicesSeen.getOrPut(device) { mutableListOf() }.add(o.stepIndex)
      }
    }
    for ((device, indices) in devicesSeen) {
      if (indices.size > 1) {
        messages.add(
          "criticalSection lock \"$lock\" is entered twice by device \"$device\" (steps ${indices.joinToString(", ")}). Each device can participate in a given lock at most once.",
        )
      }
    }
  }

  /**
   * Validates each barrier step's own params (required `lock`, required positive-integer
   * `deviceCount`) -- mirrors the daemon's PlanValidator.validateBarrierParams.
   */
  fun validateBarrierParams(steps: List<*>): List<ValidationError> {
    val messages = mutableListOf<String>()
    for ((index, step) in steps.withIndex()) {
      if (step !is Map<*, *> || step["tool"] as? String != "barrier") {
        continue
      }
      val lock = effectiveCoordinationField(step, "lock")
      if (lock !is String || lock.isEmpty()) {
        messages.add("barrier step $index is missing a non-empty 'lock' parameter.")
      }
      val deviceCount = effectiveCoordinationField(step, "deviceCount")
      if (!isJsInteger(deviceCount) || (deviceCount as Number).toDouble() < 1) {
        messages.add(
          "barrier step $index must declare a positive integer 'deviceCount', got ${jsonStringifyField(step, "deviceCount")}.",
        )
      }
    }
    return errorsOf(messages)
  }
}
