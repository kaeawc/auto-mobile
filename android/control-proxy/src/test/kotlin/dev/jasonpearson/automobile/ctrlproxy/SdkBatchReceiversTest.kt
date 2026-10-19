package dev.jasonpearson.automobile.ctrlproxy

import android.content.Intent
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.anr.AutoMobileAnr
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SdkBatchReceiversTest {
  private val context = RuntimeEnvironment.getApplication()

  @Test
  fun `an event batch broadcast forwards its json and batch id to the handler`() {
    val handler = mockk<SdkEventBatchBroadcastHandler>(relaxed = true)
    val sink = slot<SdkEventBatchBroadcastHandler.ResultSink>()
    every { handler.handle("{}", capture(sink), "batch-1") } returns Unit

    EventBatchReceiver(handler)
      .onReceive(
        context,
        Intent(SdkEventSerializer.ACTION_SDK_EVENT_BATCH)
          .putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, "{}")
          .putExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID, "batch-1"),
      )

    verify(exactly = 1) { handler.handle("{}", any(), "batch-1") }
    assertFalse(sink.captured.isOrdered)
  }

  @Test
  fun `other actions and null intents never reach the batch handler`() {
    val handler = mockk<SdkEventBatchBroadcastHandler>(relaxed = true)
    val receiver = EventBatchReceiver(handler)

    receiver.onReceive(context, Intent("other.action"))
    receiver.onReceive(context, null)

    verify(exactly = 0) { handler.handle(any(), any(), any()) }
  }

  @Test
  fun `batch handler failures propagate outside the parsing boundary`() {
    val handler = mockk<SdkEventBatchBroadcastHandler>()
    val failure = IllegalStateException("boom")
    every { handler.handle(any(), any(), any()) } throws failure

    val thrown =
      assertThrows(IllegalStateException::class.java) {
        EventBatchReceiver(handler)
          .onReceive(context, Intent(SdkEventSerializer.ACTION_SDK_EVENT_BATCH))
      }
    assertSame(failure, thrown)
  }

  @Test
  fun `an anr broadcast forwards its json and delivery id to the handler`() {
    val handler = mockk<SdkAnrBroadcastHandler>(relaxed = true)

    AnrReceiver(handler)
      .onReceive(
        context,
        Intent(AutoMobileAnr.ACTION_ANR)
          .putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, "{\"a\":1}")
          .putExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID, "d-1"),
      )

    verify(exactly = 1) { handler.handle("{\"a\":1}", any(), "d-1") }
  }

  @Test
  fun `anr handler failures propagate and other actions are ignored`() {
    val handler = mockk<SdkAnrBroadcastHandler>()
    val failure = IllegalStateException("boom")
    every { handler.handle(any(), any(), any()) } throws failure
    val receiver = AnrReceiver(handler)

    val thrown =
      assertThrows(IllegalStateException::class.java) {
        receiver.onReceive(context, Intent(AutoMobileAnr.ACTION_ANR))
      }
    assertSame(failure, thrown)
    receiver.onReceive(context, Intent("other.action"))
  }
}
