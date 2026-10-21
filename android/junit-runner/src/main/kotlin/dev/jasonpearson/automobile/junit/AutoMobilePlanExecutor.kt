package dev.jasonpearson.automobile.junit

import java.io.File

/** Stateless plan preparation, response parsing, and refusal classification shared by executors. */
internal object AutoMobilePlanExecutor {

  internal fun resolvePlanPath(planPath: String): String {
    // Try to find the plan in test resources first
    val classLoader = Thread.currentThread().contextClassLoader
    val resource = classLoader.getResource(planPath)

    if (resource != null) {
      return File(resource.toURI()).path
    }

    // If not found in resources, try as absolute path
    val file = File(planPath)
    if (file.exists()) {
      return file.absolutePath
    }

    throw IllegalArgumentException("YAML plan not found: $planPath")
  }

  internal fun loadAndProcessPlan(planContent: String, parameters: Map<String, Any>): String {
    // Substituted on the parsed YAML tree, not the source text, so a value cannot alter the plan
    // (#10093).
    val processedContent = PlanParameterSubstitution.substitutePlan(planContent, parameters)

    // Validate YAML schema after parameter substitution
    val validationResult = PlanSchemaValidator.validateYaml(processedContent)
    if (!validationResult.valid) {
      val errorMessages =
        validationResult.errors.joinToString("\n") { err ->
          val location = if (err.line != null) " (line ${err.line})" else ""
          "${err.field}: ${err.message}$location"
        }
      throw IllegalArgumentException(
        "Plan YAML validation failed:\n$errorMessages\n\n" +
          "The plan does not conform to the AutoMobile test plan schema. " +
          "Check schemas/test-plan.schema.json for details.",
      )
    }

    return processedContent
  }

  /**
   * Substitute `${key}` placeholders in a plain string (secret key names, the redaction path's bare
   * `${key}`) in a single pass that never rescans substituted text. The plan itself is substituted
   * on the parsed YAML tree by [PlanParameterSubstitution.substitutePlan] (#10093). Kept in sync
   * with the iOS executor's substitution.
   */
  internal fun substituteParameters(content: String, parameters: Map<String, Any>): String =
    PlanParameterSubstitution.substituteText(content, parameters)

  /**
   * The concrete secret strings to scrub, derived entirely from THIS executor's substitution so
   * they always equal what landed in the recovery context (#6029). For each secret key: its raw
   * parameter value and its actual substituted value (`substituteParameters` applied to the bare
   * `${key}`, matching the ordered single pass exactly — no independent fixpoint, so a
   * self-referential value cannot blow up). Blank/unchanged results are dropped.
   */
  internal fun resolveSecretConcreteValues(
    secretKeys: Set<String>,
    parameters: Map<String, Any>,
  ): List<String> {
    if (secretKeys.isEmpty()) return emptyList()
    // Raw parameter values via the lenient/fail-safe matcher (so an exotically-encoded key name
    // cannot
    // leak), plus each key's actual substituted value from this executor's ordered pass.
    val values = SecretRedactor.secretParameterValues(secretKeys, parameters).toMutableList()
    for (key in secretKeys) {
      val placeholder = "\${$key}"
      val landed = substituteParameters(placeholder, parameters)
      if (landed != placeholder && landed.isNotEmpty()) values.add(landed)
    }
    return values
  }
}
