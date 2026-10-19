package dev.jasonpearson.automobile.validation

import dev.jasonpearson.automobile.validation.TestPlanBarrierUsage.collectBarrierLockUsage
import dev.jasonpearson.automobile.validation.TestPlanBarrierUsage.exactPositiveLong
import dev.jasonpearson.automobile.validation.TestPlanBarrierUsage.validateBarrierConsistentDeviceCount
import dev.jasonpearson.automobile.validation.TestPlanBarrierUsage.validateBarrierDistinctDeviceCounts
import dev.jasonpearson.automobile.validation.TestPlanBarrierUsage.validateBarrierExcessDeviceArrivals
import dev.jasonpearson.automobile.validation.TestPlanBarrierUsage.validateBarrierGenerationCompleteness
import dev.jasonpearson.automobile.validation.TestPlanCoordinationParams.validateBarrierParams
import dev.jasonpearson.automobile.validation.TestPlanCoordinationParams.validateCriticalSectionLocks
import dev.jasonpearson.automobile.validation.TestPlanDevices.declaredDeviceLabels
import dev.jasonpearson.automobile.validation.TestPlanDevices.effectiveCoordinationField

internal object TestPlanCoordinationChecks {
  /**
   * setTimeout's real usable range: Node/Bun clamp any delay >= 2^31 (2147483648) to 1ms with a
   * TimeoutOverflowWarning instead of honoring it, so a coordination timeout at or above that value
   * times out almost immediately rather than waiting as requested. 2^31 - 1 = 2147483647ms (~24.8
   * days).
   */
  const val MAX_SETTIMEOUT_DELAY_MS = 2147483647L

  /**
   * Validates that an optional 'timeout' on a criticalSection or barrier step, when declared, is a
   * positive integer that does not exceed MAX_SETTIMEOUT_DELAY_MS -- mirrors the daemon's
   * PlanValidator.validateCoordinationTimeouts. Both tools' runtime schemas
   * (criticalSectionTools.ts / barrierTools.ts) declare z.number().int().positive() for timeout,
   * and CriticalSectionCoordinator.waitAtBarrier passes the value straight to production setTimeout
   * -- Node/Bun clamp any delay >= 2^31 to 1ms instead of honoring it, so a value at or beyond that
   * range passes the authoring schema's simple exclusiveMinimum check yet times out almost
   * instantly at runtime instead of honoring the requested wait.
   */
  fun validateCoordinationTimeouts(steps: List<*>): List<ValidationError> {
    val errors = mutableListOf<ValidationError>()
    for ((index, step) in steps.withIndex()) {
      if (step !is Map<*, *>) {
        continue
      }
      val tool = step["tool"] as? String
      if (tool != "criticalSection" && tool != "barrier") {
        continue
      }
      val raw = effectiveCoordinationField(step, "timeout") ?: continue
      val timeout = exactPositiveLong(raw)
      if (timeout != null && timeout <= MAX_SETTIMEOUT_DELAY_MS) {
        continue
      }
      errors.add(
        ValidationError(
          field = "steps",
          message =
            "$tool step $index declares 'timeout' of $raw, which must be a positive integer no greater than setTimeout's usable range (${MAX_SETTIMEOUT_DELAY_MS}ms, ~24.8 days) -- Node/Bun clamp larger delays to 1ms instead of honoring them.",
          severity = ValidationSeverity.ERROR,
        ),
      )
    }
    return errors
  }

  /**
   * Validates that no step authors the reserved '__lockNamespace' field (inline or under params) --
   * mirrors the daemon's PlanValidator.validateNoAuthoredLockNamespace. It is injected internally
   * by PlanExecutor at runtime to scope a plan's lock state, and an authored plan must never set
   * it: two participants authoring different truthy __lockNamespace values for the same lock would
   * pass every per-lock feasibility check yet wait in separate namespaced barriers/critical
   * sections at runtime until timeout, since CriticalSectionCoordinator keys runtime state by
   * namespace+lock while the checks above aggregate by lock name alone.
   */
  fun validateNoAuthoredLockNamespace(steps: List<*>): List<ValidationError> {
    val errors = mutableListOf<ValidationError>()
    for ((index, step) in steps.withIndex()) {
      if (step !is Map<*, *>) {
        continue
      }
      if (effectiveCoordinationField(step, "__lockNamespace") != null) {
        val tool = step["tool"] as? String ?: "unknown"
        errors.add(
          ValidationError(
            field = "steps",
            message =
              "step $index ($tool) sets '__lockNamespace', which is a reserved field injected internally by the plan executor. Authored plans must not set it.",
            severity = ValidationSeverity.ERROR,
          ),
        )
      }
    }
    return errors
  }

  /**
   * Validates that no lock name is shared between a criticalSection step and a barrier step --
   * mirrors the daemon's PlanValidator.validateNoCrossToolLockSharing. Both tools share the runtime
   * coordinator's lock namespace and expected-device-count state (keyed by lock name alone), so
   * mixing tool types on one lock name is racy: e.g. a criticalSection A/B pair and a barrier C/D
   * pair both using lock "shared" with deviceCount=2 can pair mismatched participants (A with C)
   * and overwrite each other's expected count. Each tool type must use a distinct lock name.
   */
  fun validateNoCrossToolLockSharing(steps: List<*>): List<ValidationError> {
    val criticalSectionLocks = mutableSetOf<String>()
    val barrierLocks = mutableSetOf<String>()

    for (step in steps) {
      if (step !is Map<*, *>) {
        continue
      }
      val tool = step["tool"] as? String
      if (tool != "criticalSection" && tool != "barrier") {
        continue
      }
      val lock = effectiveCoordinationField(step, "lock") as? String
      if (lock.isNullOrEmpty()) {
        continue
      }
      if (tool == "criticalSection") criticalSectionLocks.add(lock) else barrierLocks.add(lock)
    }

    val shared = criticalSectionLocks.filter { it in barrierLocks }
    if (shared.isEmpty()) {
      return emptyList()
    }
    val names = shared.joinToString(", ") { "\"$it\"" }
    return listOf(
      ValidationError(
        field = "steps",
        message =
          "lock name(s) $names are used by both a criticalSection step and a barrier step. Both tools share the runtime coordinator's lock namespace and expected-count state, so mixing tool types on the same lock name is racy and can pair mismatched participants or overwrite the expected count. Use a distinct lock name per tool type.",
        severity = ValidationSeverity.ERROR,
      ),
    )
  }

  /**
   * Runs all barrier-lock coordination checks (declared-device membership, deviceCount range and
   * consistency, distinct-device count, generation completeness, excess single-device arrivals,
   * cross-tool lock sharing) in one pass over the plan's steps.
   */
  fun validateBarrierCoordination(parsedObject: Any?): List<ValidationError> {
    if (parsedObject !is Map<*, *>) {
      return emptyList()
    }
    val steps = parsedObject["steps"]
    if (steps !is List<*>) {
      return emptyList()
    }

    val declaredDevices = declaredDeviceLabels(parsedObject)
    val (usageByLock, membershipErrors) = collectBarrierLockUsage(steps, declaredDevices)

    return membershipErrors +
      validateNoAuthoredLockNamespace(steps) +
      validateCriticalSectionLocks(steps) +
      validateBarrierParams(steps) +
      validateCoordinationTimeouts(steps) +
      validateNoCrossToolLockSharing(steps) +
      validateBarrierConsistentDeviceCount(usageByLock) +
      validateBarrierDistinctDeviceCounts(usageByLock) +
      validateBarrierGenerationCompleteness(usageByLock) +
      validateBarrierExcessDeviceArrivals(usageByLock)
  }

  /**
   * Validates that at least one arrival order lets every device track get past all of its
   * barrier/criticalSection steps (issue #6231) -- mirrors the daemon's
   * PlanValidator.validateCoordinationScheduleFeasibility. See [CoordinationScheduleFeasibility]
   * for the model: an exhaustive, bounded search over arrival interleavings that rejects only plans
   * where EVERY order deadlocks, never plans that can complete under some timing.
   *
   * A component is skipped (accepted) when the model would not match the runtime for it: a
   * coordination step marked `optional` or a criticalSection whose sub-steps coordinate again. The
   * whole check is skipped when a coordination step lacks a usable device/lock/deviceCount
   * (reported by the schema and the earlier checks).
   */
  fun validateCoordinationScheduleFeasibility(parsedObject: Any?): List<ValidationError> {
    val steps = (parsedObject as? Map<*, *>)?.get("steps") as? List<*> ?: return emptyList()
    val tracks = collectCoordinationTracks(steps)
    if (tracks == null || tracks.size < 2) {
      return emptyList()
    }
    val deadlock =
      CoordinationScheduleFeasibility.findUnavoidableDeadlock(tracks) ?: return emptyList()
    return listOf(
      ValidationError(
        field = "steps",
        message = CoordinationScheduleFeasibility.formatDeadlock(deadlock),
        severity = ValidationSeverity.ERROR,
      ),
    )
  }

  /**
   * Builds per-device tracks of coordination arrivals in plan order, or returns null when a
   * coordination step lacks a usable device/lock/deviceCount.
   */
  fun collectCoordinationTracks(
    steps: List<*>,
  ): List<CoordinationScheduleFeasibility.Track>? {
    val eventsByDevice = linkedMapOf<String, MutableList<CoordinationScheduleFeasibility.Event>>()
    for ((index, step) in steps.withIndex()) {
      if (step !is Map<*, *>) {
        continue
      }
      val tool = step["tool"] as? String
      if (tool == null || tool !in COORDINATION_TOOLS) {
        continue
      }
      val device = effectiveCoordinationField(step, "device") as? String
      val lock = effectiveCoordinationField(step, "lock") as? String
      val deviceCount = exactPositiveLong(effectiveCoordinationField(step, "deviceCount"))
      if (device.isNullOrEmpty() || lock.isNullOrEmpty() || deviceCount == null) {
        return null
      }
      val unmodeled = step["optional"] == true || hasNestedCoordination(step)
      eventsByDevice
        .getOrPut(device) { mutableListOf() }
        .add(CoordinationScheduleFeasibility.Event(tool, lock, deviceCount, index, unmodeled))
    }
    return eventsByDevice.map { (device, events) ->
      CoordinationScheduleFeasibility.Track(device, events)
    }
  }

  /** True when a criticalSection's sub-steps coordinate again (nested waits under its mutex). */
  fun hasNestedCoordination(step: Map<*, *>): Boolean {
    val subSteps = effectiveCoordinationField(step, "steps") as? List<*> ?: return false
    return subSteps.any { sub ->
      sub is Map<*, *> && sub.containsKey("tool") && sub["tool"].toString() in COORDINATION_TOOLS
    }
  }

  val COORDINATION_TOOLS = setOf("barrier", "criticalSection")
}
