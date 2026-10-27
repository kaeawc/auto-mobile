package dev.jasonpearson.automobile.validation

import com.networknt.schema.Error
import com.networknt.schema.InputFormat
import com.networknt.schema.Schema
import com.networknt.schema.SchemaRegistry
import com.networknt.schema.SpecificationVersion
import dev.jasonpearson.automobile.validation.TestPlanChecks.validateParsed
import dev.jasonpearson.automobile.validation.TestPlanClockChecks.normalizeClockFractionsForSchema
import dev.jasonpearson.automobile.validation.TestPlanYaml.convertToJsonElement

/**
 * Validates AutoMobile test plan YAML files against JSON schema. Supports schema versioning based
 * on mcpVersion field.
 */
object TestPlanValidator {
  private var schema: Schema? = null
  private val yaml = TestPlanYaml.yaml

  /** Load the JSON schema from resources */
  @Synchronized
  private fun loadSchema(): Schema {
    schema?.let {
      return it
    }

    val schemaStream =
      javaClass.classLoader.getResourceAsStream("schemas/test-plan.schema.json")
        ?: throw IllegalStateException(
          "Could not find test-plan.schema.json in classpath resources. " +
            "Ensure schemas/test-plan.schema.json is included in the resources.",
        )

    val schemaJson = schemaStream.bufferedReader().use { it.readText() }

    // Use V7 to match junit-runner implementation
    // Note: V7 doesn't officially support $defs, but the validator tolerates it
    val registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_7)
    val loaded = registry.getSchema(schemaJson, InputFormat.JSON)
    schema = loaded
    return loaded
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
      return parsingFailure("YAML parsing failed", e)
    }

    // Convert to JSON string for validation
    val jsonString =
      try {
        kotlinx.serialization.json.Json.encodeToString(
          kotlinx.serialization.json.JsonElement.serializer(),
          convertToJsonElement(normalizeClockFractionsForSchema(parsedObject)),
        )
      } catch (e: Exception) {
        return parsingFailure("Failed to convert YAML to JSON", e)
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
        return parsingFailure("Schema validation failed", e)
      }

    return TestPlanChecks.validateParsed(parsedObject, validationErrors, yamlContent)
  }

  private fun parsingFailure(prefix: String, cause: Exception): ValidationResult =
    ValidationResult(
      false,
      listOf(ValidationError("root", "$prefix: ${cause.message}", ValidationSeverity.ERROR)),
    )
}
