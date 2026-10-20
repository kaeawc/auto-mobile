package dev.jasonpearson.automobile.junit

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class WaitForToolBackoffTest {

  private class ThrowingClient(val calls: AtomicInteger) : AutoMobileAgent.MCPClient {
    override fun isConnected(): Boolean = true

    val connectionUrls = mutableListOf<String>()
    var disconnectCalls = 0

    override fun connect(serverUrl: String) {
      connectionUrls.add(serverUrl)
    }

    override fun disconnect() {
      disconnectCalls++
    }

    override fun callTool(toolName: String, parameters: Map<String, Any>): String {
      calls.incrementAndGet()
      throw IllegalStateException("observe failed")
    }

    override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> = emptyList()
  }

  private class FakeTimer : AutoMobileAgent.TimeProvider {
    private var nowMs = 0L

    override fun currentTimeMillis() = nowMs

    fun advance(delayMs: Long) {
      nowMs += delayMs
    }
  }

  /**
   * When observe throws, the loop must still pace between attempts. Pre-fix the Thread.sleep sat
   * inside the try above the throw, so a throwing observe skipped it and the loop busy-spun the
   * daemon for the whole timeout window (#3606).
   */
  @Test
  fun `throwing observe does not busy-spin the daemon`() = runBlocking {
    val calls = AtomicInteger(0)
    val timer = FakeTimer()
    val tool = AutoMobileAgent.WaitForTool(ThrowingClient(calls), timer, timer::advance)

    val start = timer.currentTimeMillis()
    try {
      tool.execute(AutoMobileAgent.WaitForTool.Args(text = "hello", timeout = 1100))
      fail("expected a timeout")
    } catch (e: RuntimeException) {
      assertTrue(e.message!!.contains("Timeout"))
    }
    val elapsed = timer.currentTimeMillis() - start

    // With ~500ms pacing over an ~1100ms window this is a handful of attempts; a
    // busy-spin would be thousands.
    assertTrue("busy-spun: ${calls.get()} calls in ${elapsed}ms", calls.get() in 1..8)
  }
}
