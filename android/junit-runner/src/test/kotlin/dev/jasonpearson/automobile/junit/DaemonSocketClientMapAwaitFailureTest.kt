package dev.jasonpearson.automobile.junit

import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class DaemonSocketClientMapAwaitFailureTest {

  @Test
  fun `timeout maps to a DaemonUnavailableException`() {
    val mapped = DaemonSocketClient.mapAwaitFailure(TimeoutException(), 1500)
    assertTrue(mapped.message!!.contains("timeout"))
    assertTrue(mapped.message!!.contains("1500"))
  }

  /**
   * A daemon disconnect completes the future with a DaemonUnavailableException, which future.get
   * rethrows wrapped in an ExecutionException. It must be unwrapped so callers that catch
   * DaemonUnavailableException see it (#3598) — pre-fix only TimeoutException was caught.
   */
  @Test
  fun `execution exception wrapping DaemonUnavailableException is unwrapped`() {
    val original = DaemonUnavailableException("read loop died")
    val mapped = DaemonSocketClient.mapAwaitFailure(ExecutionException(original), 1000)
    assertSame(original, mapped) // same instance, not a new opaque wrapper
  }

  @Test
  fun `execution exception with another cause becomes DaemonUnavailableException with that cause`() {
    val cause = IOException("socket closed")
    val mapped = DaemonSocketClient.mapAwaitFailure(ExecutionException(cause), 1000)
    assertSame(cause, mapped.cause)
    assertTrue(mapped.message!!.contains("socket closed"))
  }

  @Test
  fun `interruption maps to a DaemonUnavailableException`() {
    val mapped = DaemonSocketClient.mapAwaitFailure(InterruptedException(), 1000)
    assertEquals("Daemon request interrupted", mapped.message)
  }
}
