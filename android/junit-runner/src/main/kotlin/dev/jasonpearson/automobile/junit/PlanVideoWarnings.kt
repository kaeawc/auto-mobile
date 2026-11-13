package dev.jasonpearson.automobile.junit

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The daemon's `videoWarnings` (a truncated, gapped or failed plan video) read from a plan's raw
 * tool result, so a short recording is never delivered to a test as a normal video (#18276).
 */
internal object PlanVideoWarnings {

  fun fromOutput(output: String, json: Json): List<String> {
    if (output.isBlank()) return emptyList()
    val payload = payload(output, json) ?: return emptyList()
    val warnings = payload["videoWarnings"] as? JsonArray ?: return emptyList()
    return warnings.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
  }

  private fun payload(output: String, json: Json): JsonObject? =
    try {
      val result = json.parseToJsonElement(output) as? JsonObject
      (result?.get("structuredContent") as? JsonObject)
        ?: (result?.get("content") as? JsonArray)
          ?.firstOrNull { (it as? JsonObject)?.get("type") == JsonPrimitive("text") }
          ?.let { ((it as JsonObject)["text"] as? JsonPrimitive)?.content }
          ?.let { json.parseToJsonElement(it) as? JsonObject }
    } catch (e: SerializationException) {
      // A non-JSON result already fails plan parsing; it carries no video warnings to report.
      println("Warning: could not read plan video warnings: ${e.message}")
      null
    }

  /** Prints each warning to stderr, where the JUnit report keeps it beside the test. */
  fun report(warnings: List<String>) {
    for (warning in warnings) {
      System.err.println("AutoMobile video warning: $warning")
    }
  }
}
