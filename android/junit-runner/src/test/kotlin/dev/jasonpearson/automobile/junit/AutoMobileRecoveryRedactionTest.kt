package dev.jasonpearson.automobile.junit

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

internal class AutoMobileRecoveryRedactionTest : AutoMobileAgentTestFixture() {
  @Test
  fun `secret in a tool or observe result is scrubbed from what the recovery agent feeds the model`() {
    // Issue #6094 (CWE-200, second-order channel): after the initial (redacted) recovery prompt,
    // the Koog agent loop runs observe/tools and feeds their RESULTS (including the view hierarchy
    // from observe's withViewHierarchy=true) back to the LLM. A secret still visible on-screen at
    // recovery time must not reach the provider through those results. The agent's tools call the
    // client handed to createAIAgentWithMCPTools, so that client's returned strings are exactly
    // what
    // Koog forwards to the model — assert they are scrubbed, while the underlying client still
    // executes with real values.
    val secret = "SECRET-hunter2-TOKEN"
    val visible = "keepme-visible-env"
    val context =
      FailedStepContext(
        failedStepIndex = 1,
        failedTool = "inputText",
        error = "step failed",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = "emulator-5554",
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    // The live tool/observe results carry the on-screen secret plus non-secret context.
    fakeMcpClient.toolResults["observe"] =
      """{"elements":{"field":"token $secret"},"env":"$visible"}"""
    fakeMcpClient.toolResults["tapOn"] = """{"status":"typed $secret"}"""
    fakeAIAgent.response = "done"

    autoMobileAgent.attemptAiRecovery(context, secretValues = listOf(secret))

    // Drive the exact tools Koog builds from the captured client. observe first (the view-hierarchy
    // feed) then tapOn — both results are what the agent hands the LLM.
    val agentClient = fakeAiAgentFactory.recoveryCalls.single().mcpClient
    val observeResult = runBlocking {
      AutoMobileAgent.ObserveTool(agentClient).execute(AutoMobileAgent.ObserveTool.Args())
    }
    val tapResult = runBlocking {
      AutoMobileAgent.TapOnTool(agentClient).execute(AutoMobileAgent.TapOnTool.Args(text = "OK"))
    }

    assertFalse(
      observeResult.contains(secret),
      "observe/view-hierarchy result fed to the LLM must not contain the secret",
    )
    assertTrue(
      observeResult.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
    assertTrue(observeResult.contains(visible), "non-secret context must be preserved")
    assertFalse(
      tapResult.contains(secret),
      "tap result fed to the LLM must not contain the secret",
    )

    // The tool still EXECUTED against the device with the real value: the underlying client returns
    // the raw secret, so only the model-facing wrapper scrubs it (daemon/tool execution
    // unaffected).
    val rawObserve = fakeMcpClient.callTool("observe", emptyMap())
    assertTrue(
      rawObserve.contains(secret),
      "the underlying client (device execution) still receives real values",
    )
  }

  @Test
  fun `WaitForTool's raw client redacts a failure but leaves a success untouched during recovery`() {
    // Issue #6145 follow-up: WaitForTool is wired to the RAW client so its local text match keeps
    // working (a redacted copy would falsely time out). But DefaultMCPClient throws with the MCP
    // server's response body / error in the message on FAILURE, which can echo on-screen secret
    // data,
    // and WaitForTool logs that message on every failed poll. attemptAiRecovery must wrap the raw
    // client it hands WaitForTool in FailureRedactingMCPClient rather than passing mcpClient itself
    // unwrapped, so a thrown exception is redacted while a successful call stays byte-for-byte raw.
    val secret = "SECRET-hunter2-TOKEN"
    val context =
      FailedStepContext(
        failedStepIndex = 1,
        failedTool = "inputText",
        error = "step failed",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = "emulator-5554",
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    fakeMcpClient.toolResults["observe"] = """{"elements": []}"""
    fakeAIAgent.response = "done"

    autoMobileAgent.attemptAiRecovery(context, secretValues = listOf(secret))

    val rawClient = fakeAiAgentFactory.recoveryCalls.single().rawMcpClient

    // A successful call must return the RAW, unredacted result unchanged — WaitForTool's local
    // match relies on this.
    fakeMcpClient.toolResults["waitForCheck"] = """{"elements":[{"text":"$secret"}]}"""
    assertEquals(
      """{"elements":[{"text":"$secret"}]}""",
      rawClient.callTool("waitForCheck", emptyMap()),
      "a successful observe must reach WaitForTool's local match completely unredacted",
    )

    // A FAILED call's thrown message must be redacted — this is what WaitForTool logs on every
    // failed poll attempt.
    fakeMcpClient.toolFailures["waitForFailure"] =
      RuntimeException("MCP server error: token $secret leaked in the error body")
    val error = assertThrows<RuntimeException> { rawClient.callTool("waitForFailure", emptyMap()) }
    assertFalse(
      error.message!!.contains(secret),
      "a failed observe's exception message must not leak the secret",
    )
    assertTrue(
      error.message!!.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
  }

  @Test
  fun `attemptAiRecovery redacts raw context fields from the initial prompt for a direct caller`() {
    // A direct caller of the public overload may build a FailedStepContext with RAW (unredacted)
    // planContent/error plus raw secretValues. The entry point must scrub the static context fields
    // itself so the first prompt does not leak — not only the executor path, which pre-redacts
    // (#6094).
    val secret = "SECRET-hunter2-TOKEN"
    val context =
      FailedStepContext(
        failedStepIndex = 1,
        failedTool = "inputText",
        error = "timed out entering $secret",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps:\n  - tool: inputText\n    text: \"$secret\"",
        deviceId = "emulator-5554",
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    fakeMcpClient.toolResults["observe"] = """{"elements": []}"""
    fakeAIAgent.response = "done"

    autoMobileAgent.attemptAiRecovery(context, secretValues = listOf(secret))

    val prompt = fakeAIAgent.prompts.single()
    assertFalse(
      prompt.contains(secret),
      "raw context fields must be redacted from the initial recovery prompt",
    )
    assertTrue(
      prompt.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
  }

  @Test
  fun `attemptAiRecovery normalizes raw secret values a direct caller passes`() {
    // The public overload may be called directly with RAW concrete secrets (not pre-expanded). The
    // entry point must expand them so the JSON-escaped form of a special-character secret in a tool
    // result is still scrubbed (#6094). Here the secret contains a quote, so it appears escaped in
    // the JSON observe result; passing only the raw value would leak it.
    val secret = "pa\"ss-TOKEN"
    val context =
      FailedStepContext(
        failedStepIndex = 1,
        failedTool = "inputText",
        error = "step failed",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = "emulator-5554",
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    // The JSON observe result carries the secret in its escaped form (a `"` becomes `\"`).
    fakeMcpClient.toolResults["observe"] = """{"field":"token pa\"ss-TOKEN"}"""
    fakeAIAgent.response = "done"

    // Pass the RAW concrete secret, not a pre-expanded list.
    autoMobileAgent.attemptAiRecovery(context, secretValues = listOf(secret))

    val observeResult = runBlocking {
      AutoMobileAgent.ObserveTool(fakeAiAgentFactory.recoveryCalls.single().mcpClient)
        .execute(AutoMobileAgent.ObserveTool.Args())
    }
    assertFalse(
      observeResult.contains("""pa\"ss-TOKEN"""),
      "the escaped form of a raw-passed secret must still be scrubbed",
    )
    assertTrue(
      observeResult.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
  }

  @Test
  fun `RedactingMCPClient scrubs the secret from a tool error message fed back to the model`() {
    // A tool failure message can echo the on-screen secret (DefaultMCPClient throws a
    // RuntimeException carrying the MCP server's response body / error), and Koog feeds tool
    // errors back to the model. The redacting wrapper must scrub the throw path too, not just the
    // successful return (issue #6094 — mirrors iOS executeTool's error scrub).
    val secret = "SECRET-hunter2-TOKEN"
    val throwingDelegate =
      object : AutoMobileAgent.MCPClient {
        override fun isConnected() = true

        val connectionUrls = mutableListOf<String>()
        var disconnectCalls = 0

        override fun connect(serverUrl: String) {
          connectionUrls.add(serverUrl)
        }

        override fun disconnect() {
          disconnectCalls++
        }

        override fun callTool(toolName: String, parameters: Map<String, Any>): String =
          throw IllegalStateException(
            "MCP server returned status 500: {\"field\":\"token $secret\"}",
          )

        override fun listAvailableTools() = emptyList<AutoMobileAgent.MCPToolDefinition>()
      }
    val client = RedactingMCPClient(throwingDelegate, SecretRedactor.secretValues(listOf(secret)))

    val error = assertThrows<RuntimeException> { client.callTool("observe", emptyMap()) }

    assertFalse(
      error.message!!.contains(secret),
      "a tool error fed back to the model must not contain the secret",
    )
    assertTrue(
      error.message!!.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
    // The cause is dropped so the raw secret cannot survive in the exception chain.
    assertEquals(null, error.cause)
  }
}
