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

    // Validate against schema
    val validationErrors: List<Error> = schema.validate(jsonString, InputFormat.JSON)

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
    val barrierCoordinationErrors = validateBarrierCoordination(parsedObject)

    if (
      validationErrors.isEmpty() &&
        toolNameErrors.isEmpty() &&
        multiDeviceErrors.isEmpty() &&
        barrierCoordinationErrors.isEmpty()
    ) {
      return ValidationResult(valid = true)
    }

    // Format validation errors
    val errors = validationErrors.map { error -> formatError(error, yamlContent) }.toMutableList()

    // Add tool name and coordination validation errors
    errors.addAll(toolNameErrors)
    errors.addAll(multiDeviceErrors)
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

  private class BarrierLockUsage {
    val devices = mutableSetOf<String>()
    // Long, not Int: a schema-valid deviceCount can exceed Int.MAX_VALUE, and narrowing it with
    // Int.toInt() would silently wrap/truncate instead of rejecting it (#6215 review).
    val deviceCounts = mutableSetOf<Long>()
    var arrivals = 0
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

      val device = effectiveCoordinationField(step, "device") as? String
      if (!device.isNullOrEmpty()) {
        if (declaredDevices != null && device !in declaredDevices) {
          errors.add(
            ValidationError(
              field = "steps",
              message =
                "barrier step references device \"$device\" for lock \"$lock\", but the plan's declared devices are [${declaredDevices.joinToString(", ")}]. Every barrier device must be a declared device label.",
              severity = ValidationSeverity.ERROR,
            )
          )
        } else {
          usage.devices.add(device)
        }
      }

      val deviceCount = (effectiveCoordinationField(step, "deviceCount") as? Number)?.toLong()
      if (deviceCount != null && deviceCount >= 1) {
        usage.deviceCounts.add(deviceCount)
      }
    }

    return usageByLock to errors
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
   * rounds: only checked when a lock has a single consistent deviceCount N (an inconsistent
   * deviceCount across reuses of the same lock is legitimate, and there is no single N to divide
   * by); for that N, the total arrival count must be an exact multiple of N or a trailing
   * generation is necessarily incomplete and would deadlock forever.
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
   * Runs all barrier-lock coordination checks (declared-device membership, distinct-device count,
   * generation completeness) in one pass over the plan's steps.
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
      validateBarrierDistinctDeviceCounts(usageByLock) +
      validateBarrierGenerationCompleteness(usageByLock)
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
