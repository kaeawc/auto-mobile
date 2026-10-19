package dev.jasonpearson.automobile.validation

import com.networknt.schema.Error

internal object TestPlanErrorFormatting {
  /** Find the line number of a tool name in a specific step */
  fun findToolNameLine(yamlContent: String, stepIndex: Int, toolName: String): LineInfo? {
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

  /** Format a validation error message */
  fun formatError(msg: Error, yamlContent: String): ValidationError {
    val field = errorField(msg)

    // Extract friendly error message from the validation message
    val rawMessage = msg.message ?: "Validation error"
    val messageType = msg.messageKey ?: msg.keyword ?: ""

    // Determine severity based on whether this is a deprecated field
    val severity =
      if (isDeprecatedFieldError(rawMessage, messageType)) {
        ValidationSeverity.WARNING
      } else {
        ValidationSeverity.ERROR
      }

    val message = friendlyMessage(rawMessage, messageType, severity)

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

  private fun friendlyMessage(
    rawMessage: String,
    messageType: String,
    severity: ValidationSeverity,
  ): String {
    // Create more user-friendly messages based on error type
    return when {
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
      else -> rawMessage
    }
  }

  fun errorField(msg: Error): String {
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

    return field
  }

  /**
   * Only the "deprecated field is present but not allowed" notice is a warning: an
   * additionalProperties error naming a deprecated property. Type, format, enum and required errors
   * stay errors whatever the field is called.
   */
  fun isDeprecatedFieldError(message: String, messageType: String): Boolean {
    if (!messageType.contains("additionalProperties") && !message.contains("additional")) {
      return false
    }
    val property = Regex("property '([^']+)'").find(message)?.groupValues?.getOrNull(1)
    return property in ValidTools.DEPRECATED_FIELDS
  }

  /**
   * Attempt to find the line number of a field in YAML content This is a best-effort approach using
   * regex matching
   */
  fun findLineNumber(yamlContent: String, fieldPath: String): LineInfo? {
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

  data class LineInfo(val line: Int, val column: Int)
}
