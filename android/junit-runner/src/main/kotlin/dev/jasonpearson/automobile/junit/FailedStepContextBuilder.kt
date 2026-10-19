package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object FailedStepContextBuilder {
  // ── Build FailedStepContext from daemon response ──────────────────────────

  internal fun buildFailedStepContext(
    response: DaemonResponse,
    json: Json,
    planContent: String,
    deviceId: String?,
    secretValues: List<String>,
  ): FailedStepContext? {
    try {
      val resultElement = response.result ?: return null
      val contentArray = resultElement.jsonObject["content"] as? JsonArray ?: return null
      val contentText =
        contentArray
          .firstOrNull { element ->
            (element as? JsonObject)?.get("type")?.jsonPrimitive?.content == "text"
          }
          ?.jsonObject
          ?.get("text")
          ?.jsonPrimitive
          ?.content ?: return null
      val payload = json.parseToJsonElement(contentText).jsonObject

      val failedStepObj = payload["failedStep"]?.jsonObject ?: return null
      val failedStepIndex =
        failedStepObj["stepIndex"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
      val failedTool = failedStepObj["tool"]?.jsonPrimitive?.content ?: "unknown"
      val error = failedStepObj["error"]?.jsonPrimitive?.content ?: "Unknown error"
      val resolvedDeviceId =
        resolveFailedStepDeviceId(
          payload = payload,
          failedStepObj = failedStepObj,
          configuredDeviceId = deviceId,
        )

      val succeededSteps = succeededSteps(payload, failedStepIndex, secretValues)

      // Egress boundary (issue #6029): FailedStepContext.planContent, error, and the (possibly
      // substituted) tool names are embedded verbatim into the recovery prompt sent to the LLM
      // provider (see AutoMobileAgent.attemptAiRecovery), so mask secret values out of them here.
      // The daemon's base64 payload above kept the real values.
      return FailedStepContext(
        failedStepIndex = failedStepIndex,
        failedTool = SecretRedactor.redact(failedTool, secretValues),
        error = SecretRedactor.redact(error, secretValues),
        succeededSteps = succeededSteps,
        planContent = SecretRedactor.redact(planContent, secretValues),
        deviceId = resolvedDeviceId,
      )
    } catch (e: IllegalArgumentException) {
      println("Warning: Failed to build recovery context: ${e.message}")
      return null
    }
  }

  /**
   * The real device id the failed step ran on, for pinning the recovery and the resumed plan.
   *
   * `failedStep.device` is the plan's device LABEL ("A"), never an id, so it is only a key into the
   * payload's `deviceMapping` (label -> id, multi-device plans). A single-device plan has no label
   * and ran on the payload's top-level `deviceId`. A label with no mapping entry yields null (no
   * pin) rather than the label or another track's device. [configuredDeviceId] is the id the test
   * asked for, used only when the payload carries none.
   */
  private fun resolveFailedStepDeviceId(
    payload: JsonObject,
    failedStepObj: JsonObject,
    configuredDeviceId: String?,
  ): String? {
    val label = (failedStepObj["device"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (label != null) {
      val mapping = payload["deviceMapping"] as? JsonObject
      return (mapping?.get(label) as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
    val executedOn = (payload["deviceId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    return executedOn?.takeIf { it.isNotBlank() }
      ?: configuredDeviceId?.takeIf { it.isNotBlank() && it != "auto" }
  }

  private fun succeededSteps(
    payload: JsonObject,
    failedStepIndex: Int,
    secretValues: List<String>,
  ): List<SucceededStepSummary> {
    val succeededSteps = mutableListOf<SucceededStepSummary>()
    val toolResultsArray = (payload["toolResults"] ?: payload["toolResult"]) as? JsonArray
    if (toolResultsArray != null) {
      for ((position, stepElement) in toolResultsArray.withIndex()) {
        val stepObj = stepElement as? JsonObject ?: continue
        // The daemon reports completed steps only, tagged with the plan step index, so a
        // skipped optional step leaves a gap; fall back to the position for untagged entries.
        val index = (stepObj["stepIndex"] as? JsonPrimitive)?.intOrNull ?: position
        if (index >= failedStepIndex) continue
        val tool =
          stepObj["toolName"]?.jsonPrimitive?.content
            ?: stepObj["tool"]?.jsonPrimitive?.content
            ?: "unknown"
        // A step's tool can be a substituted `${secret}` value, so scrub the name too (#6029).
        succeededSteps.add(
          SucceededStepSummary(
            stepIndex = index,
            tool = SecretRedactor.redact(tool, secretValues),
          ),
        )
      }
    }

    return succeededSteps
  }
}
