package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.ObserveResult
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.junit.Test

class RealLayoutDataSourceObserveErrorTest {
  @Test
  fun `observe connection failure returns actionable error`() = runBlocking {
    val client = FakeAutoMobileClient()
    val failure = McpConnectionException("no device")
    client.observeError = failure
    val source = RealLayoutDataSource(clientProvider = { client }, platform = "android")

    val result = assertIs<Result.Error>(source.getObservation())

    assertTrue(result.message.orEmpty().contains("MCP server not available"))
    assertSame(failure, result.exception)
    assertEquals(listOf("observe"), client.calls)
  }

  @Test
  fun `unexpected observe failure returns load error`() = runBlocking {
    val client = FakeAutoMobileClient()
    val failure = IllegalStateException("boom")
    client.observeError = failure
    val source = RealLayoutDataSource(clientProvider = { client }, platform = "android")

    val result = assertIs<Result.Error>(source.getObservation())

    assertTrue(result.message.orEmpty().contains("Failed to load observation"))
    assertSame(failure, result.exception)
  }

  @Test
  fun `view hierarchy preserves observe failure`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.observeError = McpConnectionException("no device")
    val source = RealLayoutDataSource(clientProvider = { client }, platform = "android")

    val result = assertIs<Result.Error>(source.getViewHierarchy())

    assertTrue(result.message.orEmpty().contains("MCP server not available"))
  }

  @Test
  fun `successful observation preserves rotation`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.observeResult = ObserveResult(updatedAt = 123L, rotation = 1)
    val source = RealLayoutDataSource(clientProvider = { client }, platform = "android")

    val result = assertIs<Result.Success<ObservationData>>(source.getObservation())

    assertEquals(1, result.data.rotation)
  }

  @Test
  fun `observe cancellation propagates unchanged`() = runBlocking {
    val client = FakeAutoMobileClient()
    val cancellation = CancellationException("cancelled")
    client.observeError = cancellation
    val source = RealLayoutDataSource(clientProvider = { client }, platform = "android")

    val error = assertFailsWith<CancellationException> { source.getObservation() }

    assertSame(cancellation, error)
  }
}
