package dev.jasonpearson.automobile.desktop.core.mcp

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpResource
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceContent
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.junit.Test

class DaemonMcpResourceClientTest {
  private val fake = FakeAutoMobileClient()
  private val logger = RecordingLogger()
  private val client = DaemonMcpResourceClient(fake, logger)
  private val uri = "automobile:test"

  @Test
  fun `read failure preserves error and logs throwable without stdout`() = runBlocking {
    val cause = IllegalStateException("root cause")
    val failure = RuntimeException("boom", cause)
    fake.throwOnReadResource = failure

    withoutStdout {
      val result = assertIs<ResourceReadResult.Error>(client.readResource(uri))
      assertTrue(result.message.startsWith("Connection error: RuntimeException: boom"))
      assertEquals(
        "Connection error: RuntimeException: boom\n\nCause: root cause\n\nStack: ${failure.stackTrace.take(3).joinToString("\n") { "  at $it" }}",
        result.message,
      )
    }
    val warning = logger.entries.filter { it.level == "warn" }.single()
    assertEquals("[DaemonMcpResourceClient] Exception: RuntimeException: boom", warning.message)
    assertSame(failure, warning.throwable)
    assertFalse(logger.entries.any { it.level == "error" })
  }

  @Test
  fun `read success preserves text and mime type without logging body`() = runBlocking {
    val text = "private resource body"
    fake.setResourceResponse(uri, listOf(McpResourceContent(uri, "text/plain", text)))

    assertEquals(ResourceReadResult.Success(text, "text/plain"), client.readResource(uri))
    assertOnlyDebug()
    assertFalse(logger.entries.any { text in it.message })
    assertTrue(logger.entries.any { "length=${text.length}, mimeType=text/plain" in it.message })
  }

  @Test
  fun `read success defaults null mime type to json`() = runBlocking {
    val text = "another private body"
    fake.setResourceResponse(uri, listOf(McpResourceContent(uri = uri, text = text)))

    assertEquals(ResourceReadResult.Success(text, "application/json"), client.readResource(uri))
    assertOnlyDebug()
    assertFalse(logger.entries.any { text in it.message })
  }

  @Test
  fun `empty content warns once without throwable`() = runBlocking {
    assertEquals(
      ResourceReadResult.Error("Resource response missing content"),
      client.readResource(uri),
    )
    assertMissingContentWarning()
  }

  @Test
  fun `null text warns once without throwable`() = runBlocking {
    fake.setResourceResponse(uri, listOf(McpResourceContent(uri = uri)))

    assertEquals(
      ResourceReadResult.Error("Resource response missing content"),
      client.readResource(uri),
    )
    assertMissingContentWarning()
  }

  @Test
  fun `list failure returns empty list and logs throwable`() = runBlocking {
    val failure = RuntimeException("list boom")
    val throwingClient =
      object : AutoMobileClient by fake {
        override fun listResources(): List<McpResource> = throw failure
      }

    withoutStdout {
      assertEquals(emptyList(), DaemonMcpResourceClient(throwingClient, logger).listResources())
    }
    val warning = logger.entries.filter { it.level == "warn" }.single()
    assertEquals(
      "[DaemonMcpResourceClient] Exception listing resources: list boom",
      warning.message,
    )
    assertSame(failure, warning.throwable)
    assertFalse(logger.entries.any { it.level == "error" })
  }

  @Test
  fun `list success maps all fields including nulls`() = runBlocking {
    fake.listResourcesResult =
      listOf(McpResource(uri, "Test", "Description", "text/plain"), McpResource("other", "Other"))

    assertEquals(
      listOf(
        ResourceInfo(uri, "Test", "Description", "text/plain"),
        ResourceInfo("other", "Other", null, null),
      ),
      client.listResources(),
    )
    assertOnlyDebug()
  }

  @Test
  fun `stdio factory keeps unsupported message without stdout`() {
    withoutStdout {
      val failure =
        assertFailsWith<UnsupportedOperationException> {
          McpResourceClientFactory.create(McpProcess(1, "stdio", McpConnectionType.Stdio))
        }
      assertEquals("Cannot connect to STDIO process externally", failure.message)
    }
  }

  private fun assertOnlyDebug() {
    assertTrue(logger.entries.isNotEmpty())
    assertTrue(logger.entries.all { it.level == "debug" && it.throwable == null })
  }

  private fun assertMissingContentWarning() {
    val warning = logger.entries.filter { it.level == "warn" }.single()
    assertEquals(
      "[DaemonMcpResourceClient] Error: Resource response missing content",
      warning.message,
    )
    assertNull(warning.throwable)
    assertFalse(logger.entries.any { it.level == "error" })
  }

  private inline fun withoutStdout(block: () -> Unit) {
    val original = System.out
    val output = ByteArrayOutputStream()
    PrintStream(output).use { captured ->
      try {
        System.setOut(captured)
        block()
      } finally {
        System.setOut(original)
      }
    }
    assertEquals("", output.toString())
  }
}

private class RecordingLogger : Logger {
  data class Entry(val level: String, val message: String, val throwable: Throwable? = null)

  val entries = mutableListOf<Entry>()

  override fun info(message: String) {
    entries.add(Entry("info", message))
  }

  override fun warn(message: String) {
    entries.add(Entry("warn", message))
  }

  override fun warn(message: String, throwable: Throwable) {
    entries.add(Entry("warn", message, throwable))
  }

  override fun error(message: String) {
    entries.add(Entry("error", message))
  }

  override fun error(message: String, throwable: Throwable) {
    entries.add(Entry("error", message, throwable))
  }

  override fun debug(message: String) {
    entries.add(Entry("debug", message))
  }
}
