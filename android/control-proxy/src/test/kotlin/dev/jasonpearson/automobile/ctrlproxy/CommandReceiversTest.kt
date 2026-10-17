package dev.jasonpearson.automobile.ctrlproxy

import android.content.Intent
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class CommandReceiversTest {
  private val context = RuntimeEnvironment.getApplication()

  private class FakeCommandHost(private val failure: Throwable? = null) : CommandHost {
    val handled = mutableListOf<String?>()
    val failures = mutableListOf<String?>()

    override suspend fun handleCommand(intent: Intent) {
      handled += intent.action
      failure?.let { throw it }
    }

    override fun sendFailure(error: String?) {
      failures += error
    }
  }

  @Test
  fun `a command broadcast is dispatched to the host`() = runTest {
    val host = FakeCommandHost()
    val receiver = CommandReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(context, Intent("dev.test.COMMAND"))

    assertEquals(listOf<String?>("dev.test.COMMAND"), host.handled)
    assertTrue(host.failures.isEmpty())
  }

  @Test
  fun `a null intent is ignored`() = runTest {
    val host = FakeCommandHost()
    val receiver = CommandReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(context, null)

    assertTrue(host.handled.isEmpty())
  }

  @Test
  fun `a command failure becomes a failure result`() = runTest {
    val host = FakeCommandHost(IllegalStateException("boom"))
    val receiver = CommandReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(context, Intent("dev.test.COMMAND"))

    assertEquals(listOf<String?>("boom"), host.failures)
  }

  @Test
  fun `cancellation is never reported as a failure result`() = runTest {
    val host = FakeCommandHost(CancellationException("shutting down"))
    val receiver = CommandReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(context, Intent("dev.test.COMMAND"))

    assertEquals(1, host.handled.size)
    assertTrue(host.failures.isEmpty())
  }

  @Test
  fun `a mock rules answer without a report replies unconfirmed with the request id`() {
    val replies = mutableListOf<SetNetworkMockRulesResult>()

    NetworkMockRulesReplyReceiver("req-1") { replies += it }
      .onReceive(context, Intent("dev.test.REPLY"))

    val reply = replies.single()
    assertEquals("req-1", reply.requestId)
    assertNull(reply.rejectedMockIds)
  }
}
