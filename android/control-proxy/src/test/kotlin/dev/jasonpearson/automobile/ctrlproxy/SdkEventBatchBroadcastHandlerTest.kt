package dev.jasonpearson.automobile.ctrlproxy

import android.content.Intent
import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

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

  @Test
  fun `duplicate id acknowledges both deliveries but enqueues once`() {
    val fixture = Fixture(accept = true)
    val result = FakeResultSink(isOrdered = true)
    repeat(2) { fixture.handler.handle(batchJson, result, batchId = "same") }
    assertEquals(listOf(batch), fixture.batches)
    assertEquals(List(2) { SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED }, result.codes)
  }

  @Test
  fun `ids are bounded and oldest accepted id is evicted without refreshing repeats`() {
    val fixture = Fixture(accept = true, recentBatchCapacity = 2)
    val result = FakeResultSink(isOrdered = true)
    for (id in listOf("oldest", "second", "oldest", "third", "oldest")) {
      fixture.handler.handle(batchJson, result, batchId = id)
    }
    assertEquals(List(4) { batch }, fixture.batches)
    assertEquals(List(5) { SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED }, result.codes)
  }

  @Test
  fun `traffic from another sender evicts the oldest accepted id device wide`() {
    val fixture = Fixture(accept = true, recentBatchCapacity = 2)
    val result = FakeResultSink(isOrdered = true)
    val first = batch.copy(applicationId = "com.first.app")
    val second = batch.copy(applicationId = "com.second.app")
    val firstJson = SdkEventSerializer.toJson(first)
    val secondJson = SdkEventSerializer.toJson(second)
    fixture.handler.handle(firstJson, result, batchId = "first-1")
    fixture.handler.handle(secondJson, result, batchId = "second-1")
    fixture.handler.handle(firstJson, result, batchId = "first-1")
    fixture.handler.handle(secondJson, result, batchId = "second-2")
    fixture.handler.handle(firstJson, result, batchId = "first-1")
    assertEquals(listOf(first, second, second, first), fixture.batches)
    assertEquals(List(5) { SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED }, result.codes)
  }

  @Test
  fun `missing id always enqueues`() {
    val fixture = Fixture(accept = true)
    val result = FakeResultSink(isOrdered = true)
    repeat(2) { fixture.handler.handle(batchJson, result) }
    assertEquals(List(2) { batch }, fixture.batches)
    assertEquals(List(2) { SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED }, result.codes)
  }

  @Test
  fun `queue rejection does not remember id`() {
    var accepted = false
    var attempts = 0
    val handler =
      SdkEventBatchBroadcastHandler(
        {
          attempts++
          accepted
        },
        FakeLogSink(),
      )
    val result = FakeResultSink(isOrdered = true)
    handler.handle(batchJson, result, batchId = "retry")
    accepted = true
    repeat(2) { handler.handle(batchJson, result, batchId = "retry") }
    assertEquals(2, attempts)
    assertEquals(listOf(1001, 1000, 1000), result.codes)
  }

  @Test
  fun `invalid payload never records id even if previously accepted`() {
    val fixture = Fixture(accept = true)
    val result = FakeResultSink(isOrdered = true)
    fixture.handler.handle("not-json", result, batchId = "same")
    fixture.handler.handle(batchJson, result, batchId = "same")
    fixture.handler.handle("not-json", result, batchId = "same")
    fixture.handler.handle(batchJson, result, batchId = "same")
    assertEquals(listOf(batch), fixture.batches)
    assertEquals(listOf(1002, 1000, 1002, 1000), result.codes)
  }

  @Test
  fun `overlapping deliveries of one id enqueue exactly once`() {
    val workers = 4
    val ready = CountDownLatch(workers)
    val start = CountDownLatch(1)
    val parsed = CountDownLatch(workers)
    val enteredEnqueue = CountDownLatch(1)
    val releaseEnqueue = CountDownLatch(1)
    val attempts = AtomicInteger()
    val handler =
      SdkEventBatchBroadcastHandler(
        enqueue = {
          attempts.incrementAndGet()
          enteredEnqueue.countDown()
          assertTrue(releaseEnqueue.await(1, TimeUnit.SECONDS))
          true
        },
        log =
          object : SdkEventBatchBroadcastHandler.LogSink {
            override fun debug(message: String) {
              parsed.countDown()
              assertTrue(parsed.await(1, TimeUnit.SECONDS))
            }

            override fun warn(message: String) = error(message)
          },
      )
    val executor = Executors.newFixedThreadPool(workers)
    try {
      val deliveries =
        List(workers) {
          executor.submit<List<Int>> {
            ready.countDown()
            assertTrue(start.await(1, TimeUnit.SECONDS))
            val result = FakeResultSink(isOrdered = true)
            handler.handle(batchJson, result, batchId = "same")
            result.codes
          }
        }
      assertTrue(ready.await(1, TimeUnit.SECONDS))
      start.countDown()
      assertTrue(enteredEnqueue.await(1, TimeUnit.SECONDS))
      releaseEnqueue.countDown()
      deliveries.forEach { assertEquals(listOf(1000), it.get(1, TimeUnit.SECONDS)) }
      assertEquals(1, attempts.get())
    } finally {
      start.countDown()
      releaseEnqueue.countDown()
      executor.shutdownNow()
    }
  }

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

  private class Fixture(
    accept: Boolean,
    beforeEnqueueReturns: () -> Unit = {},
    recentBatchCapacity: Int = 256,
  ) {
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
        recentBatchCapacity = recentBatchCapacity,
      )
  }

  private class FakeLogSink : SdkEventBatchBroadcastHandler.LogSink {
    val debugMessages: MutableList<String> = Collections.synchronizedList(mutableListOf<String>())
    val warnings: MutableList<String> = Collections.synchronizedList(mutableListOf<String>())

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

/** Intent extra type checking is an Android boundary; keep the other handler tests plain JVM. */
@RunWith(RobolectricTestRunner::class)
class SdkEventBatchBroadcastHandlerExtraTest {
  @Test
  fun `non string batch id extra is treated as no id and always enqueues`() {
    val batches = mutableListOf<SdkEventBatch>()
    val handler =
      SdkEventBatchBroadcastHandler(
        enqueue = {
          batches.add(it)
          true
        },
        log =
          object : SdkEventBatchBroadcastHandler.LogSink {
            override fun debug(message: String) {}

            override fun warn(message: String) = error(message)
          },
      )
    val codes = mutableListOf<Int>()
    val result =
      object : SdkEventBatchBroadcastHandler.ResultSink {
        override val isOrdered = true

        override fun setResultCode(code: Int) {
          codes.add(code)
        }
      }
    val batch = SdkEventBatch(timestamp = 0L, events = emptyList())
    val intent =
      Intent().apply {
        putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, SdkEventSerializer.toJson(batch))
        putExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID, 42)
      }
    repeat(2) {
      val id = intent.getStringExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID)
      assertEquals(null, id)
      handler.handle(intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON), result, id)
    }
    assertEquals(List(2) { batch }, batches)
    assertEquals(List(2) { SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED }, codes)
  }
}
