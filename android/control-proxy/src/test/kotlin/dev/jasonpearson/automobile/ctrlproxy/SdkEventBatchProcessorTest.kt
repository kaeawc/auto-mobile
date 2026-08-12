package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SdkEventBatchProcessorTest {

  @Test
  fun `holds a startup batch until WebSocket processing begins`() = runTest {
    val startupBroadcastFinished = CompletableDeferred<Unit>()
    val broadcasts = mutableListOf<String>()
    val processor =
      SdkEventBatchProcessor(
        scope = backgroundScope,
        navigationEventAccumulator = NavigationEventAccumulator(),
        broadcastNavigationEvent = { event ->
          broadcasts.add(event.destination)
          startupBroadcastFinished.complete(Unit)
        },
        broadcastSdkEvent = { error("Unexpected SDK event: $it") },
      )

    assertTrue(processor.enqueue(batch("startup")))
    advanceUntilIdle()

    assertTrue("startup batch must wait for WebSocket readiness", broadcasts.isEmpty())
    processor.start()
    startupBroadcastFinished.await()

    assertEquals(listOf("startup"), broadcasts)
  }

  @Test
  fun `processes queued batches in broadcast arrival order while a navigation broadcast suspends`() =
    runTest {
      val firstBroadcastStarted = CompletableDeferred<Unit>()
      val allowFirstBroadcastToFinish = CompletableDeferred<Unit>()
      val thirdBroadcastFinished = CompletableDeferred<Unit>()
      val broadcasts = mutableListOf<String>()
      val processor =
        SdkEventBatchProcessor(
          scope = backgroundScope,
          navigationEventAccumulator = NavigationEventAccumulator(),
          broadcastNavigationEvent = { event ->
            broadcasts.add(event.destination)
            if (event.destination == "first") {
              firstBroadcastStarted.complete(Unit)
              allowFirstBroadcastToFinish.await()
            } else if (event.destination == "third") {
              thirdBroadcastFinished.complete(Unit)
            }
          },
          broadcastSdkEvent = { error("Unexpected SDK event: $it") },
        )

      processor.start()
      processor.enqueue(batch("first", "second"))
      firstBroadcastStarted.await()
      processor.enqueue(batch("third"))

      assertEquals(listOf("first"), broadcasts)

      allowFirstBroadcastToFinish.complete(Unit)
      thirdBroadcastFinished.await()

      assertEquals(listOf("first", "second", "third"), broadcasts)
    }

  @Test
  fun `rejects batches when the bounded queue is full while a navigation broadcast suspends`() =
    runTest {
      val firstBroadcastStarted = CompletableDeferred<Unit>()
      val allowFirstBroadcastToFinish = CompletableDeferred<Unit>()
      val finalBroadcastFinished = CompletableDeferred<Unit>()
      val broadcasts = mutableListOf<String>()
      val processor =
        SdkEventBatchProcessor(
          scope = backgroundScope,
          navigationEventAccumulator = NavigationEventAccumulator(),
          broadcastNavigationEvent = { event ->
            broadcasts.add(event.destination)
            if (event.destination == "first") {
              firstBroadcastStarted.complete(Unit)
              allowFirstBroadcastToFinish.await()
            } else if (event.destination == "queued-64") {
              finalBroadcastFinished.complete(Unit)
            }
          },
          broadcastSdkEvent = { error("Unexpected SDK event: $it") },
        )

      processor.start()
      assertTrue(processor.enqueue(batch("first")))
      firstBroadcastStarted.await()

      val queuedDestinations = (1..64).map { "queued-$it" }
      for (destination in queuedDestinations) {
        assertTrue(processor.enqueue(batch(destination)))
      }
      assertFalse(processor.enqueue(batch("dropped-when-full")))

      allowFirstBroadcastToFinish.complete(Unit)
      finalBroadcastFinished.await()

      assertEquals(listOf("first") + queuedDestinations, broadcasts)
    }

  @Test
  fun `processes legacy navigation before a later batch through the same actor`() = runTest {
    val legacyBroadcastStarted = CompletableDeferred<Unit>()
    val allowLegacyBroadcastToFinish = CompletableDeferred<Unit>()
    val batchBroadcastFinished = CompletableDeferred<Unit>()
    val broadcasts = mutableListOf<TimestampedNavigationEvent>()
    val processor =
      SdkEventBatchProcessor(
        scope = backgroundScope,
        navigationEventAccumulator = NavigationEventAccumulator(),
        broadcastNavigationEvent = { event ->
          broadcasts.add(event)
          if (event.destination == "legacy") {
            legacyBroadcastStarted.complete(Unit)
            allowLegacyBroadcastToFinish.await()
          } else if (event.destination == "batched") {
            batchBroadcastFinished.complete(Unit)
          }
        },
        broadcastSdkEvent = { error("Unexpected SDK event: $it") },
      )

    processor.start()
    assertTrue(
      processor.enqueueNavigationEvent(
        destination = "legacy",
        source = "legacy",
        arguments = emptyMap(),
        metadata = emptyMap(),
        applicationId = null,
        timestamp = 0L,
      )
    )
    legacyBroadcastStarted.await()
    assertTrue(processor.enqueue(batch("batched")))

    allowLegacyBroadcastToFinish.complete(Unit)
    batchBroadcastFinished.await()

    assertEquals(listOf("legacy", "batched"), broadcasts.map { it.destination })
    assertEquals(listOf(0L, 1L), broadcasts.map { it.sequenceNumber })
  }

  private fun batch(vararg destinations: String): SdkEventBatch =
    SdkEventBatch(
      timestamp = 0L,
      events =
        destinations.mapIndexed { index, destination ->
          SdkNavigationEvent(
            timestamp = index.toLong(),
            destination = destination,
            source = NavigationSourceType.CUSTOM,
          )
        },
    )
}
