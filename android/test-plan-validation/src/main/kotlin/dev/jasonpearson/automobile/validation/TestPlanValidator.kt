package dev.jasonpearson.automobile.validation

import com.networknt.schema.Error
import com.networknt.schema.InputFormat
import com.networknt.schema.Schema
import com.networknt.schema.SchemaRegistry
import com.networknt.schema.SpecificationVersion
import org.yaml.snakeyaml.Yaml

/**
 * Validates AutoMobile test plan YAML files against JSON schema. Supports schema versioning based
 * on mcpVersion field.
 */
object TestPlanValidator {
  private var schema: Schema? = null
  private val yaml = Yaml()

  /** Load the JSON schema from resources */
  @Synchronized
  private fun loadSchema(): Schema {
    if (schema != null) {
      return schema!!
    }

    val schemaStream =
      javaClass.classLoader.getResourceAsStream("schemas/test-plan.schema.json")
        ?: throw IllegalStateException(
          "Could not find test-plan.schema.json in classpath resources. " +
            "Ensure schemas/test-plan.schema.json is included in the resources."
        )

    val schemaJson = schemaStream.bufferedReader().use { it.readText() }

    // Use V7 to match junit-runner implementation
    // Note: V7 doesn't officially support $defs, but the validator tolerates it
    val registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_7)
    schema = registry.getSchema(schemaJson, InputFormat.JSON)

    return schema!!
  }

  /**
   * Validate YAML content against the test plan schema
   *
   * @param yamlContent YAML string to validate
   * @return Validation result with errors if invalid
   */
  fun validateYaml(yamlContent: String): ValidationResult {
    val schema = loadSchema()

    // Parse YAML to object
    val parsedObject: Any?
    try {
      parsedObject = yaml.load(yamlContent)
    } catch (e: Exception) {
      return ValidationResult(
        valid = false,
        errors =
          listOf(
            ValidationError(
              field = "root",
              message = "YAML parsing failed: ${e.message}",
              severity = ValidationSeverity.ERROR,
            )
          ),
      )
    }

    // Convert to JSON string for validation
    val jsonString =
      try {
        kotlinx.serialization.json.Json.encodeToString(
          kotlinx.serialization.json.JsonElement.serializer(),
          convertToJsonElement(parsedObject),
        )
      } catch (e: Exception) {
        return ValidationResult(
          valid = false,
          errors =
            listOf(
              ValidationError(
                field = "root",
                message = "Failed to convert YAML to JSON: ${e.message}",
                severity = ValidationSeverity.ERROR,
              )
            ),
        )
      }

    // Validate against schema. A numeric value far outside the 64-bit long
    // range (e.g. a SnakeYAML BigInteger deviceCount) can make the
    // underlying JSON-schema library's own minimum/maximum keyword
    // validators throw instead of reporting a validation error -- treat that
    // the same as any other schema-validation failure rather than letting it
    // crash validateYaml (#6215 review).
    val validationErrors: List<Error> =
      try {
        schema.validate(jsonString, InputFormat.JSON)
      } catch (e: Exception) {
        return ValidationResult(
          valid = false,
          errors =
            listOf(
              ValidationError(
                field = "root",
                message = "Schema validation failed: ${e.message}",
                severity = ValidationSeverity.ERROR,
              )
            ),
        )
      }

    // Validate tool names
    val toolNameErrors = validateToolNames(parsedObject, yamlContent)

    // Validate multi-device requirements (a plan using criticalSection/barrier
    // or any step-level device label must declare top-level 'devices') and
    // barrier-lock coordination feasibility (declared-device membership,
    // distinct-device count, generation completeness) -- mirrors the
    // daemon's PlanValidator.validateMultiDeviceRequirements /
    // validateBarrierDistinctDeviceCounts / validateBarrierGenerationCompleteness
    // so a plan that validates here also survives daemon-side load instead
    // of passing IDE/JUnit validation and then failing at execution (#6215
    // review).
    val multiDeviceErrors = validateMultiDeviceRequirements(parsedObject)
    // Every declared device label must be non-blank after trimming -- mirrors
    // the daemon's PlanValidator.validateDevicesField. The schema's
    // minLength:1 accepts a whitespace-only label like " ", which the
    // daemon rejects after trimming (#6215 review).
    val devicesFieldErrors = validateDevicesField(parsedObject)
    // Every step (not just barrier/criticalSection) must target a declared
    // device label once the plan declares 'devices' -- mirrors the daemon's
    // PlanValidator.validateDeviceLabelsPresent, which checks every step
    // generically. Without this, a barrier plan with valid A/B barriers
    // plus e.g. a device-less or undeclared-device tapOn step passed here
    // while the daemon rejects it (#6215 review).
    val deviceLabelErrors = validateDeviceLabelsPresent(parsedObject)
    val barrierCoordinationErrors = validateBarrierCoordination(parsedObject)

    if (
      validationErrors.isEmpty() &&
        toolNameErrors.isEmpty() &&
        multiDeviceErrors.isEmpty() &&
        devicesFieldErrors.isEmpty() &&
        deviceLabelErrors.isEmpty() &&
        barrierCoordinationErrors.isEmpty()
    ) {
      return ValidationResult(valid = true)
    }

    // Format validation errors
    val errors = validationErrors.map { error -> formatError(error, yamlContent) }.toMutableList()

    // Add tool name and coordination validation errors
    errors.addAll(toolNameErrors)
    errors.addAll(multiDeviceErrors)
    errors.addAll(devicesFieldErrors)
    errors.addAll(deviceLabelErrors)
    errors.addAll(barrierCoordinationErrors)

    return ValidationResult(valid = false, errors = errors)
  }

  /** Validate that all tool names in steps are valid AutoMobile tools */
  private fun validateToolNames(parsedObject: Any?, yamlContent: String): List<ValidationError> {
    val errors = mutableListOf<ValidationError>()

    if (parsedObject !is Map<*, *>) {
      return errors
    }

    val steps = parsedObject["steps"]
    if (steps !is List<*>) {
      return errors
    }

    steps.forEachIndexed { index, step ->
      if (step is Map<*, *>) {
        val toolName = step["tool"] as? String
        if (toolName != null && toolName.isNotEmpty() && !ValidTools.TOOLS.contains(toolName)) {
          val lineInfo = findToolNameLine(yamlContent, index, toolName)
          errors.add(
            ValidationError(
              field = "steps[$index].tool",
              message = "Unknown tool '$toolName'. Must be one of the valid AutoMobile tools.",
              severity = ValidationSeverity.ERROR,
              line = lineInfo?.line,
              column = lineInfo?.column,
            )
          )
        }
      }
    }

    return errors
  }

  /**
   * A plan uses multi-device features if it declares any criticalSection/barrier step (both are
   * plan-only multi-device coordination primitives) or any step targets a device label -- mirrors
   * the daemon's PlanValidator.hasMultiDeviceFeatures.
   */
  private fun hasMultiDeviceFeatures(parsedObject: Any?): Boolean {
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
  private fun validateMultiDeviceRequirements(parsedObject: Any?): List<ValidationError> {
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
      )
    )
  }

  /**
   * Resolves the effective value of a coordination field (lock/device/deviceCount) for a step,
   * honoring PlanNormalizer's params-wins precedence: when the field is present under params, that
   * value wins even if a different value also sits inline on the step -- mirrors the daemon's
   * PlanValidator.effectiveField.
   */
  private fun effectiveCoordinationField(step: Map<*, *>, field: String): Any? {
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
  private fun declaredDeviceLabels(parsedObject: Any?): Set<String>? {
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
  private fun validateDevicesField(parsedObject: Any?): List<ValidationError> {
    val devices = (parsedObject as? Map<*, *>)?.get("devices") as? List<*> ?: return emptyList()
    val errors = mutableListOf<ValidationError>()

    var hasLabelEntries = false
    var hasDefinitionEntries = false

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
      if (label.trim().isEmpty()) {
        errors.add(
          ValidationError(
            field = "devices",
            message = "Invalid device label: \"$label\". Device labels must be non-empty strings.",
            severity = ValidationSeverity.ERROR,
          )
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
        )
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
  private fun validateDeviceLabelsPresent(parsedObject: Any?): List<ValidationError> {
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
  private fun checkStepDeviceLabel(
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
          )
        )
      }
      device !is String || device !in declaredDevices -> {
        errors.add(
          ValidationError(
            field = "steps",
            message =
              "$label targets device \"$device\", which is not in the plan's declared devices [${declaredDevices.joinToString(", ")}].",
            severity = ValidationSeverity.ERROR,
          )
        )
      }
    }
  }

  // -----------------------------------------------------------------------
  // Barrier coordination checks below enforce NECESSARY conditions for a
  // barrier plan to be executable -- they do not prove full deadlock-freedom.
  // Specifically NOT checked (tracked in issue #6231):
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

  private class BarrierLockUsage {
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
  private fun exactPositiveLong(raw: Any?): Long? =
    when (raw) {
      is Long -> raw.takeIf { it >= 1 }
      is Int -> raw.toLong().takeIf { it >= 1 }
      is java.math.BigInteger ->
        try {
          raw.longValueExact().takeIf { it >= 1 }
        } catch (e: ArithmeticException) {
          null
        }
      is Number -> {
        val value = raw.toDouble()
        if (
          value.isFinite() &&
            value >= 1.0 &&
            value <= Long.MAX_VALUE.toDouble() &&
            value == kotlin.math.floor(value)
        ) {
          value.toLong()
        } else {
          null
        }
      }
      else -> null
    }

  /** Records one barrier step's device (membership-checked) against its lock's usage. */
  private fun recordBarrierDevice(
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
          )
        )
      }
      declaredDevices != null && device !in declaredDevices -> {
        errors.add(
          ValidationError(
            field = "steps",
            message =
              "barrier step references device \"$device\" for lock \"$lock\", but the plan's declared devices are [${declaredDevices.joinToString(", ")}]. Every barrier device must be a declared device label.",
            severity = ValidationSeverity.ERROR,
          )
        )
      }
      else -> {
        usage.devices.add(device)
        usage.deviceOccurrences[device] = (usage.deviceOccurrences[device] ?: 0) + 1
      }
    }
  }

  /** Records one barrier step's deviceCount against its lock's usage. */
  private fun recordBarrierDeviceCount(
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
      )
    )
  }

  /** Collects each barrier step's lock/device/deviceCount usage, keyed by lock name. */
  private fun collectBarrierLockUsage(
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
  private fun validateBarrierConsistentDeviceCount(
    usageByLock: Map<String, BarrierLockUsage>
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
        )
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
  private fun validateBarrierDistinctDeviceCounts(
    usageByLock: Map<String, BarrierLockUsage>
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
            )
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
  private fun validateBarrierGenerationCompleteness(
    usageByLock: Map<String, BarrierLockUsage>
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
        )
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
  private fun validateBarrierExcessDeviceArrivals(
    usageByLock: Map<String, BarrierLockUsage>
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
          )
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
  private fun validateNoCrossToolLockSharing(steps: List<*>): List<ValidationError> {
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
      )
    )
  }

  /**
   * Runs all barrier-lock coordination checks (declared-device membership, deviceCount range and
   * consistency, distinct-device count, generation completeness, excess single-device arrivals,
   * cross-tool lock sharing) in one pass over the plan's steps.
   */
  private fun validateBarrierCoordination(parsedObject: Any?): List<ValidationError> {
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
      validateNoCrossToolLockSharing(steps) +
      validateBarrierConsistentDeviceCount(usageByLock) +
      validateBarrierDistinctDeviceCounts(usageByLock) +
      validateBarrierGenerationCompleteness(usageByLock) +
      validateBarrierExcessDeviceArrivals(usageByLock)
  }

  /** Find the line number of a tool name in a specific step */
  private fun findToolNameLine(yamlContent: String, stepIndex: Int, toolName: String): LineInfo? {
    val lines = yamlContent.split("\n")
    var inSteps = false
    var currentStepIndex = -1
    var inTargetStep = false

    lines.forEachIndexed { lineIndex, line ->
      // Check if we're entering the steps section
      if (line.trim().startsWith("steps:")) {
        inSteps = true
        return@forEachIndexed
      }

      // Count step entries (YAML list items starting with -)
      if (inSteps && line.trim().startsWith("- ")) {
        currentStepIndex++
        inTargetStep = (currentStepIndex == stepIndex)
      }

      // If we're at the right step, look for the tool line
      if (inTargetStep) {
        // Match both inline (- tool: asdf) and separate line (  tool: asdf)
        val toolPattern =
          Regex("(?:^\\s*-\\s+)?tool:\\s*[\"']?${Regex.escape(toolName)}[\"']?\\s*$")
        if (toolPattern.find(line) != null) {
          val column = line.indexOf("tool") + 1
          return LineInfo(line = lineIndex + 1, column = column)
        }
      }

      // Stop if we've passed the target step and hit another list item
      if (inTargetStep && line.trim().startsWith("- ") && currentStepIndex > stepIndex) {
        return@forEachIndexed
      }
    }

    return null
  }

  /** Convert a YAML-parsed object to kotlinx.serialization JsonElement */
  private fun convertToJsonElement(obj: Any?): kotlinx.serialization.json.JsonElement {
    return when (obj) {
      null -> kotlinx.serialization.json.JsonNull
      is String -> kotlinx.serialization.json.JsonPrimitive(obj)
      is Number -> kotlinx.serialization.json.JsonPrimitive(obj)
      is Boolean -> kotlinx.serialization.json.JsonPrimitive(obj)
      is Map<*, *> -> {
        val map = obj.entries.associate { (k, v) -> k.toString() to convertToJsonElement(v) }
        kotlinx.serialization.json.JsonObject(map)
      }
      is List<*> -> {
        val list = obj.map { convertToJsonElement(it) }
        kotlinx.serialization.json.JsonArray(list)
      }
      else -> kotlinx.serialization.json.JsonPrimitive(obj.toString())
    }
  }

  /** Format a validation error message */
  private fun formatError(msg: Error, yamlContent: String): ValidationError {
    // Get the field path from the validation message
    var field = msg.instanceLocation?.toString() ?: "root"

    // Remove leading /
    if (field.startsWith("/")) {
      field = field.substring(1)
    }

    // Convert JSON pointer format to more readable format
    // e.g., /steps/0/tool -> steps[0].tool
    field = field.replace(Regex("/([0-9]+)"), "[$1]").replace("/", ".")

    if (field.isEmpty()) {
      field = "root"
    }

    // Extract friendly error message from the validation message
    val rawMessage = msg.message ?: "Validation error"
    val messageType = msg.messageKey ?: msg.keyword ?: ""

    // Determine severity based on whether this is a deprecated field
    val severity =
      if (isDeprecatedFieldError(field, rawMessage, messageType)) {
        ValidationSeverity.WARNING
      } else {
        ValidationSeverity.ERROR
      }

    // Create more user-friendly messages based on error type
    val message =
      when {
        messageType == "required" || rawMessage.contains("required") -> {
          // Try to extract property name from message
          val propertyMatch = Regex("required property '([^']+)'").find(rawMessage)
          val property = propertyMatch?.groupValues?.getOrNull(1) ?: "property"
          "Missing required property '$property'"
        }
        messageType.contains("additionalProperties") || rawMessage.contains("additional") -> {
          val propertyMatch = Regex("property '([^']+)'").find(rawMessage)
          val property = propertyMatch?.groupValues?.getOrNull(1) ?: "property"
          if (severity == ValidationSeverity.WARNING) {
            "Property '$property' is deprecated. Consider using the new format."
          } else {
            "Unknown property '$property'. This property is not allowed by the schema."
          }
        }
        messageType == "enum" || rawMessage.contains("enum") -> {
          "Must be one of the allowed values"
        }
        messageType == "type" || rawMessage.contains("type") -> {
          rawMessage
        }
        messageType.contains("minItems") || rawMessage.contains("minimum") -> {
          rawMessage
        }
        messageType.contains("minLength") -> {
          rawMessage
        }
        else -> rawMessage
      }

    // Try to find line number for the field in YAML
    val lineInfo = findLineNumber(yamlContent, field)

    return ValidationError(
      field = field.ifEmpty { "root" },
      message = message,
      severity = severity,
      line = lineInfo?.line,
      column = lineInfo?.column,
    )
  }

  /** Determine if an error is related to a deprecated field */
  private fun isDeprecatedFieldError(field: String, message: String, messageType: String): Boolean {
    // Check if the field itself is deprecated
    val fieldName = field.substringAfterLast('.').substringAfterLast(']')
    if (fieldName in ValidTools.DEPRECATED_FIELDS) {
      return true
    }

    // Check if the message mentions a deprecated field
    if (messageType.contains("additionalProperties") || message.contains("additional")) {
      val propertyMatch = Regex("property '([^']+)'").find(message)
      val property = propertyMatch?.groupValues?.getOrNull(1)
      if (property in ValidTools.DEPRECATED_FIELDS) {
        return true
      }
    }

    return false
  }

  /**
   * Attempt to find the line number of a field in YAML content This is a best-effort approach using
   * regex matching
   */
  private fun findLineNumber(yamlContent: String, fieldPath: String): LineInfo? {
    val lines = yamlContent.split("\n")

    // Handle root-level fields
    if (!fieldPath.contains(".") && !fieldPath.contains("[")) {
      val pattern = Regex("^\\s*$fieldPath\\s*:")
      lines.forEachIndexed { index, line ->
        val match = pattern.find(line)
        if (match != null) {
          return LineInfo(line = index + 1, column = (match.range.first) + 1)
        }
      }
    }

    // Handle nested fields like "steps[0].tool" or "metadata.version"
    val parts = fieldPath.split(Regex("[.\\[\\]]+")).filter { it.isNotEmpty() }

    // Try to find the deepest field we can locate
    for (depth in parts.size downTo 1) {
      val searchField = parts[depth - 1]

      // Skip numeric indices
      if (searchField.matches(Regex("^\\d+$"))) {
        continue
      }

      val pattern = Regex("^\\s*$searchField\\s*:")
      lines.forEachIndexed { index, line ->
        val match = pattern.find(line)
        if (match != null) {
          return LineInfo(line = index + 1, column = (match.range.first) + 1)
        }
      }
    }

    return null
  }

  private data class LineInfo(val line: Int, val column: Int)
}
