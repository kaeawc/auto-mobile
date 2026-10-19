package dev.jasonpearson.automobile.validation

import dev.jasonpearson.automobile.validation.TestPlanDevices.effectiveCoordinationField

internal object TestPlanBarrierUsage {
  class BarrierLockUsage {
    val devices = mutableSetOf<String>()
    // Long, not Int: a schema-valid deviceCount can exceed Int.MAX_VALUE, and narrowing it with
    // Int.toInt() would silently wrap/truncate instead of rejecting it (#6215 review).
    val deviceCounts = mutableSetOf<Long>()
    var arrivals = 0
    // Per-device occurrence count, used to catch a device scheduled more times than there are
    // generations for it to participate in.
    val deviceOccurrences = mutableMapOf<String, Int>()
  }

  /**
   * Converts a coordination field's raw value to an exact positive Long, or null if it isn't one
   * (including a value that is numerically out of the supported range, e.g. a SnakeYAML BigInteger
   * beyond Long.MAX_VALUE). Never wraps/truncates a value that doesn't fit -- callers must treat a
   * non-null raw value that maps to null here as an explicit rejection, not an absence (#6215
   * review: a schema-valid but off-range deviceCount must be rejected, not silently narrowed).
   */
  fun exactPositiveLong(raw: Any?): Long? =
    when (raw) {
      is Long -> raw.takeIf { it >= 1 }
      is Int -> raw.toLong().takeIf { it >= 1 }
      is java.math.BigInteger ->
        raw
          .takeIf {
            it >= java.math.BigInteger.ONE && it <= java.math.BigInteger.valueOf(Long.MAX_VALUE)
          }
          ?.toLong()
      is Number -> {
        val value = raw.toDouble()
        val inRange = value >= 1.0 && value <= Long.MAX_VALUE.toDouble()
        if (value.isFinite() && inRange && value == kotlin.math.floor(value)) {
          value.toLong()
        } else {
          null
        }
      }
      else -> null
    }

  /** Records one barrier step's device (membership-checked) against its lock's usage. */
  fun recordBarrierDevice(
    usage: BarrierLockUsage,
    lock: String,
    step: Map<*, *>,
    declaredDevices: Set<String>?,
    errors: MutableList<ValidationError>,
  ) {
    val device = effectiveCoordinationField(step, "device") as? String
    when {
      device.isNullOrEmpty() -> {
        errors.add(
          ValidationError(
            field = "steps",
            message =
              "barrier step for lock \"$lock\" is missing a 'device' parameter. Every barrier step must target a specific device.",
            severity = ValidationSeverity.ERROR,
          ),
        )
      }
      declaredDevices != null && device !in declaredDevices -> {
        errors.add(
          ValidationError(
            field = "steps",
            message =
              "barrier step references device \"$device\" for lock \"$lock\", but the plan's declared devices are [${declaredDevices.joinToString(", ")}]. Every barrier device must be a declared device label.",
            severity = ValidationSeverity.ERROR,
          ),
        )
      }
      else -> {
        usage.devices.add(device)
        usage.deviceOccurrences[device] = (usage.deviceOccurrences[device] ?: 0) + 1
      }
    }
  }

  /** Records one barrier step's deviceCount against its lock's usage. */
  fun recordBarrierDeviceCount(
    usage: BarrierLockUsage,
    lock: String,
    step: Map<*, *>,
    errors: MutableList<ValidationError>,
  ) {
    val raw = effectiveCoordinationField(step, "deviceCount") ?: return
    val deviceCount = exactPositiveLong(raw)
    if (deviceCount != null) {
      usage.deviceCounts.add(deviceCount)
      return
    }
    errors.add(
      ValidationError(
        field = "steps",
        message =
          "barrier step for lock \"$lock\" declares deviceCount=$raw, which is outside the supported range (a positive integer representable in 64 bits). This is rejected rather than silently narrowed.",
        severity = ValidationSeverity.ERROR,
      ),
    )
  }

  /** Collects each barrier step's lock/device/deviceCount usage, keyed by lock name. */
  fun collectBarrierLockUsage(
    steps: List<*>,
    declaredDevices: Set<String>?,
  ): Pair<Map<String, BarrierLockUsage>, List<ValidationError>> {
    val usageByLock = mutableMapOf<String, BarrierLockUsage>()
    val errors = mutableListOf<ValidationError>()

    for (step in steps) {
      if (step !is Map<*, *> || step["tool"] as? String != "barrier") {
        continue
      }

      val lock = effectiveCoordinationField(step, "lock") as? String
      if (lock.isNullOrEmpty()) {
        continue
      }
      val usage = usageByLock.getOrPut(lock) { BarrierLockUsage() }
      usage.arrivals += 1

      recordBarrierDevice(usage, lock, step, declaredDevices, errors)
      recordBarrierDeviceCount(usage, lock, step, errors)
    }

    return usageByLock to errors
  }

  /**
   * Validates that a reused barrier lock declares the same deviceCount every time it's used --
   * mirrors the daemon's PlanValidator.validateBarrierConsistentDeviceCount. The runtime
   * coordinator keys a single shared expected-device-count per lock name (every arrival's
   * registerExpectedDevices call overwrites it), so mixed-count reuse of the same lock is racy:
   * whether the barrier ever releases depends on arrival order, and it can deadlock to the barrier
   * timeout nondeterministically.
   */
  fun validateBarrierConsistentDeviceCount(
    usageByLock: Map<String, BarrierLockUsage>,
  ): List<ValidationError> {
    val errors = mutableListOf<ValidationError>()
    for ((lock, usage) in usageByLock) {
      if (usage.deviceCounts.size <= 1) {
        continue
      }
      val counts = usage.deviceCounts.sorted().joinToString(", ")
      errors.add(
        ValidationError(
          field = "steps",
          message =
            "barrier lock \"$lock\" is reused with inconsistent deviceCount values ($counts). The runtime coordinator keeps a single shared expected count per lock name, so mixed-count reuse is racy and can deadlock depending on arrival order. Use a distinct lock name for each deviceCount instead.",
          severity = ValidationSeverity.ERROR,
        ),
      )
    }
    return errors
  }

  /**
   * Validates that every barrier lock is populated by enough distinct, declared devices to ever
   * satisfy its declared deviceCount -- mirrors the daemon's
   * PlanValidator.validateBarrierDistinctDeviceCounts (plus PlanValidator's generic device-label
   * check, which the daemon runs separately via validateDeviceLabelsPresent). Sound without
   * reconstructing rounds: a single round needs deviceCount distinct arrivals, so if fewer distinct
   * devices ever target a given lock across the whole plan, no round can ever complete.
   */
  fun validateBarrierDistinctDeviceCounts(
    usageByLock: Map<String, BarrierLockUsage>,
  ): List<ValidationError> {
    val errors = mutableListOf<ValidationError>()
    for ((lock, usage) in usageByLock) {
      for (deviceCount in usage.deviceCounts) {
        if (usage.devices.size < deviceCount) {
          val deviceList = usage.devices.joinToString(", ").ifEmpty { "none" }
          errors.add(
            ValidationError(
              field = "steps",
              message =
                "barrier lock \"$lock\" declares deviceCount=$deviceCount but only ${usage.devices.size} distinct device(s) ($deviceList) ever target it in this plan. No round can ever complete.",
              severity = ValidationSeverity.ERROR,
            ),
          )
        }
      }
    }
    return errors
  }

  /**
   * Validates that a reused barrier lock's total arrivals form complete generations -- mirrors the
   * daemon's PlanValidator.validateBarrierGenerationCompleteness. Sound without reconstructing
   * rounds: only meaningful when a lock has a single consistent deviceCount N
   * (validateBarrierConsistentDeviceCount already rejects a lock with more than one, so this
   * defensively skips that case too rather than picking an arbitrary N); for that N, the total
   * arrival count must be an exact multiple of N or a trailing generation is necessarily incomplete
   * and would deadlock forever.
   */
  fun validateBarrierGenerationCompleteness(
    usageByLock: Map<String, BarrierLockUsage>,
  ): List<ValidationError> {
    val errors = mutableListOf<ValidationError>()
    for ((lock, usage) in usageByLock) {
      if (usage.deviceCounts.size != 1) {
        continue
      }
      val deviceCount = usage.deviceCounts.first()
      if (deviceCount < 1 || usage.arrivals % deviceCount == 0L) {
        continue
      }
      errors.add(
        ValidationError(
          field = "steps",
          message =
            "barrier lock \"$lock\" has ${usage.arrivals} total arrival(s) across the plan, which is not a multiple of its deviceCount=$deviceCount. At least one generation is necessarily incomplete and would deadlock waiting for a device that never arrives.",
          severity = ValidationSeverity.ERROR,
        ),
      )
    }
    return errors
  }

  /**
   * Validates that no single device is scheduled to arrive at a barrier lock more times than there
   * are generations for it to participate in -- mirrors the daemon's
   * PlanValidator.validateBarrierExcessDeviceArrivals.
   *
   * PlanPartitioner executes each device's track sequentially, so a device can only ever occupy one
   * "slot" per generation -- it cannot re-enter the same lock a second time within a generation
   * it's already part of. For a lock with a single consistent deviceCount N and T total arrivals (T
   * divisible by N, per validateBarrierGenerationCompleteness), there are G = T / N generations
   * available in total. A device appearing more than G times can never be scheduled into a
   * generation it hasn't already used, so it deadlocks waiting at an arrival no generation will
   * ever admit.
   *
   * Sound: a device appearing at most G times is exactly the necessary condition for a feasible
   * one-arrival-per-generation assignment to exist (e.g. A,A,B,B with deviceCount=2 has G=2 and
   * each device appears exactly 2 times -- feasible, and correctly accepted).
   */
  fun validateBarrierExcessDeviceArrivals(
    usageByLock: Map<String, BarrierLockUsage>,
  ): List<ValidationError> {
    val errors = mutableListOf<ValidationError>()
    for ((lock, usage) in usageByLock) {
      if (usage.deviceCounts.size != 1) {
        continue
      }
      val deviceCount = usage.deviceCounts.first()
      if (deviceCount < 1 || usage.arrivals % deviceCount != 0L) {
        // Inconsistent-count and incomplete-generation cases are already reported by the other
        // checks; skip here to avoid a meaningless generation count.
        continue
      }
      val generations = usage.arrivals / deviceCount

      for ((device, occurrences) in usage.deviceOccurrences) {
        if (occurrences <= generations) {
          continue
        }
        errors.add(
          ValidationError(
            field = "steps",
            message =
              "barrier lock \"$lock\" has $generations generation(s) available (deviceCount=$deviceCount, ${usage.arrivals} total arrivals), but device \"$device\" arrives $occurrences times. A device can participate in a lock at most once per generation, since each device's track executes sequentially, so this device would deadlock waiting for a generation that never admits it again.",
            severity = ValidationSeverity.ERROR,
          ),
        )
      }
    }
    return errors
  }
}
