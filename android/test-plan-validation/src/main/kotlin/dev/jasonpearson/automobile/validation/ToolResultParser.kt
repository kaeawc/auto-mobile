package dev.jasonpearson.automobile.validation

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

object ToolResultParser {
  val json: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
  }

  fun parseToolResult(stepIndex: Int, toolName: String, jsonString: String): ToolResult {
    val element = json.parseToJsonElement(jsonString)
    return parseToolResult(stepIndex, toolName, element)
  }

  fun parseToolResult(stepIndex: Int, toolName: String, element: JsonElement): ToolResult {
    val objectElement =
      element as? JsonObject ?: throw SerializationException("Tool result is not a JSON object")

    val success = inferSuccess(objectElement)
    val error =
      objectElement["error"]?.let { errorElement ->
        when (errorElement) {
          // A structured `{ code, message }` error (e.g. the killDevice
          // `device_already_stopped` envelope) is flattened to `code: message`,
          // matching how the TypeScript plan/critical-section paths render it, so
          // Kotlin consumers keep the machine-readable code without reparsing the
          // raw payload.
          is JsonObject -> {
            val code = errorElement["code"]?.jsonPrimitive?.content
            val message = errorElement["message"]?.jsonPrimitive?.content
            when {
              code != null && message != null -> "$code: $message"
              message != null -> message
              else -> errorElement.toString()
            }
          }
          else -> errorElement.jsonPrimitive.content
        }
      }

    val response =
      when (toolName) {
        "tapOn" -> json.decodeFromJsonElement<TapOnResponse>(objectElement)
        "observe" -> json.decodeFromJsonElement<ObserveResponse>(objectElement)
        "executePlan" -> json.decodeFromJsonElement<ExecutePlanResponse>(objectElement)
        else -> GenericToolResponse(success = success, payload = objectElement)
      }

    return ToolResult(
      stepIndex = stepIndex,
      toolName = toolName,
      success = success,
      response = response,
      error = error,
    )
  }

  fun parseToolResultFromMcpResponse(
    stepIndex: Int,
    toolName: String,
    mcpResult: JsonElement,
  ): ToolResult {
    val response = json.decodeFromJsonElement<McpToolResponse>(mcpResult)
    val textPayload =
      response.content.firstOrNull { it.type == "text" }?.text
        ?: throw SerializationException("MCP response did not contain text content")
    return parseToolResult(stepIndex, toolName, textPayload)
  }

  fun parseTapOnResponse(jsonString: String): TapOnResponse =
    json.decodeFromString(serializer<TapOnResponse>(), jsonString)

  fun parseObserveResponse(jsonString: String): ObserveResponse =
    json.decodeFromString(serializer<ObserveResponse>(), jsonString)

  fun parseExecutePlanResponse(jsonString: String): ExecutePlanResponse =
    json.decodeFromString(serializer<ExecutePlanResponse>(), jsonString)

  private fun inferSuccess(result: JsonObject): Boolean {
    val successValue = result["success"]?.jsonPrimitive?.content?.toBooleanStrictOrNull()
    if (successValue != null) {
      return successValue
    }
    return result["error"] == null
  }
}
