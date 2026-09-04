package dev.jasonpearson.automobile.junit

import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Issue #6029 (CWE-200): a secret plan parameter must never reach the third-party LLM provider
 * during AI-assisted recovery. These tests drive the FULL executor with a real plan, capture the
 * [FailedStepContext] handed to the recovery agent (the egress boundary — [AutoMobileAgent] embeds
 * `planContent`/`error` verbatim into the prompt it sends to the provider), and assert the secret
 * is absent while non-secret context is preserved. They also assert the base64 `executePlan`
 * payload sent to the LOCAL daemon keeps the REAL secret, since the daemon is not the egress
 * boundary.
 */
class AutoMobilePlanRedactionTest {
  private val secret = "SECRET-hunter2-TOKEN"
  private val visible = "keepme-visible-env"

  private lateinit var fakeDaemonClient: CapturingDaemonToolClient
  private lateinit var capturingAgent: CapturingAgent

  @Before
  fun setup() {
    fakeDaemonClient = CapturingDaemonToolClient()
    DaemonSocketClientManager.testClient = fakeDaemonClient
    AutoMobileSharedUtils.testDeviceChecker = RedactionDeviceChecker(devicesAvailable = true)
    DaemonHeartbeat.testController = RedactionDaemonHeartbeat()
    capturingAgent = CapturingAgent()
    AutoMobilePlanExecutor.testAgent = capturingAgent
    // Recovery is skipped in CI mode; force it off so the recovery path (and its redaction) runs.
    System.setProperty("automobile.ci.mode", "false")
  }

  @After
  fun tearDown() {
    DaemonSocketClientManager.testClient = null
    AutoMobileSharedUtils.testDeviceChecker = null
    DaemonHeartbeat.testController = null
    AutoMobilePlanExecutor.testAgent = null
    System.clearProperty("automobile.ci.mode")
  }

  @Test
  fun `secret parameter is redacted from recovery context while non-secret is preserved`() {
    // The failing step's error also carries the secret, exercising the error-scrub path.
    fakeDaemonClient.executePlanResponse =
      buildFailureResponse(error = "timed out entering $secret into field")

    AutoMobilePlanExecutor.execute(
      "test-plans/redaction-plan.yaml",
      mapOf("SECRET_TOKEN" to secret, "ENVIRONMENT" to visible),
      AutoMobilePlanExecutionOptions(device = "emulator-5554"),
    )

    val context = requireNotNull(capturingAgent.captured) { "recovery must receive a context" }

    assertFalse(
      "secret must not appear in the recovery plan content",
      context.planContent.contains(secret),
    )
    assertFalse(
      "secret must not appear in the recovery error string",
      context.error.contains(secret),
    )
    assertTrue(
      "the secret is replaced by the redaction placeholder",
      context.planContent.contains(SecretRedactor.PLACEHOLDER),
    )
    assertTrue(
      "non-secret substituted context is preserved",
      context.planContent.contains(visible),
    )

    // The base64 executePlan payload sent to the LOCAL daemon must keep the REAL secret so the plan
    // can actually run — the daemon is not the egress boundary.
    val daemonPlan = decodeDaemonPlanContent()
    assertNotNull("daemon must have received an executePlan payload", daemonPlan)
    assertTrue(
      "daemon executePlan payload must stay unredacted",
      daemonPlan!!.contains(secret),
    )
  }

  @Test
  fun `secret declared only via options secretParameterKeys is redacted`() {
    fakeDaemonClient.executePlanResponse = buildFailureResponse(error = "boom $secret")

    AutoMobilePlanExecutor.execute(
      // Reuse the plan but drive the secret purely through options, not the plan's
      // secretParameters.
      "test-plans/redaction-plan.yaml",
      mapOf("SECRET_TOKEN" to secret, "ENVIRONMENT" to visible),
      AutoMobilePlanExecutionOptions(
        device = "emulator-5554",
        secretParameterKeys = setOf("ENVIRONMENT"),
      ),
    )

    val context = requireNotNull(capturingAgent.captured)
    assertFalse(
      "an options-declared secret must also be redacted",
      context.planContent.contains(visible),
    )
  }

  @Test
  fun `secret substituted into a failing tool name is redacted`() {
    fakeDaemonClient.executePlanResponse = buildFailureResponse(error = "boom", tool = secret)

    AutoMobilePlanExecutor.execute(
      "test-plans/redaction-plan.yaml",
      mapOf("SECRET_TOKEN" to secret, "ENVIRONMENT" to visible),
      AutoMobilePlanExecutionOptions(device = "emulator-5554"),
    )

    val context = requireNotNull(capturingAgent.captured)
    assertFalse(
      "a secret substituted into a tool name must be redacted",
      context.failedTool.contains(secret),
    )
  }

  @Test
  fun `scrubs exactly what the executor substitution produced`() {
    // Sorted-key single pass: ${SECRET_TOKEN} -> sec-${AA}-zeta (AA resolved before TOKEN inserts
    // it,
    // ZZ after) — neither the raw value nor a fully-resolved fixpoint (#6029 review 695).
    fakeDaemonClient.executePlanResponse = buildFailureResponse(error = "boom")

    AutoMobilePlanExecutor.execute(
      "test-plans/redaction-plan.yaml",
      mapOf("SECRET_TOKEN" to "sec-\${AA}-\${ZZ}", "AA" to "alpha", "ZZ" to "zeta"),
      AutoMobilePlanExecutionOptions(device = "emulator-5554"),
    )

    val context = requireNotNull(capturingAgent.captured)
    assertFalse(
      "the actual substituted secret must be scrubbed",
      context.planContent.contains("sec-"),
    )
    // Positive assertions so the test can't pass on an empty/malformed context.
    assertTrue(
      "the secret must be replaced by the placeholder",
      context.planContent.contains(SecretRedactor.PLACEHOLDER),
    )
    assertTrue(
      "non-secret plan structure must be preserved",
      context.planContent.contains("launchApp"),
    )
  }

  @Test
  fun `self referential secret terminates and is redacted`() {
    // No fixpoint: the executor's single pass turns ${SECRET_TOKEN} into marker-${SECRET_TOKEN}
    // once,
    // so there is no unbounded expansion (#6029 review 701).
    fakeDaemonClient.executePlanResponse = buildFailureResponse(error = "boom")

    AutoMobilePlanExecutor.execute(
      "test-plans/redaction-plan.yaml",
      mapOf("SECRET_TOKEN" to "marker-\${SECRET_TOKEN}"),
      AutoMobilePlanExecutionOptions(device = "emulator-5554"),
    )

    val context = requireNotNull(capturingAgent.captured)
    assertFalse(
      "the self-referential secret must be redacted",
      context.planContent.contains("marker-"),
    )
    assertTrue(
      "the secret must be replaced by the placeholder",
      context.planContent.contains(SecretRedactor.PLACEHOLDER),
    )
    assertTrue(
      "non-secret plan structure must be preserved",
      context.planContent.contains("launchApp"),
    )
  }

  @Test
  fun `parameterized secret key name is redacted`() {
    fakeDaemonClient.executePlanResponse = buildFailureResponse(error = "boom")

    AutoMobilePlanExecutor.execute(
      "test-plans/redaction-parameterized-key.yaml",
      mapOf("SECRET_KEY" to "apiToken", "apiToken" to secret),
      AutoMobilePlanExecutionOptions(device = "emulator-5554"),
    )

    val context = requireNotNull(capturingAgent.captured)
    assertFalse(
      "a parameterized secret key name must resolve and redact",
      context.planContent.contains(secret),
    )
    assertTrue(
      "the secret must be replaced by the placeholder",
      context.planContent.contains(SecretRedactor.PLACEHOLDER),
    )
    assertTrue(
      "non-secret plan structure must be preserved",
      context.planContent.contains("launchApp"),
    )
  }

  @Test
  fun `debug mode does not print substituted secret values in the plan content`() {
    fakeDaemonClient.executePlanResponse = buildFailureResponse(error = "boom")
    val originalOut = System.out
    val captured = java.io.ByteArrayOutputStream()
    System.setOut(java.io.PrintStream(captured, true, "UTF-8"))
    try {
      AutoMobilePlanExecutor.execute(
        "test-plans/redaction-plan.yaml",
        mapOf("SECRET_TOKEN" to secret, "ENVIRONMENT" to visible),
        AutoMobilePlanExecutionOptions(device = "emulator-5554", debugMode = true),
      )
    } finally {
      System.setOut(originalOut)
    }
    assertFalse(
      "debugMode must not emit the substituted secret to logcat",
      captured.toString("UTF-8").contains(secret),
    )
  }

  private fun decodeDaemonPlanContent(): String? {
    val raw =
      fakeDaemonClient.executePlanArguments?.get("planContent")?.jsonPrimitive?.content
        ?: return null
    val base64 = raw.removePrefix("base64:")
    return String(Base64.getDecoder().decode(base64))
  }

  private fun buildFailureResponse(error: String, tool: String = "inputText"): DaemonResponse {
    val payload =
      JsonObject(
        mapOf(
          "success" to JsonPrimitive(false),
          "executedSteps" to JsonPrimitive(1),
          "totalSteps" to JsonPrimitive(3),
          "failedStep" to
            JsonObject(
              mapOf(
                "stepIndex" to JsonPrimitive(1),
                "tool" to JsonPrimitive(tool),
                "error" to JsonPrimitive(error),
              )
            ),
        )
      )
    val textPayload = Json.encodeToString(JsonElement.serializer(), payload)
    val result =
      JsonObject(
        mapOf(
          "content" to
            JsonArray(
              listOf(
                JsonObject(
                  mapOf(
                    "type" to JsonPrimitive("text"),
                    "text" to JsonPrimitive(textPayload),
                  )
                )
              )
            )
        )
      )
    return DaemonResponse(
      id = "test",
      type = "mcp_response",
      success = true,
      result = result,
      error = null,
    )
  }
}

/**
 * Captures the [FailedStepContext] the executor hands to recovery, then reports a failed outcome.
 */
private class CapturingAgent :
  AutoMobileAgent(
    recoveryConfigProvider = StaticRecoveryConfigProvider(enabled = true, maxToolCalls = 5)
  ) {
  var captured: FailedStepContext? = null

  override fun attemptAiRecovery(context: FailedStepContext): RecoveryOutcome {
    captured = context
    return RecoveryOutcome(success = false, recoveryTimeMs = 0)
  }
}

/** Fake daemon client that records the executePlan arguments and returns a scripted response. */
private class CapturingDaemonToolClient : DaemonToolClient {
  var executePlanResponse: DaemonResponse? = null
  var executePlanArguments: JsonObject? = null
  override var sessionUuid: String = "test-session"

  override fun callTool(
    toolName: String,
    arguments: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse {
    return when (toolName) {
      "setToolEnabled" -> DaemonResponse(id = "sel", type = "mcp_response", success = true)
      "executePlan" -> {
        executePlanArguments = arguments
        executePlanResponse ?: throw IllegalStateException("no executePlan response configured")
      }
      else -> throw IllegalStateException("unexpected tool: $toolName")
    }
  }

  override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
    throw IllegalStateException("readResource not configured for $uri")
  }
}

private class RedactionDeviceChecker(private val devicesAvailable: Boolean) : DeviceChecker {
  override fun checkDeviceAvailability() = Unit

  override fun areDevicesAvailable(): Boolean = devicesAvailable

  override fun getDeviceCount(): Int = if (devicesAvailable) 1 else 0
}

private class RedactionDaemonHeartbeat : DaemonHeartbeatController {
  override fun startBackground(intervalMs: Long) = java.io.Closeable {}

  override fun registerSession(sessionId: String) = Unit

  override fun unregisterSession(sessionId: String) = Unit
}
