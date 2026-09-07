package dev.jasonpearson.automobile.junit

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression tests for issue #6145: a composite [AutoMobileAgent.WaitForTool] must evaluate its
 * local "did the element appear" check against the UNREDACTED observe result.
 *
 * Recovery redaction (#6094 / [RedactingMCPClient]) scrubs every intermediate tool/observe result
 * before it reaches the model. [AutoMobileAgent.WaitForTool] never forwards that observe text to
 * the model itself — its own result is a synthesized "found"/"timeout" string — so redacting the
 * copy it searches locally buys no security and only produces a false timeout whenever the wait
 * target is a substring of an on-screen secret value.
 */
class WaitForToolRedactionTest {

  private class FixedResultClient(private val result: String) : AutoMobileAgent.MCPClient {
    override fun isConnected() = true

    override fun connect(serverUrl: String) {}

    override fun disconnect() {}

    override fun callTool(toolName: String, parameters: Map<String, Any>): String = result

    override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> = emptyList()
  }

  /** Fails any call — proves WaitForTool never queries the redacting client. */
  private class FailingClient : AutoMobileAgent.MCPClient {
    override fun isConnected() = true

    override fun connect(serverUrl: String) {}

    override fun disconnect() {}

    override fun callTool(toolName: String, parameters: Map<String, Any>): String =
      throw AssertionError(
        "WaitForTool must query the raw client for its internal condition check, not the " +
          "redacting one"
      )

    override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> = emptyList()
  }

  @Test
  fun `WaitForTool matches a wait target that is only a substring of an on-screen secret`() =
    runBlocking {
      // "OK" only ever appears as a substring of the declared secret, so a WaitForTool that
      // searched the REDACTED observe result would never match and would time out (#6145).
      val secret = "TOKEN-OK-123"
      val rawObserveResult = """{"elements":[{"text":"$secret"}]}"""
      val redactionValues = SecretRedactor.secretValues(listOf(secret))

      // Sanity: the redacted copy really does lose the substring, proving the bug would
      // reproduce if WaitForTool searched this instead of the raw text.
      val redacted = SecretRedactor.redact(rawObserveResult, redactionValues)
      assertFalse("test setup: redaction must remove the substring", redacted.contains("OK"))

      val waitForTool = AutoMobileAgent.WaitForTool(FixedResultClient(rawObserveResult))

      val result =
        waitForTool.execute(AutoMobileAgent.WaitForTool.Args(text = "OK", timeout = 2000))

      assertEquals("Element with text 'OK' found", result)
    }

  @Test
  fun `AutoMobileMCPToolFactory wires WaitForTool to the raw client, not the redacting one`() =
    runBlocking {
      // Structural check on the #6145 fix itself: the factory must hand WaitForTool the raw
      // client while every pass-through tool keeps using the (possibly redacting) primary one.
      val secret = "TOKEN-OK-123"
      val rawClient = FixedResultClient("""{"elements":[{"text":"$secret"}]}""")
      val redactingClient = FailingClient()
      val factory = AutoMobileAgent.AutoMobileMCPToolFactory(redactingClient, rawClient)

      val waitForTool =
        factory.createAllTools().filterIsInstance<AutoMobileAgent.WaitForTool>().single()

      // Would throw from FailingClient if WaitForTool queried the wrong (redacting) client.
      val result =
        waitForTool.execute(AutoMobileAgent.WaitForTool.Args(text = "OK", timeout = 2000))
      assertEquals("Element with text 'OK' found", result)
    }

  @Test
  fun `secrets stay redacted in the pass-through observe result the model sees`() = runBlocking {
    // The other half of #6145: fixing WaitForTool's local check must not reopen the #6094 leak —
    // ObserveTool (and the rest of the pass-through tools) still go through the redacting client.
    val secret = "TOKEN-OK-123"
    val rawClient = FixedResultClient("""{"elements":[{"text":"$secret"}]}""")
    val redactionValues = SecretRedactor.secretValues(listOf(secret))
    val redactingClient = RedactingMCPClient(rawClient, redactionValues)

    val observeResult =
      AutoMobileAgent.ObserveTool(redactingClient).execute(AutoMobileAgent.ObserveTool.Args())

    assertFalse(observeResult.contains(secret))
    assertTrue(observeResult.contains(SecretRedactor.PLACEHOLDER))
  }

  /**
   * Throws with a secret echoed in the exception message — mimics DefaultMCPClient's failure mode.
   */
  private class ThrowingClient(private val message: String) : AutoMobileAgent.MCPClient {
    override fun isConnected() = true

    override fun connect(serverUrl: String) {}

    override fun disconnect() {}

    override fun callTool(toolName: String, parameters: Map<String, Any>): String =
      throw RuntimeException(message)

    override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> = emptyList()
  }

  @Test
  fun `FailureRedactingMCPClient returns a successful result completely unredacted`() =
    runBlocking {
      // WaitForTool's local match must see the RAW text, or a wait target that is only a substring
      // of
      // an on-screen secret would falsely time out (#6145).
      val secret = "TOKEN-OK-123"
      val rawResult = """{"elements":[{"text":"$secret"}]}"""
      val client =
        FailureRedactingMCPClient(
          FixedResultClient(rawResult),
          SecretRedactor.secretValues(listOf(secret)),
        )

      assertEquals(rawResult, client.callTool("observe", emptyMap()))
    }

  @Test
  fun `FailureRedactingMCPClient redacts a thrown exception's message`() {
    // #6145 follow-up: a FAILED observe call bypasses the "WaitForTool never leaks observe text"
    // argument — DefaultMCPClient throws with the server's response body / error in the message,
    // and WaitForTool logs it on every failed poll attempt.
    val secret = "TOKEN-OK-123"
    val client =
      FailureRedactingMCPClient(
        ThrowingClient("MCP server error: token $secret leaked in the error body"),
        SecretRedactor.secretValues(listOf(secret)),
      )

    val error =
      assertThrows(RuntimeException::class.java) { client.callTool("observe", emptyMap()) }

    assertFalse("the thrown message must not contain the secret", error.message!!.contains(secret))
    assertTrue(
      "the secret must be replaced by the placeholder",
      error.message!!.contains(SecretRedactor.PLACEHOLDER),
    )
    assertEquals(
      "the cause must be dropped so the raw text cannot survive",
      null,
      error.cause,
    )
  }

  @Test
  fun `WaitForTool wrapped in FailureRedactingMCPClient still matches an unredacted substring`() =
    runBlocking {
      // End-to-end: WaitForTool wired to the failure-redacting wrapper must behave identically to
      // the plain raw client on the success path this suite already covers above.
      val secret = "TOKEN-OK-123"
      val rawObserveResult = """{"elements":[{"text":"$secret"}]}"""
      val client =
        FailureRedactingMCPClient(
          FixedResultClient(rawObserveResult),
          SecretRedactor.secretValues(listOf(secret)),
        )

      val result =
        AutoMobileAgent.WaitForTool(client)
          .execute(AutoMobileAgent.WaitForTool.Args(text = "OK", timeout = 2000))

      assertEquals("Element with text 'OK' found", result)
    }
}
