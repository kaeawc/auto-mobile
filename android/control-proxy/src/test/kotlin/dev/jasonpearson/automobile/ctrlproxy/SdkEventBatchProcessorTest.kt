package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SdkEventBatchProcessorTest {

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

      processor.enqueue(batch("first", "second"))
      firstBroadcastStarted.await()
      processor.enqueue(batch("third"))

      assertEquals(listOf("first"), broadcasts)

      allowFirstBroadcastToFinish.complete(Unit)
      thirdBroadcastFinished.await()

      assertEquals(listOf("first", "second", "third"), broadcasts)
    }

  @Test
  fun `drops batches beyond bounded queue capacity while a navigation broadcast suspends`() =
    runTest {
      val firstBroadcastStarted = CompletableDeferred<Unit>()
      val allowFirstBroadcastToFinish = CompletableDeferred<Unit>()
      val processor =
        SdkEventBatchProcessor(
          scope = backgroundScope,
          navigationEventAccumulator = NavigationEventAccumulator(),
          broadcastNavigationEvent = { event ->
            if (event.destination == "first") {
              firstBroadcastStarted.complete(Unit)
              allowFirstBroadcastToFinish.await()
            }
          },
          broadcastSdkEvent = { error("Unexpected SDK event: $it") },
          queueCapacity = 1,
        )

      assertTrue(processor.enqueue(batch("first")))
      firstBroadcastStarted.await()

      assertTrue(processor.enqueue(batch("second")))
      assertFalse(processor.enqueue(batch("third")))
      assertEquals(1L, processor.droppedBatchCount)

      allowFirstBroadcastToFinish.complete(Unit)
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
