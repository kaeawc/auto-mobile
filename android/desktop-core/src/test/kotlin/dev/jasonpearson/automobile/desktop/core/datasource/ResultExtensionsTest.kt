package dev.jasonpearson.automobile.desktop.core.datasource

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ResultExtensionsTest {

  @Test
  fun `asResult emits Loading then Success for normal flow`() = runBlocking {
    val results = flowOf("hello", "world").asResult().toList()

    assertEquals(3, results.size)
    assertTrue(results[0] is Result.Loading)
    assertEquals("hello", (results[1] as Result.Success).data)
    assertEquals("world", (results[2] as Result.Success).data)
  }

  @Test
  fun `asResult emits Loading then Error when flow throws`() = runBlocking {
    val error = RuntimeException("boom")
    val results = flow<String> { throw error }.asResult().toList()

    assertEquals(2, results.size)
    assertTrue(results[0] is Result.Loading)
    val errorResult = results[1] as Result.Error
    assertEquals(error, errorResult.exception)
    assertEquals("boom", errorResult.message)
  }

  @Test
  fun `asResult emits Loading then Success then Error when flow throws after emit`() = runBlocking {
    val error = IllegalStateException("fail")
    val results = flow {
      emit(42)
      throw error
    }
      .asResult()
      .toList()

    assertEquals(3, results.size)
    assertTrue(results[0] is Result.Loading)
    assertEquals(42, (results[1] as Result.Success).data)
    val errorResult = results[2] as Result.Error
    assertEquals(error, errorResult.exception)
  }

  @Test
  fun `asResult emits only Loading for empty flow`() = runBlocking {
    val results = flow<String> {}.asResult().toList()

    assertEquals(1, results.size)
    assertTrue(results[0] is Result.Loading)
  }

  @Test
  fun `asResult propagates CancellationException instead of catching it`() = runBlocking {
    val cancellation = CancellationException("cancelled")
    try {
      flow<String> { throw cancellation }.asResult().toList()
      fail("Expected CancellationException to be thrown")
    } catch (e: CancellationException) {
      assertEquals("cancelled", e.message)
    }
  }
}
