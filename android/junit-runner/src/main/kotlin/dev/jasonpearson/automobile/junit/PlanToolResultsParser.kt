package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.validation.ErrorToolResult
import dev.jasonpearson.automobile.validation.ToolResult
import dev.jasonpearson.automobile.validation.ToolResultEntry
import dev.jasonpearson.automobile.validation.ToolResultParser
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object PlanToolResultsParser {
  internal fun parseToolResults(
    response: DaemonResponse,
    json: Json,
    debugMode: Boolean,
  ): List<ToolResultEntry> {
    return try {
      val resultElement = response.result ?: return emptyList()
      val contentArray = resultElement.jsonObject["content"] as? JsonArray ?: return emptyList()
      val contentText =
        contentArray
          .firstOrNull { element ->
            (element as? JsonObject)?.get("type")?.jsonPrimitive?.content == "text"
          }
          ?.jsonObject
          ?.get("text")
          ?.jsonPrimitive
          ?.content ?: return emptyList()
      val payload = json.parseToJsonElement(contentText).jsonObject
      val stepsElement = payload["toolResults"] ?: payload["toolResult"] ?: return emptyList()
      val stepsArray = stepsElement as? JsonArray ?: return emptyList()

      stepsArray.mapIndexed { index, stepElement ->
        parseToolResultStep(index, stepElement, debugMode)
      }
    } catch (e: IllegalArgumentException) {
      if (debugMode) {
        println("Warning: Failed to parse tool results: ${e.message}")
      }
      listOf(
        buildErrorToolResult(
          stepIndex = -1,
          toolName = null,
          errorMessage = e.message ?: "Failed to parse tool results",
        ),
      )
    }
  }

  private fun parseToolResultStep(
    stepIndex: Int,
    stepElement: JsonElement,
    debugMode: Boolean,
  ): ToolResultEntry {
    val stepObject =
      stepElement as? JsonObject
        ?: return buildErrorToolResult(
          stepIndex = stepIndex,
          toolName = null,
          errorMessage = "Tool result is not a JSON object",
          payload = stepElement,
        )
    val toolName =
      stepObject["toolName"]?.jsonPrimitive?.content
        ?: stepObject["tool"]?.jsonPrimitive?.content
        ?: stepObject["name"]?.jsonPrimitive?.content

    val resolvedStepIndex =
      (stepObject["stepIndex"] as? JsonPrimitive)?.intOrNull
        ?: (stepObject["index"] as? JsonPrimitive)?.intOrNull
        ?: stepIndex

    if (toolName.isNullOrBlank()) {
      val errorMessage =
        extractErrorMessage(stepObject) ?: "Missing tool name for step $resolvedStepIndex"
      if (debugMode) {
        println("Warning: $errorMessage")
      }
      return buildErrorToolResult(
        stepIndex = resolvedStepIndex,
        toolName = null,
        errorMessage = errorMessage,
        payload = stepObject,
      )
    }

    return parseStepResponse(resolvedStepIndex, toolName, stepObject, debugMode)
  }

  private fun parseStepResponse(
    resolvedStepIndex: Int,
    toolName: String,
    stepObject: JsonObject,
    debugMode: Boolean,
  ): ToolResultEntry {
    val responseElement =
      stepObject["response"]
        ?: stepObject["result"]
        ?: stepObject["payload"]
        ?: stepObject["output"]

    return try {
      when {
        responseElement != null ->
          parseToolResultElement(resolvedStepIndex, toolName, responseElement)
        stepObject["content"] != null ->
          ToolResultParser.parseToolResultFromMcpResponse(
            resolvedStepIndex,
            toolName,
            stepObject,
          )
        else -> ToolResultParser.parseToolResult(resolvedStepIndex, toolName, stepObject)
      }
    } catch (e: IllegalArgumentException) {
      val errorMessage =
        extractErrorMessage(stepObject, responseElement)
          ?: e.message
          ?: "Failed to parse tool result"
      if (debugMode) {
        println("Warning: Failed to parse tool result at step $resolvedStepIndex: $errorMessage")
      }
      buildErrorToolResult(
        stepIndex = resolvedStepIndex,
        toolName = toolName,
        errorMessage = errorMessage,
        payload = stepObject,
      )
    }
  }

  private fun parseToolResultElement(
    stepIndex: Int,
    toolName: String,
    element: JsonElement,
  ): ToolResult {
    return when (element) {
      is JsonObject ->
        if (element.containsKey("content")) {
          ToolResultParser.parseToolResultFromMcpResponse(stepIndex, toolName, element)
        } else {
          ToolResultParser.parseToolResult(stepIndex, toolName, element)
        }
      is JsonPrimitive -> ToolResultParser.parseToolResult(stepIndex, toolName, element.content)
      else -> ToolResultParser.parseToolResult(stepIndex, toolName, element)
    }
  }

  private fun buildErrorToolResult(
    stepIndex: Int,
    toolName: String?,
    errorMessage: String,
    payload: JsonElement? = null,
  ): ErrorToolResult {
    return ErrorToolResult(
      stepIndex = stepIndex,
      toolName = toolName,
      errorMessage = errorMessage,
      payload = payload,
    )
  }

  private fun extractErrorMessage(
    stepObject: JsonObject,
    responseElement: JsonElement? = null,
  ): String? {
    val stepError = (stepObject["error"] as? JsonPrimitive)?.content
    if (!stepError.isNullOrBlank()) {
      return stepError
    }
    val responseError = (responseElement as? JsonObject)?.get("error") as? JsonPrimitive
    return responseError?.content
  }
}
