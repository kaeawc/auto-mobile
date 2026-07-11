package dev.jasonpearson.automobile.junit

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class WaitForToolBackoffTest {

  private class ThrowingClient(val calls: AtomicInteger) : AutoMobileAgent.MCPClient {
    override fun isConnected(): Boolean = true

    override fun connect(serverUrl: String) {}

    override fun disconnect() {}

    override fun callTool(toolName: String, parameters: Map<String, Any>): String {
      calls.incrementAndGet()
      throw RuntimeException("observe failed")
    }

    override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> = emptyList()
  }

  /**
   * When observe throws, the loop must still pace between attempts. Pre-fix the Thread.sleep sat
   * inside the try above the throw, so a throwing observe skipped it and the loop busy-spun the
   * daemon for the whole timeout window (#3606).
   */
  @Test
  fun `throwing observe does not busy-spin the daemon`() = runBlocking {
    val calls = AtomicInteger(0)
    val tool = AutoMobileAgent.WaitForTool(ThrowingClient(calls))

    val start = System.currentTimeMillis()
    try {
      tool.execute(AutoMobileAgent.WaitForTool.Args(text = "hello", timeout = 1100))
      fail("expected a timeout")
    } catch (e: RuntimeException) {
      assertTrue(e.message!!.contains("Timeout"))
    }
    val elapsed = System.currentTimeMillis() - start

    // With ~500ms pacing over an ~1100ms window this is a handful of attempts; a
    // busy-spin would be thousands.
    assertTrue("busy-spun: ${calls.get()} calls in ${elapsed}ms", calls.get() in 1..8)
  }
}
