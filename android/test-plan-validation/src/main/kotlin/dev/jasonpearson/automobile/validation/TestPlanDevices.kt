package dev.jasonpearson.automobile.validation

internal object TestPlanDevices {
  /**
   * A plan uses multi-device features if it declares any criticalSection/barrier step (both are
   * plan-only multi-device coordination primitives) or any step targets a device label -- mirrors
   * the daemon's PlanValidator.hasMultiDeviceFeatures.
   */
  fun hasMultiDeviceFeatures(parsedObject: Any?): Boolean {
    if (parsedObject !is Map<*, *>) {
      return false
    }

    val devices = parsedObject["devices"]
    if (devices is List<*> && devices.isNotEmpty()) {
      return true
    }

    val steps = parsedObject["steps"]
    if (steps !is List<*>) {
      return false
    }

    return steps.any { step ->
      if (step !is Map<*, *>) {
        false
      } else {
        val tool = step["tool"] as? String
        tool == "criticalSection" ||
          tool == "barrier" ||
          step["device"] != null ||
          (step["params"] as? Map<*, *>)?.get("device") != null
      }
    }
  }

  /**
   * Validates that a plan using multi-device features (device labels, or a criticalSection/barrier
   * step) declares a non-empty top-level 'devices' field -- mirrors the daemon's
   * PlanValidator.validateMultiDeviceRequirements. Without this, a plan can pass IDE/JUnit
   * validation here yet be rejected when the daemon loads it for execution (#6215 review).
   */
  fun validateMultiDeviceRequirements(parsedObject: Any?): List<ValidationError> {
    if (!hasMultiDeviceFeatures(parsedObject)) {
      return emptyList()
    }

    val devices = (parsedObject as? Map<*, *>)?.get("devices")
    val hasDevices = devices is List<*> && devices.isNotEmpty()
    if (hasDevices) {
      return emptyList()
    }

    return listOf(
      ValidationError(
        field = "devices",
        message =
          "Plan uses multi-device features (device labels or criticalSection/barrier) but does not declare 'devices' field. Add a 'devices' array at the top level of your plan.",
        severity = ValidationSeverity.ERROR,
      ),
    )
  }

  /**
   * Resolves the effective value of a coordination field (lock/device/deviceCount) for a step,
   * honoring PlanNormalizer's params-wins precedence: when the field is present under params, that
   * value wins even if a different value also sits inline on the step -- mirrors the daemon's
   * PlanValidator.effectiveField.
   */
  fun effectiveCoordinationField(step: Map<*, *>, field: String): Any? {
    val params = step["params"] as? Map<*, *>
    if (params != null && params.containsKey(field)) {
      return params[field]
    }
    return step[field]
  }

  /**
   * The plan's declared top-level 'devices' labels, or null when the plan declares none. Accepts
   * both the plain-label and label/platform-definition forms.
   */
  fun declaredDeviceLabels(parsedObject: Any?): Set<String>? {
    val devices = (parsedObject as? Map<*, *>)?.get("devices") as? List<*> ?: return null
    if (devices.isEmpty()) {
      return null
    }
    return devices
      .mapNotNull { entry ->
        when (entry) {
          is String -> entry
          is Map<*, *> -> entry["label"] as? String
          else -> null
        }
      }
      .toSet()
  }

  /**
   * Validates the declared 'devices' field's structure -- mirrors the daemon's
   * PlanValidator.validateDevicesField:
   * - Every label is non-blank after trimming (the schema's minLength:1 plus the non-whitespace
   *   pattern already rejects most blank labels; this is defense in depth matching the daemon's own
   *   trim-then-check logic exactly).
   * - The list does not mix plain-string labels with label/platform definitions -- the daemon
   *   rejects any such mix outright (#6215 review).
   */
  fun validateDevicesField(parsedObject: Any?): List<ValidationError> {
    val devices = (parsedObject as? Map<*, *>)?.get("devices") as? List<*> ?: return emptyList()
    val errors = mutableListOf<ValidationError>()

    var hasLabelEntries = false
    var hasDefinitionEntries = false
    // Raw label occurrences (NOT deduped) so a duplicate is caught even when the two entries are
    // structurally different definitions (e.g. Android "A" + iOS "A") -- JSON Schema's
    // uniqueItems only compares whole entries, so two different definitions sharing a label pass
    // it, and declaredDeviceLabels()'s Set collapses them before any membership/feasibility check
    // ever sees the duplicate (#6215 review).
    val rawLabels = mutableListOf<String>()

    for (entry in devices) {
      val label =
        when (entry) {
          is String -> {
            hasLabelEntries = true
            entry
          }
          is Map<*, *> -> {
            hasDefinitionEntries = true
            entry["label"] as? String
          }
          else -> null
        } ?: continue
      rawLabels.add(label)
      if (label.trim().isEmpty()) {
        errors.add(
          ValidationError(
            field = "devices",
            message = "Invalid device label: \"$label\". Device labels must be non-empty strings.",
            severity = ValidationSeverity.ERROR,
          ),
        )
      }
    }

    if (hasLabelEntries && hasDefinitionEntries) {
      errors.add(
        ValidationError(
          field = "devices",
          message =
            "Plan 'devices' must be a list of labels or a list of objects with label/platform (do not mix formats).",
          severity = ValidationSeverity.ERROR,
        ),
      )
    }

    val duplicates = rawLabels.groupingBy { it }.eachCount().filter { it.value > 1 }.keys
    if (duplicates.isNotEmpty()) {
      errors.add(
        ValidationError(
          field = "devices",
          message =
            "Plan 'devices' array contains duplicate labels: [${rawLabels.joinToString(", ")}]",
          severity = ValidationSeverity.ERROR,
        ),
      )
    }

    return errors
  }

  /**
   * Validates that EVERY step (not just barrier/criticalSection) targets a declared device label
   * once the plan declares 'devices' -- mirrors the daemon's
   * PlanValidator.validateDeviceLabelsPresent, which checks every step generically rather than only
   * the coordination tools. Without this, a barrier plan with valid A/B barriers plus e.g. a
   * device-less or undeclared-device tapOn step passes here while the daemon rejects it (#6215
   * review). Also validates each criticalSection sub-step's device, matching the daemon's nested
   * check.
   */
  fun validateDeviceLabelsPresent(parsedObject: Any?): List<ValidationError> {
    val declaredDevices = declaredDeviceLabels(parsedObject) ?: return emptyList()
    val steps = (parsedObject as? Map<*, *>)?.get("steps") as? List<*> ?: return emptyList()

    val errors = mutableListOf<ValidationError>()
    steps.forEachIndexed { index, step ->
      if (step !is Map<*, *>) {
        return@forEachIndexed
      }
      val tool = step["tool"] as? String ?: "unknown"
      checkStepDeviceLabel(step, "step $index ($tool)", declaredDevices, errors)

      if (tool == "criticalSection") {
        val subSteps = effectiveCoordinationField(step, "steps") as? List<*>
        subSteps?.forEachIndexed { subIndex, sub ->
          if (sub !is Map<*, *>) {
            return@forEachIndexed
          }
          val subTool = sub["tool"] as? String ?: "unknown"
          checkStepDeviceLabel(
            sub,
            "step $index.steps[$subIndex] ($subTool)",
            declaredDevices,
            errors,
          )
        }
      }
    }
    return errors
  }

  /** Checks one step's effective device label against the declared devices set. */
  fun checkStepDeviceLabel(
    step: Map<*, *>,
    label: String,
    declaredDevices: Set<String>,
    errors: MutableList<ValidationError>,
  ) {
    val device = effectiveCoordinationField(step, "device")
    when {
      device == null || (device as? String)?.isEmpty() == true -> {
        errors.add(
          ValidationError(
            field = "steps",
            message = "$label is missing a 'device' parameter, but the plan declares 'devices'.",
            severity = ValidationSeverity.ERROR,
          ),
        )
      }
      device !is String || device !in declaredDevices -> {
        errors.add(
          ValidationError(
            field = "steps",
            message =
              "$label targets device \"$device\", which is not in the plan's declared devices [${declaredDevices.joinToString(", ")}].",
            severity = ValidationSeverity.ERROR,
          ),
        )
      }
    }
  }

  // -----------------------------------------------------------------------
  // Barrier coordination checks below enforce NECESSARY conditions for a
  // barrier plan to be executable -- they do not prove full deadlock-freedom.
  // The per-lock checks below do not reason about ORDER; the two gaps they
  // leave are covered by validateCoordinationScheduleFeasibility (#6231),
  // which rejects them only when no arrival order can complete:
  //   - Generation-boundary stranding within one lock: e.g. deviceCount=3
  //     with arrivals A,A/B,B/C/D passes every check below (4 distinct
  //     devices, 6 arrivals divisible by 3, no device exceeds its
  //     2-generation budget), but if A/C/D happen to complete generation 1
  //     first, B's two arrivals can never both be scheduled into the same
  //     generation and it deadlocks. Proving this requires reasoning about
  //     which subsets of arrivals can complete each generation -- a
  //     scheduling-feasibility problem, not a simple count check.
  //   - Cross-lock ordering cycles: device A doing barrier(X) then
  //     barrier(Y), and device B doing barrier(Y) then barrier(X), with
  //     both locks needing exactly {A, B} -- A blocks at X waiting for B, B
  //     blocks at Y waiting for A. Every per-lock check below passes
  //     because each lock individually has enough distinct arrivals and no
  //     device exceeds its generation budget. A sound version of this
  //     check is possible but only for locks with zero population slack
  //     (evaluated and deferred during the #6215 review -- see issue #6231
  //     for why).
  // -----------------------------------------------------------------------

}
