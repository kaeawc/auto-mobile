package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.validation.ErrorToolResult
import dev.jasonpearson.automobile.validation.ToolResult
import dev.jasonpearson.automobile.validation.ToolResultEntry
import dev.jasonpearson.automobile.validation.ToolResultParser
import java.io.File
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Test

/** Stateless plan preparation, response parsing, and refusal classification shared by executors. */
internal object AutoMobilePlanExecutor {

  /** Detected test context from stack trace inspection. */
  internal data class TestContext(val className: String, val methodName: String)

  /**
   * Detect the calling test class and method from the current stack trace. Looks for methods
   * annotated with @Test by inspecting the call stack.
   */
  internal fun detectTestContext(): TestContext? {
    val stackTrace = Thread.currentThread().stackTrace

    for (element in stackTrace) {
      // Skip internal classes
      if (
        element.className.startsWith("java.") ||
          element.className.startsWith("kotlin.") ||
          element.className.startsWith("jdk.") ||
          element.className.startsWith("sun.") ||
          element.className.contains("AutoMobilePlan")
      ) {
        continue
      }

      try {
        val clazz = Class.forName(element.className)
        val methods = clazz.declaredMethods

        for (method in methods) {
          if (method.name == element.methodName && method.isAnnotationPresent(Test::class.java)) {
            // Found a @Test annotated method in the call stack
            // Fully qualified: two `SmokeTest` classes in different packages must not share one
            // (test_class, test_method) history (#10091).
            return TestContext(clazz.name, method.name)
          }
        }
      } catch (_: ClassNotFoundException) {
        // Class not found, skip
      } catch (_: NoClassDefFoundError) {
        // Class definition error, skip
      }
    }

    return null
  }

  /** Build test metadata JSON object for the daemon request. */
  internal fun buildTestMetadata(testContext: TestContext): JsonObject {
    val metadata =
      mutableMapOf<String, JsonElement>(
        "testClass" to JsonPrimitive(testContext.className),
        "testMethod" to JsonPrimitive(testContext.methodName),
        "isCi" to JsonPrimitive(resolveCiMode()),
      )

    // Add optional metadata if available
    val appVersion =
      firstNonBlank(
        System.getProperty("automobile.app.version", ""),
        System.getenv("AUTOMOBILE_APP_VERSION"),
        System.getenv("APP_VERSION"),
      )
    if (appVersion != null) {
      metadata["appVersion"] = JsonPrimitive(appVersion)
    }

    val gitCommit =
      firstNonBlank(
        System.getProperty("automobile.git.commit", ""),
        System.getenv("AUTOMOBILE_GIT_COMMIT"),
        System.getenv("GITHUB_SHA"),
        System.getenv("GIT_COMMIT"),
        System.getenv("CI_COMMIT_SHA"),
      )
    if (gitCommit != null) {
      metadata["gitCommit"] = JsonPrimitive(gitCommit)
    }

    val targetSdk =
      firstNonBlank(
          System.getProperty("automobile.android.targetSdk", ""),
          System.getProperty("automobile.targetSdk", ""),
          System.getenv("AUTOMOBILE_TARGET_SDK"),
          System.getenv("ANDROID_TARGET_SDK"),
        )
        ?.toIntOrNull()
    if (targetSdk != null) {
      metadata["targetSdk"] = JsonPrimitive(targetSdk)
    }

    val jdkVersion =
      firstNonBlank(
        System.getProperty("java.version"),
        System.getProperty("java.runtime.version"),
      )
    if (jdkVersion != null) {
      metadata["jdkVersion"] = JsonPrimitive(jdkVersion)
    }

    val jvmTarget =
      firstNonBlank(
        System.getProperty("kotlin.jvm.target"),
        System.getProperty("java.specification.version"),
      )
    if (jvmTarget != null) {
      metadata["jvmTarget"] = JsonPrimitive(jvmTarget)
    }

    val gradleVersion =
      firstNonBlank(
        System.getProperty("org.gradle.version"),
        System.getProperty("gradle.version"),
      )
    if (gradleVersion != null) {
      metadata["gradleVersion"] = JsonPrimitive(gradleVersion)
    }

    return JsonObject(metadata)
  }

  internal fun resolveCiMode(): Boolean {
    val sysProp = System.getProperty("automobile.ci.mode")
    if (sysProp != null) {
      // Explicit system property takes precedence over environment
      return sysProp.toBoolean()
    }
    val envValue = System.getenv("CI") ?: return false
    return envValue.equals("true", ignoreCase = true) || envValue == "1"
  }

  private fun firstNonBlank(vararg values: String?): String? {
    return values.firstOrNull { !it.isNullOrBlank() }
  }

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

      // Build succeeded steps from toolResults in the payload
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
    } catch (e: Exception) {
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

  // ── Response parsing ──────────────────────────────────────────────────────

  internal fun parseDaemonToolResult(response: DaemonResponse, json: Json): ParsedToolResult {
    if (!response.success) {
      // A failed frame carries the typed refusal fields at the top level (#11544).
      val code = (response.code as? JsonPrimitive)?.takeIf { it.isString }?.content
      val details = response.details as? JsonObject ?: JsonObject(emptyMap())
      val recovering = details["recovering"] == JsonPrimitive(true)
      val devices = unhealthyDevices(details, recovering)
      return ParsedToolResult(
        false,
        if (code == DEVICE_UNHEALTHY_CODE)
          unhealthyFailureMessage(response.error ?: "Daemon returned failure", recovering, devices)
        else response.error ?: "Daemon returned failure",
        recovering = recovering,
        unhealthyDevices = devices,
        retryable = response.retryable == JsonPrimitive(true),
        code = code,
        daemonMessage = response.error,
        acquireNewSession =
          (response.nextAction as? JsonPrimitive)?.takeIf { it.isString }?.content ==
            ACQUIRE_NEW_SESSION_NEXT_ACTION,
        retryAfterMs = retryAfterHintMs(response.retryAfterMs),
        // Only an explicit `retryable: false` on a typed code is the daemon's final verdict; a
        // frame that omits the flag (older daemons, `daemon_queue_timeout` today) keeps the
        // message-based retry it always had.
        terminal = code != null && response.retryable == JsonPrimitive(false),
      )
    }

    val resultElement =
      response.result ?: return ParsedToolResult(false, "Daemon returned empty result")
    val resultObject =
      resultElement as? JsonObject
        ?: return ParsedToolResult(false, "Unexpected daemon response format: $resultElement")
    val isError = resultObject["isError"] == JsonPrimitive(true)
    val contentText =
      (resultObject["content"] as? JsonArray)
        ?.firstOrNull { (it as? JsonObject)?.get("type") == JsonPrimitive("text") }
        ?.let { (it as JsonObject)["text"] as? JsonPrimitive }
        ?.content
    val parsed =
      (resultObject["structuredContent"] as? JsonObject)
        ?: contentText?.let {
          try {
            json.parseToJsonElement(it) as? JsonObject
          } catch (e: SerializationException) {
            println("Warning: Failed to parse daemon result: ${e.message}")
            return ParsedToolResult(false, "Malformed daemon result: $it")
          }
        }
        ?: return ParsedToolResult(false, "Unexpected daemon response format: $resultElement")

    // JSON strings such as "true" are not an affirmative boolean plan result.
    val success = parsed["success"] == JsonPrimitive(true)
    return parseToolPayload(parsed, isError, success)
  }

  /** Reads the typed refusal fields from a daemon tool payload, top level or nested in `error`. */
  private fun parseToolPayload(
    parsed: JsonObject,
    isError: Boolean,
    success: Boolean,
  ): ParsedToolResult {
    val errorObject = parsed["error"] as? JsonObject
    val recovering = (errorObject?.get("recovering") ?: parsed["recovering"]) == JsonPrimitive(true)
    val devices =
      unhealthyDevices(JsonObject(parsed + (errorObject ?: JsonObject(emptyMap()))), recovering)
    val retryable =
      errorObject?.get("retryable") == JsonPrimitive(true) ||
        parsed["retryable"] == JsonPrimitive(true)
    // A terminal-session refusal says `retryable: false` for its UUID and `nextAction:
    // acquire_new_session` (#11098); a retry here always runs under a fresh session UUID.
    val acquireNewSession =
      ((errorObject?.get("nextAction") ?: parsed["nextAction"]) as? JsonPrimitive)
        ?.takeIf { it.isString }
        ?.content == ACQUIRE_NEW_SESSION_NEXT_ACTION
    if (isError || parsed.containsKey("error") || !success) {
      // The typed `code` (never the message) is what clients match on.
      val code =
        ((errorObject?.get("code") ?: parsed["code"]) as? JsonPrimitive)
          ?.takeIf { it.isString }
          ?.content
      val daemonMessage =
        (if (code in RECOVERY_CODES) errorObject?.get("message") as? JsonPrimitive else null)
          ?.takeIf { it.isString }
          ?.content ?: (parsed["error"] as? JsonPrimitive)?.takeIf { it.isString }?.content
      return ParsedToolResult(
        false,
        if (code == DEVICE_UNHEALTHY_CODE)
          unhealthyFailureMessage(
            daemonMessage ?: "Daemon refused the request",
            recovering,
            devices,
          )
        else planFailureMessage(parsed, isError),
        retryable,
        code,
        daemonMessage,
        sessionHeld =
          when (parsed["sessionHeld"]) {
            JsonPrimitive(true) -> true
            JsonPrimitive(false) -> false
            else -> null
          },
        recovering = recovering,
        unhealthyDevices = devices,
        acquireNewSession = acquireNewSession,
        retryAfterMs = retryAfterHintMs(errorObject?.get("retryAfterMs") ?: parsed["retryAfterMs"]),
      )
    }
    return ParsedToolResult(true, "")
  }

  /**
   * How a refusal rendered into a thrown tool error (`... returned an error: {json}`) is handled,
   * decided by the same typed fields and wait rule as the `executePlan` loop (the
   * `test/fixtures/refusal-wire` table). Null when the text carries no JSON object.
   */
  internal data class RefusalVerdict(
    val disposition: RefusalDisposition,
    val code: String?,
    val retryAfterMs: Long?,
  )

  internal fun classifyRefusalText(text: String, json: Json = Json): RefusalVerdict? {
    val start = text.indexOf('{')
    val end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    val payload =
      try {
        json.parseToJsonElement(text.substring(start, end + 1)) as? JsonObject
      } catch (e: SerializationException) {
        println("Warning: refusal text is not a JSON payload: ${e.message}")
        null
      } ?: return null
    val parsed = parseToolPayload(payload, isError = true, success = false)
    return RefusalVerdict(refusalDisposition(parsed), parsed.code, parsed.retryAfterMs)
  }

  /** How the runner reacts to a daemon refusal; one row of `test/fixtures/refusal-wire`. */
  internal enum class RefusalDisposition(val wire: String) {
    WAIT("wait"),
    ACQUIRE_NEW_SESSION("acquire-new-session"),
    RETRY("retry"),
    FAIL("fail"),
  }

  internal fun refusalDisposition(parsed: ParsedToolResult): RefusalDisposition =
    when {
      waitsForDevice(parsed) -> RefusalDisposition.WAIT
      parsed.acquireNewSession -> RefusalDisposition.ACQUIRE_NEW_SESSION
      parsed.retryable -> RefusalDisposition.RETRY
      else -> RefusalDisposition.FAIL
    }

  /** Classifies a failed daemon tool response the way the executePlan loop does. */
  internal fun classifyRefusal(response: DaemonResponse, json: Json): RefusalDisposition =
    refusalDisposition(parseDaemonToolResult(response, json))

  /** What the runner reads from a refusal; pinned per fixture in `expectations.json`. */
  internal data class RefusalEvidence(
    val code: String?,
    val retryable: Boolean,
    val acquireNewSession: Boolean,
    val retryAfterMs: Long?,
    val recovering: Boolean,
  )

  internal fun refusalEvidence(response: DaemonResponse, json: Json): RefusalEvidence =
    parseDaemonToolResult(response, json).let {
      RefusalEvidence(it.code, it.retryable, it.acquireNewSession, it.retryAfterMs, it.recovering)
    }

  internal data class UnhealthyDevice(
    val deviceId: String,
    val reason: String,
    val recovering: Boolean,
  )

  private fun unhealthyDevices(payload: JsonObject, recovering: Boolean): List<UnhealthyDevice> {
    fun device(objectValue: JsonObject, state: Boolean): UnhealthyDevice? {
      val id =
        (objectValue["deviceId"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      val reason =
        (objectValue["reason"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      return UnhealthyDevice(id, reason, state)
    }
    val devices = payload["devices"] as? JsonArray
    if (devices != null)
      return devices.mapNotNull {
        val entry = it as? JsonObject ?: return@mapNotNull null
        device(entry, entry["recovering"] == JsonPrimitive(true))
      }
    return listOfNotNull(device(payload, recovering))
  }

  private fun unhealthyDevicesMessage(devices: List<UnhealthyDevice>): String =
    "Unhealthy devices: " +
      devices.joinToString(", ") {
        "${it.deviceId} (${it.reason}, ${if (it.recovering) "recovering" else "not recovering"})"
      }

  private fun unhealthyFailureMessage(
    message: String,
    recovering: Boolean,
    devices: List<UnhealthyDevice>,
  ): String =
    "$DEVICE_UNHEALTHY_CODE: $message\n${unhealthyDevicesMessage(devices)}" +
      (if (!recovering) "\nReplace the device with killDevice then startDevice." else "")

  private fun planFailureMessage(payload: JsonObject, isError: Boolean): String {
    val errorObject = payload["error"] as? JsonObject
    val failedStepObj = payload["failedStep"] as? JsonObject
    if (failedStepObj != null && errorObject == null && payload["code"] == null) {
      val stepIndex = (failedStepObj["stepIndex"] as? JsonPrimitive)?.intOrNull ?: 0
      val tool = (failedStepObj["tool"] as? JsonPrimitive)?.content ?: "unknown"
      val stepError = (failedStepObj["error"] as? JsonPrimitive)?.content ?: "Unknown step error"
      val executedSteps = (payload["executedSteps"] as? JsonPrimitive)?.intOrNull
      val totalSteps = (payload["totalSteps"] as? JsonPrimitive)?.intOrNull
      return buildString {
        append("Test plan execution failed at step ${stepIndex + 1} ($tool):")
        append("\n  Error: $stepError")
        if (executedSteps != null && totalSteps != null) {
          append("\n  Executed: $executedSteps/$totalSteps steps")
        }
      }
    }
    val daemonError = errorObject ?: payload
    val details =
      listOfNotNull(
        (daemonError["code"] as? JsonPrimitive)?.content,
        (daemonError["message"] as? JsonPrimitive)?.content,
        (daemonError["deviceId"] as? JsonPrimitive)?.content,
      )
    if (errorObject != null || payload.containsKey("code") || payload.containsKey("message")) {
      if (details.isNotEmpty()) return details.joinToString(": ")
    }

    return (payload["error"] as? JsonPrimitive)?.content
      ?: when {
        isError -> "Daemon tool returned an error: $payload"
        payload["success"] == JsonPrimitive(false) -> "AutoMobile plan failed"
        else -> "Daemon result did not confirm plan success: $payload"
      }
  }

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
    } catch (e: Exception) {
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
    } catch (e: Exception) {
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

  /**
   * Optional `executePlan` post-run cleanup (daemon `toolRegistry` `finally`). Read fresh on each
   * build so per-test property changes apply (not cached via `SystemPropertyCache`).
   *
   * **System properties** (take precedence when set):
   * - `automobile.junit.executePlan.cleanupAppId` — non-blank package → daemon cleanup after plan
   * - `automobile.junit.executePlan.cleanupClearAppData` — `true` / `1` → clear app data; unset or
   *   false → force-stop only
   *
   * **Environment** (used when the property is unset for that field):
   * - `AUTOMOBILE_EXECUTE_PLAN_CLEANUP_APP_ID`
   * - `AUTOMOBILE_EXECUTE_PLAN_CLEANUP_CLEAR_APP_DATA` — `true` / `1` / `yes`
   *
   * This is intentionally **not** on `AutoMobilePlanExecutionOptions` so apps can keep compiling
   * against an older published runner while CI jobs that publish a newer JAR get the behavior.
   */
  internal fun appendExecutePlanCleanupArgs(args: MutableMap<String, JsonElement>) {
    val cleanupAppId = resolveExecutePlanCleanupAppId()
    if (cleanupAppId.isEmpty()) {
      return
    }
    args["cleanupAppId"] = JsonPrimitive(cleanupAppId)
    if (resolveExecutePlanCleanupClearAppData()) {
      args["cleanupClearAppData"] = JsonPrimitive(true)
    }
  }

  private fun resolveExecutePlanCleanupAppId(): String {
    val prop = System.getProperty("automobile.junit.executePlan.cleanupAppId")?.trim().orEmpty()
    if (prop.isNotEmpty()) {
      return prop
    }
    return System.getenv("AUTOMOBILE_EXECUTE_PLAN_CLEANUP_APP_ID")?.trim().orEmpty()
  }

  private fun resolveExecutePlanCleanupClearAppData(): Boolean {
    val propRaw = System.getProperty("automobile.junit.executePlan.cleanupClearAppData")
    if (propRaw != null) {
      val t = propRaw.trim()
      return t.equals("true", ignoreCase = true) || t == "1"
    }
    val env =
      System.getenv("AUTOMOBILE_EXECUTE_PLAN_CLEANUP_CLEAR_APP_DATA")?.trim()?.lowercase().orEmpty()
    return env == "true" || env == "1" || env == "yes"
  }

  internal const val CAPTURE_OBSERVE_STEPS_PROPERTY =
    "automobile.junit.executePlan.captureObserveSteps"
  internal const val CAPTURE_OBSERVE_STEPS_ENV = "AUTOMOBILE_EXECUTE_PLAN_CAPTURE_OBSERVE_STEPS"

  /**
   * When set, the daemon attaches each successful `observe` step to `executePlan` `debug` (see
   * AutoMobile `captureObserveSteps`). Single-device plans only.
   *
   * **System property:** [CAPTURE_OBSERVE_STEPS_PROPERTY] — `summary` or `full`
   *
   * **Environment:** [CAPTURE_OBSERVE_STEPS_ENV] (same values)
   */
  internal fun appendCaptureObserveStepsArgs(args: MutableMap<String, JsonElement>) {
    val v = resolveCaptureObserveSteps() ?: return
    args["captureObserveSteps"] = JsonPrimitive(v)
  }

  /**
   * Resolves the `captureObserveSteps` mode from system property (preferred) or environment
   * variable. Returns `null` if unset or set to an unrecognized value.
   */
  @JvmStatic
  internal fun resolveCaptureObserveSteps(): String? {
    val v =
      System.getProperty(CAPTURE_OBSERVE_STEPS_PROPERTY)?.trim()?.lowercase()
        ?: System.getenv(CAPTURE_OBSERVE_STEPS_ENV)?.trim()?.lowercase()
        ?: return null
    return v.takeIf { it == "summary" || it == "full" }
  }

  /**
   * `nextAction` of a terminal-session refusal: acquire a new session, never retry the UUID
   * (#11098).
   */
  internal const val ACQUIRE_NEW_SESSION_NEXT_ACTION = "acquire_new_session"

  /** Typed code for a device-mutating call refused because another session holds it (#10783). */
  internal const val DEVICE_OWNED_BY_OTHER_SESSION_CODE = "device_owned_by_other_session"

  /**
   * Typed code for a bind refused while the device's previous session finishes cleanup (#10960).
   */
  internal const val DEVICE_CLEANUP_IN_PROGRESS_CODE = "device_cleanup_in_progress"

  /** Typed code for a bind refused because another AutoMobile daemon claims the device (#10980). */
  internal const val DEVICE_OWNED_BY_OTHER_DAEMON_CODE = "device_owned_by_other_daemon"

  /** Typed code for a bind refused while the device is under a kill reservation (#11088). */
  internal const val DEVICE_SHUTTING_DOWN_CODE = "device_shutting_down"

  /** Typed code for acquisition refused because device health is marked unhealthy (#12112). */
  internal const val DEVICE_UNHEALTHY_CODE = "device_unhealthy"

  /** Typed code for a call refused while its session's device is recovering (#12113). */
  internal const val SESSION_HELD_BY_RECOVERY_CODE = "session_held_by_recovery"

  internal val RECOVERY_CODES = setOf(DEVICE_UNHEALTHY_CODE, SESSION_HELD_BY_RECOVERY_CODE)

  /** Refusals the runner waits out with the bounded held-device wait. */
  private val DEVICE_WAIT_CODES =
    setOf(
      DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      DEVICE_CLEANUP_IN_PROGRESS_CODE,
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      DEVICE_SHUTTING_DOWN_CODE,
    )

  /**
   * Typed codes that wait only when the daemon marks the refusal retryable (iOS parity, #11202).
   */
  internal const val CAPACITY_EXHAUSTED_CODE = "capacity_exhausted"
  internal const val DISCOVERY_INCOMPLETE_CODE = "discovery_incomplete"

  private val RETRYABLE_WAIT_CODES =
    setOf(CAPACITY_EXHAUSTED_CODE, DISCOVERY_INCOMPLETE_CODE, SESSION_HELD_BY_RECOVERY_CODE)

  /**
   * Whether the runner waits out this refusal within the bounded device wait: the held-device codes
   * always, capacity, discovery and session recovery only when retryable. Unhealthy devices also
   * require an explicit recovering boolean.
   */
  private fun waitsForDevice(parsed: ParsedToolResult): Boolean {
    val code = parsed.code ?: return false
    return code in DEVICE_WAIT_CODES ||
      (parsed.retryable &&
        (code in RETRYABLE_WAIT_CODES || (code == DEVICE_UNHEALTHY_CODE && parsed.recovering)))
  }

  private const val DEVICE_OWNED_INITIAL_DELAY_MS = 500L
  private const val DEVICE_OWNED_MAX_DELAY_MS = 4_000L

  /**
   * Longest the runner waits on a recording-finalize refusal (#11360). The daemon advertises its
   * real finalize cap (about 125 s) in `retryAfterMs`; this bounds a runaway hint. It is the
   * `finalizeWait.waitBudgetMs` of `test/fixtures/refusal-wire-hints/hints.json`, shared with the
   * MCP proxy and XCTestRunner.
   */
  internal const val DEVICE_FINALIZE_WAIT_CAP_MS = 150_000L

  /** Refusals whose `retryAfterMs` is the daemon's real finalize time, not a polling hint. */
  internal val FINALIZE_WAIT_CODES =
    setOf(DEVICE_CLEANUP_IN_PROGRESS_CODE, DEVICE_SHUTTING_DOWN_CODE)

  /**
   * A `retryAfterMs` hint as the runners use it: absent when zero or negative (as when missing),
   * otherwise clamped to [DEVICE_FINALIZE_WAIT_CAP_MS] so adding it to a waited time cannot
   * overflow (#11544). Swift's `DeviceWaitBackoff.usableHintMs` does the same.
   */
  internal fun positiveRetryAfterMs(retryAfterMs: Long?): Long? =
    retryAfterMs?.takeIf { it > 0 }?.coerceAtMost(DEVICE_FINALIZE_WAIT_CAP_MS)

  /** The usable hint of a wire `retryAfterMs` element: only a whole JSON number counts. */
  internal fun retryAfterHintMs(wire: JsonElement?): Long? =
    positiveRetryAfterMs((wire as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull)

  /**
   * Total wait budget for this refusal. For the finalize codes the daemon's `retryAfterMs` is the
   * finalize time STILL REMAINING, so it bounds the total: [waitedMs] already spent plus that hint,
   * clamped to [DEVICE_FINALIZE_WAIT_CAP_MS] and never below
   * [PlanExecutorTimings.deviceOwnedWaitBudgetMs] (#11360, #11538). Every other code, and a refusal
   * with no hint, keeps the plain budget.
   */
  private fun deviceOwnedBudgetMs(
    waitedMs: Long,
    retryAfterMs: Long?,
    code: String?,
    timings: PlanExecutorTimings,
  ): Long {
    val hintMs = positiveRetryAfterMs(retryAfterMs)
    if (code !in FINALIZE_WAIT_CODES || hintMs == null) return timings.deviceOwnedWaitBudgetMs
    // The hint is clamped before the addition so a hint near Long.MAX_VALUE cannot wrap negative.
    val untilFinalized = minOf(waitedMs + hintMs, DEVICE_FINALIZE_WAIT_CAP_MS)
    return maxOf(timings.deviceOwnedWaitBudgetMs, untilFinalized)
  }

  /**
   * Exponential delay (500ms doubling, capped at 4s) for the next wait on a held device, clamped to
   * the remaining budget; null once the budget is spent. For the finalize codes ([code]) the
   * daemon's `retryAfterMs` only bounds the total wait (up to 150 s, #11360); each step stays at
   * the ordinary backoff so a finalize that finishes early is noticed on the next poll (#11538).
   * For every other code a hint lengthens a step and never extends
   * [PlanExecutorTimings.deviceOwnedWaitBudgetMs].
   */
  internal fun deviceOwnedBackoffDelayMs(
    waitsSoFar: Int,
    waitedMs: Long,
    retryAfterMs: Long? = null,
    code: String? = null,
    timings: PlanExecutorTimings = PlanExecutorTimings(),
  ): Long? {
    val remaining = deviceOwnedBudgetMs(waitedMs, retryAfterMs, code, timings) - waitedMs
    if (remaining <= 0) return null
    val doubled = DEVICE_OWNED_INITIAL_DELAY_MS shl waitsSoFar.coerceAtMost(8)
    val backoff = minOf(doubled, DEVICE_OWNED_MAX_DELAY_MS)
    val hint = if (code in FINALIZE_WAIT_CODES) 0L else positiveRetryAfterMs(retryAfterMs) ?: 0L
    return minOf(maxOf(backoff, hint), remaining)
  }

  internal fun deviceOwnedGiveUpMessage(parsed: ParsedToolResult, waitedMs: Long): String {
    if (parsed.code in RECOVERY_CODES) {
      val lead =
        if (parsed.code == DEVICE_UNHEALTHY_CODE) "Device is still being recovered"
        else "Session's device is still being recovered"
      return "$lead (${parsed.code})" +
        (parsed.daemonMessage?.let { ": $it" } ?: "") +
        (if (parsed.code == DEVICE_UNHEALTHY_CODE)
          "\n${unhealthyDevicesMessage(parsed.unhealthyDevices)}"
        else "") +
        "\nThe runner waited ${waitedMs}ms for the recovery to finish."
    }
    return (when (parsed.code) {
      DEVICE_CLEANUP_IN_PROGRESS_CODE ->
        "Device is still finishing its previous session's cleanup ($DEVICE_CLEANUP_IN_PROGRESS_CODE)"
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE ->
        "Device is claimed by another AutoMobile daemon ($DEVICE_OWNED_BY_OTHER_DAEMON_CODE)"
      DEVICE_SHUTTING_DOWN_CODE -> "Device is shutting down ($DEVICE_SHUTTING_DOWN_CODE)"
      CAPACITY_EXHAUSTED_CODE -> "No device capacity is available ($CAPACITY_EXHAUSTED_CODE)"
      DISCOVERY_INCOMPLETE_CODE -> "Device discovery has not finished ($DISCOVERY_INCOMPLETE_CODE)"
      else -> "Device is held by another session ($DEVICE_OWNED_BY_OTHER_SESSION_CODE)"
    }) +
      (parsed.daemonMessage?.let { ": $it" } ?: "") +
      "\nThe runner waited ${waitedMs}ms for it to be released. Another test attempt or tool " +
      "session is using this device; give each concurrent test its own device, or run them " +
      "serially."
  }

  internal fun isTransientError(errorMessage: String?): Boolean {
    if (errorMessage.isNullOrBlank()) return false
    val normalized = errorMessage.lowercase()
    return normalized.contains("request timed out") ||
      normalized.contains("plan execution in progress") ||
      normalized.contains("daemon request timeout")
  }

  // ── Internal types ────────────────────────────────────────────────────────

  internal data class ParsedToolResult(
    val success: Boolean,
    val errorMessage: String,
    val retryable: Boolean = false,
    /** The daemon's typed error `code`, when it sent one. */
    val code: String? = null,
    /** The daemon's human-readable `error` string, when it sent one. */
    val daemonMessage: String? = null,
    /**
     * Whether the daemon kept the session after a failed run that asked to hold it (#11091); null
     * when it did not say.
     */
    val sessionHeld: Boolean? = null,
    /** The refusal named a terminal session UUID and told the client to acquire a new one. */
    val acquireNewSession: Boolean = false,
    /** The daemon's `retryAfterMs` hint for a retryable refusal, when it sent one. */
    val retryAfterMs: Long? = null,
    /** A typed failed frame said `retryable: false`: the daemon's final verdict (#11544). */
    val terminal: Boolean = false,
    val recovering: Boolean = false,
    val unhealthyDevices: List<UnhealthyDevice> = emptyList(),
  )
}
