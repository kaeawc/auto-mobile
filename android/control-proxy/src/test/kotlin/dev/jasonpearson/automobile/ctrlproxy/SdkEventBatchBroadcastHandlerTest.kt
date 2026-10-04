package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SdkEventBatchBroadcastHandlerTest {
  @Test
  fun `ordered accepted batch acknowledges only after enqueue returns`() {
    val result = FakeResultSink(isOrdered = true)
    val fixture =
      Fixture(accept = true, beforeEnqueueReturns = { assertTrue(result.codes.isEmpty()) })

    fixture.handler.handle(batchJson, result)

    assertEquals(listOf(batch), fixture.batches)
    assertEquals(listOf(SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED), result.codes)
    assertEquals(listOf("Received event batch with 1 events"), fixture.log.debugMessages)
    assertTrue(fixture.log.warnings.isEmpty())
  }

  @Test
  fun `ordered full queue rejects after attempting enqueue and keeps warning`() {
    val fixture = Fixture(accept = false)
    val result = FakeResultSink(isOrdered = true)

    fixture.handler.handle(batchJson, result)

    assertEquals(listOf(batch), fixture.batches)
    assertEquals(
      listOf(SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_QUEUE_FULL),
      result.codes,
    )
    assertEquals(listOf(queueFullWarning), fixture.log.warnings)
  }

  @Test
  fun `ordered missing JSON rejects without enqueue`() =
    assertInvalidPayload(null, isOrdered = true)

  @Test
  fun `ordered malformed JSON rejects without enqueue`() =
    assertInvalidPayload("not-json", isOrdered = true)

  @Test
  fun `ordered non-batch event rejects without enqueue`() =
    assertInvalidPayload(SdkEventSerializer.toJson(batch.events.single()), isOrdered = true)

  @Test
  fun `non-ordered accepted batch enqueues without setting result`() {
    val fixture = Fixture(accept = true)
    val result = FakeResultSink(isOrdered = false)

    fixture.handler.handle(batchJson, result)

    assertEquals(listOf(batch), fixture.batches)
    assertTrue(result.codes.isEmpty())
    assertEquals(listOf("Received event batch with 1 events"), fixture.log.debugMessages)
    assertTrue(fixture.log.warnings.isEmpty())
  }

  @Test
  fun `non-ordered full queue attempts enqueue and warns without setting result`() {
    val fixture = Fixture(accept = false)
    val result = FakeResultSink(isOrdered = false)

    fixture.handler.handle(batchJson, result)

    assertEquals(listOf(batch), fixture.batches)
    assertTrue(result.codes.isEmpty())
    assertEquals(listOf(queueFullWarning), fixture.log.warnings)
  }

  @Test
  fun `non-ordered missing JSON returns silently without setting result`() =
    assertInvalidPayload(null, isOrdered = false)

  @Test
  fun `non-ordered malformed JSON returns silently without setting result`() =
    assertInvalidPayload("not-json", isOrdered = false)

  @Test
  fun `non-ordered non-batch event returns silently without setting result`() =
    assertInvalidPayload(SdkEventSerializer.toJson(batch.events.single()), isOrdered = false)

  private fun assertInvalidPayload(json: String?, isOrdered: Boolean) {
    val fixture = Fixture(accept = true)
    val result = FakeResultSink(isOrdered)

    fixture.handler.handle(json, result)

    assertTrue(fixture.batches.isEmpty())
    assertEquals(
      if (isOrdered) listOf(SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD)
      else emptyList<Int>(),
      result.codes,
    )
    assertTrue(fixture.log.debugMessages.isEmpty())
    assertTrue(fixture.log.warnings.isEmpty())
  }

  private class Fixture(accept: Boolean, beforeEnqueueReturns: () -> Unit = {}) {
    val batches = mutableListOf<SdkEventBatch>()
    val log = FakeLogSink()
    val handler =
      SdkEventBatchBroadcastHandler(
        enqueue = { batch ->
          batches.add(batch)
          beforeEnqueueReturns()
          accept
        },
        log = log,
      )
  }

  private class FakeLogSink : SdkEventBatchBroadcastHandler.LogSink {
    val debugMessages = mutableListOf<String>()
    val warnings = mutableListOf<String>()

    override fun debug(message: String) {
      debugMessages.add(message)
    }

    override fun warn(message: String) {
      warnings.add(message)
    }
  }

  private class FakeResultSink(override val isOrdered: Boolean) :
    SdkEventBatchBroadcastHandler.ResultSink {
    val codes = mutableListOf<Int>()

    override fun setResultCode(code: Int) {
      check(isOrdered) { "Non-ordered broadcasts must not set a result" }
      codes.add(code)
    }
  }

  private companion object {
    val batch =
      SdkEventBatch(
        timestamp = 0L,
        events =
          listOf(
            SdkNavigationEvent(
              timestamp = 0L,
              destination = "home",
              source = NavigationSourceType.CUSTOM,
            )
          ),
      )
    val batchJson = SdkEventSerializer.toJson(batch)
    const val queueFullWarning = "Dropping SDK event batch with 1 events because the queue is full"
  }
}
