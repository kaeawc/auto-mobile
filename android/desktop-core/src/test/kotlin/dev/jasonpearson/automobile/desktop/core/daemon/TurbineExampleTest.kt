package dev.jasonpearson.automobile.desktop.core.daemon

import app.cash.turbine.test
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class TurbineExampleTest {

  @Test
  fun `StateFlow emits initial value`() = runBlocking {
    val stateFlow = MutableStateFlow("initial")

    stateFlow.test {
      assertEquals("initial", awaitItem())
      cancelAndConsumeRemainingEvents()
    }
  }

  @Test
  fun `StateFlow emits updates`() = runBlocking {
    val stateFlow = MutableStateFlow(0)

    stateFlow.test {
      assertEquals(0, awaitItem())

      stateFlow.value = 1
      assertEquals(1, awaitItem())

      stateFlow.value = 2
      assertEquals(2, awaitItem())

      cancelAndConsumeRemainingEvents()
    }
  }

  @Test
  fun `SharedFlow emits values to test`() = runBlocking {
    val sharedFlow = MutableSharedFlow<String>()

    sharedFlow.test {
      sharedFlow.emit("hello")
      assertEquals("hello", awaitItem())

      sharedFlow.emit("world")
      assertEquals("world", awaitItem())

      cancelAndConsumeRemainingEvents()
    }
  }

  @Test
  fun `StateFlow replays latest value on new collection`() = runBlocking {
    val stateFlow = MutableStateFlow("a")
    stateFlow.value = "b"
    stateFlow.value = "c"

    // A new collector sees only the latest value
    stateFlow.test {
      assertEquals("c", awaitItem())
      cancelAndConsumeRemainingEvents()
    }
  }
}
