package dev.jasonpearson.automobile.ide.yaml

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

data class SchemaPathSegment(val key: String, val isArrayItem: Boolean)

data class SchemaPropertyInfo(
  val name: String,
  val description: String?,
  val required: Boolean,
  val deprecated: Boolean,
  val schemas: List<JsonObject>,
)

object JsonSchemaIntrospector {
  fun collectProperties(
    rootSchema: JsonObject,
    path: List<SchemaPathSegment>,
  ): Map<String, SchemaPropertyInfo> {
    val schemas = collectSchemasAtPath(rootSchema, path, rootSchema)
    if (schemas.isEmpty()) {
      return emptyMap()
    }

    val propertySchemas = mutableMapOf<String, MutableList<JsonObject>>()
    val required = mutableSetOf<String>()
    schemas.forEach { schema -> collectProperties(schema, rootSchema, propertySchemas, required) }

    return propertySchemas.mapValues { (name, schemasForProperty) ->
      val description = schemasForProperty.firstNotNullOfOrNull {
        it.schemaStringValue("description")
      }
      val deprecated =
        schemasForProperty.any { it.schemaBooleanValue("deprecated") == true } ||
          description?.startsWith("DEPRECATED") == true
      SchemaPropertyInfo(
        name = name,
        description = description,
        required = required.contains(name),
        deprecated = deprecated,
        schemas = schemasForProperty,
      )
    }
  }

  fun collectEnumValues(rootSchema: JsonObject, path: List<SchemaPathSegment>): Set<String> {
    val schemas = collectSchemasAtPath(rootSchema, path, rootSchema)
    if (schemas.isEmpty()) {
      return emptySet()
    }

    val values = mutableSetOf<String>()
    schemas.forEach { schema ->
      val resolved = resolveRef(schema, rootSchema)
      resolved.schemaArrayValue("enum")?.forEach { entry ->
        entry.schemaStringValue()?.let { values.add(it) }
      }
    }

    return values
  }

  private fun collectSchemasAtPath(
    schema: JsonObject,
    path: List<SchemaPathSegment>,
    rootSchema: JsonObject,
  ): List<JsonObject> {
    if (path.isEmpty()) {
      return listOf(resolveRef(schema, rootSchema))
    }

    val segment = path.first()
    val propertySchemas = collectPropertySchemas(schema, segment.key, rootSchema)
    if (propertySchemas.isEmpty()) {
      return emptyList()
    }

    val remaining = path.drop(1)
    val results = mutableListOf<JsonObject>()
    for (propertySchema in propertySchemas) {
      var resolved = resolveRef(propertySchema, rootSchema)
      if (segment.isArrayItem) {
        resolved = unwrapArrayItemSchema(resolved, rootSchema) ?: continue
      }
      results.addAll(collectSchemasAtPath(resolved, remaining, rootSchema))
    }

    return results
  }

  private fun collectPropertySchemas(
    schema: JsonObject,
    key: String,
    rootSchema: JsonObject,
  ): List<JsonObject> {
    val resolved = resolveRef(schema, rootSchema)
    val result = mutableListOf<JsonObject>()
    resolved.schemaObjectValue("properties")?.get(key)?.schemaAsObjectOrNull()?.let {
      result.add(it)
    }

    for (keyword in listOf("allOf", "anyOf", "oneOf")) {
      resolved.schemaArrayValue(keyword)?.forEach { element ->
        val child = element.schemaAsObjectOrNull() ?: return@forEach
        result.addAll(collectPropertySchemas(child, key, rootSchema))
      }
    }

    return result
  }

  private fun collectProperties(
    schema: JsonObject,
    rootSchema: JsonObject,
    properties: MutableMap<String, MutableList<JsonObject>>,
    required: MutableSet<String>,
  ) {
    val resolved = resolveRef(schema, rootSchema)
    resolved.schemaObjectValue("properties")?.forEach { (key, value) ->
      value.schemaAsObjectOrNull()?.let { propertySchema ->
        properties.getOrPut(key) { mutableListOf() }.add(propertySchema)
      }
    }

    resolved
      .schemaArrayValue("required")
      ?.mapNotNull { it.schemaStringValue() }
      ?.forEach { required.add(it) }

    for (keyword in listOf("allOf", "anyOf", "oneOf")) {
      resolved.schemaArrayValue(keyword)?.forEach { element ->
        val child = element.schemaAsObjectOrNull() ?: return@forEach
        collectProperties(child, rootSchema, properties, required)
      }
    }
  }

  private fun unwrapArrayItemSchema(schema: JsonObject, rootSchema: JsonObject): JsonObject? {
    val resolved = resolveRef(schema, rootSchema)
    val items = resolved["items"]?.schemaAsObjectOrNull() ?: return null
    return resolveRef(items, rootSchema)
  }

  private fun resolveRef(schema: JsonObject, rootSchema: JsonObject): JsonObject {
    val ref = schema.schemaStringValue("\$ref") ?: return schema
    if (!ref.startsWith("#/")) {
      return schema
    }

    var current: JsonElement = rootSchema
    val segments = ref.removePrefix("#/").split("/")
    for (segment in segments) {
      val key = segment.replace("~1", "/").replace("~0", "~")
      current = current.schemaAsObjectOrNull()?.get(key) ?: return schema
    }

    return current.schemaAsObjectOrNull() ?: schema
  }
}
