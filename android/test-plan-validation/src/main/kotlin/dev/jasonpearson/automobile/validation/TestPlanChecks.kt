package dev.jasonpearson.automobile.validation

import com.networknt.schema.Error
import dev.jasonpearson.automobile.validation.TestPlanClockChecks.validateClockInstantWindows
import dev.jasonpearson.automobile.validation.TestPlanCoordinationChecks.validateBarrierCoordination
import dev.jasonpearson.automobile.validation.TestPlanCoordinationChecks.validateCoordinationScheduleFeasibility
import dev.jasonpearson.automobile.validation.TestPlanDevices.validateDeviceLabelsPresent
import dev.jasonpearson.automobile.validation.TestPlanDevices.validateDevicesField
import dev.jasonpearson.automobile.validation.TestPlanDevices.validateMultiDeviceRequirements
import dev.jasonpearson.automobile.validation.TestPlanErrorFormatting.findToolNameLine
import dev.jasonpearson.automobile.validation.TestPlanErrorFormatting.formatError

internal object TestPlanChecks {
  fun validateParsed(
    parsedObject: Any?,
    validationErrors: List<Error>,
    yamlContent: String,
  ): ValidationResult {
    // Validate tool names
    val toolNameErrors = validateToolNames(parsedObject, yamlContent)
    val clockInstantErrors = validateClockInstantWindows(parsedObject)

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
    // Runs only once every check the daemon runs before it has passed -- the daemon's
    // PlanValidator stops at the first failing check and runs its feasibility search last, after
    // the per-lock count checks guarantee one consistent deviceCount per lock (#6231).
    val coordinationErrors =
      listOf(multiDeviceErrors, devicesFieldErrors, deviceLabelErrors, barrierCoordinationErrors)
    val scheduleFeasibilityErrors =
      if (coordinationErrors.all { it.isEmpty() }) {
        validateCoordinationScheduleFeasibility(parsedObject)
      } else {
        emptyList()
      }

    val additionalErrors =
      listOf(toolNameErrors, clockInstantErrors) +
        coordinationErrors +
        listOf(scheduleFeasibilityErrors)
    if (validationErrors.isEmpty() && additionalErrors.all { it.isEmpty() }) {
      return ValidationResult(valid = true)
    }

    // Format validation errors
    val errors = validationErrors.map { error -> formatError(error, yamlContent) }.toMutableList()

    // Add tool name and coordination validation errors
    additionalErrors.forEach(errors::addAll)

    // Only ERROR-severity findings invalidate a plan; warnings (deprecated fields) do not, so
    // valid=false can never come with an empty error list.
    val valid = errors.none { it.severity == ValidationSeverity.ERROR }
    return ValidationResult(valid = valid, errors = errors)
  }

  /** Validate that all tool names in steps are valid AutoMobile tools */
  fun validateToolNames(parsedObject: Any?, yamlContent: String): List<ValidationError> {
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
            ),
          )
        }
      }
    }

    return errors
  }
}
