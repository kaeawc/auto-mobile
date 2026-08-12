package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class SdkEventBatchProcessorTest {

  @Test
  fun `does not interleave concurrent batches while a navigation broadcast suspends`() = runTest {
    val firstBroadcastStarted = CompletableDeferred<Unit>()
    val allowFirstBroadcastToFinish = CompletableDeferred<Unit>()
    val broadcasts = mutableListOf<String>()
    val processor =
      SdkEventBatchProcessor(
        navigationEventAccumulator = NavigationEventAccumulator(),
        broadcastNavigationEvent = { event ->
          broadcasts.add(event.destination)
          if (event.destination == "first") {
            firstBroadcastStarted.complete(Unit)
            allowFirstBroadcastToFinish.await()
          }
        },
        broadcastSdkEvent = { error("Unexpected SDK event: $it") },
      )

    val firstBatch = async { processor.process(batch("first", "second")) }
    firstBroadcastStarted.await()
    val secondBatch = async { processor.process(batch("third")) }
    advanceUntilIdle()

    assertEquals(listOf("first"), broadcasts)

    allowFirstBroadcastToFinish.complete(Unit)
    advanceUntilIdle()
    firstBatch.await()
    secondBatch.await()

    assertEquals(listOf("first", "second", "third"), broadcasts)
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
