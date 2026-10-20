package dev.jasonpearson.automobile.ide.yaml

import dev.jasonpearson.automobile.validation.ValidTools
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

object TestPlanSchemaStore {
  private val json = Json { ignoreUnknownKeys = true }
  private var rootSchema: JsonObject? = null
  private var rootProperties: Map<String, SchemaPropertyInfo>? = null
  private var stepProperties: Map<String, SchemaPropertyInfo>? = null
  private var metadataProperties: Map<String, SchemaPropertyInfo>? = null
  private var metadataSchema: JsonObject? = null
  private var expectationSchema: JsonObject? = null

  fun getRootProperties(): Map<String, SchemaPropertyInfo> {
    if (rootProperties == null) {
      loadSchemaData()
    }
    return rootProperties.orEmpty()
  }

  fun getStepProperties(): Map<String, SchemaPropertyInfo> {
    if (stepProperties == null) {
      loadSchemaData()
    }
    return stepProperties.orEmpty()
  }

  fun getMetadataProperties(): Map<String, SchemaPropertyInfo> {
    if (metadataProperties == null) {
      loadSchemaData()
    }
    return metadataProperties.orEmpty()
  }

  fun getMetadataSchema(): JsonObject? {
    if (metadataSchema == null) {
      loadSchemaData()
    }
    return metadataSchema
  }

  fun getExpectationSchema(): JsonObject? {
    if (expectationSchema == null) {
      loadSchemaData()
    }
    return expectationSchema
  }

  private fun loadSchemaData() {
    val schema = loadSchema()
    val rootPropertySchemas = schema.schemaObjectValue("properties")
    val rootRequired =
      schema.schemaArrayValue("required")?.mapNotNull { it.schemaStringValue() }?.toSet().orEmpty()
    rootProperties = buildPropertyMap(rootPropertySchemas, rootRequired)

    val defs = schema.schemaObjectValue("\$defs") ?: schema.schemaObjectValue("definitions")
    val planStep = defs?.schemaObjectValue("planStep")
    val stepPropertySchemas = planStep?.schemaObjectValue("properties")
    val stepRequired =
      planStep
        ?.schemaArrayValue("required")
        ?.mapNotNull { it.schemaStringValue() }
        ?.toSet()
        .orEmpty()
    stepProperties = buildPropertyMap(stepPropertySchemas, stepRequired)

    metadataSchema = rootPropertySchemas?.schemaObjectValue("metadata")
    val metadataPropertySchemas = metadataSchema?.schemaObjectValue("properties")
    val metadataRequired =
      metadataSchema
        ?.schemaArrayValue("required")
        ?.mapNotNull { it.schemaStringValue() }
        ?.toSet()
        .orEmpty()
    metadataProperties = buildPropertyMap(metadataPropertySchemas, metadataRequired)

    expectationSchema = defs?.schemaObjectValue("expectation")
  }

  private fun buildPropertyMap(
    properties: JsonObject?,
    required: Set<String>,
  ): Map<String, SchemaPropertyInfo> {
    if (properties == null) {
      return emptyMap()
    }

    return properties
      .mapNotNull { (name, schemaElement) ->
        val schemaObject = schemaElement.schemaAsObjectOrNull() ?: return@mapNotNull null
        val description = schemaObject.schemaStringValue("description")
        val deprecated =
          schemaObject.schemaStringValue("deprecated")?.lowercase()?.toBooleanStrictOrNull() ==
            true ||
            description?.startsWith("DEPRECATED") == true ||
            name in ValidTools.DEPRECATED_FIELDS
        SchemaPropertyInfo(
          name = name,
          description = description,
          required = required.contains(name),
          deprecated = deprecated,
          schemas = listOf(schemaObject),
        )
      }
      .associateBy { it.name }
  }

  private fun loadSchema(): JsonObject {
    rootSchema?.let {
      return it
    }

    val schemaStream = getResourceStream("test-plan.schema.json", "schemas/test-plan.schema.json")
    if (schemaStream == null) {
      return JsonObject(emptyMap()).also { rootSchema = it }
    }

    val schemaJson = schemaStream.bufferedReader().use { it.readText() }
    val schemaElement = json.parseToJsonElement(schemaJson)
    return schemaElement.jsonObject.also { rootSchema = it }
  }

  private fun getResourceStream(vararg paths: String): java.io.InputStream? {
    val classLoader = javaClass.classLoader
    for (path in paths) {
      val stream = classLoader.getResourceAsStream(path)
      if (stream != null) {
        return stream
      }
    }
    return null
  }
}
