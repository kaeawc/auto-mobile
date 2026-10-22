package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpRequest
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test

class SettingsPrototypeHttpClientTest {
  private val settings = FakeSettingsStore()
  private val transport = SuspendedHttpClient()
  private val client = SettingsPrototypeHttpClient(settings) { transport }

  @Test
  fun switchOffCancelsInFlightCallAndReturnsBlockedFailure() = runTest {
    settings.setAllowNetwork(true)
    val response = async { client.execute(REQUEST) }
    runCurrent()
    assertEquals(1, transport.calls)
    settings.setAllowNetwork(false)
    runCurrent()
    try {
      assertTrue(
        "Caller must finish without waiting for a transport response",
        response.isCompleted,
      )
      assertTrue(transport.cancelled)
      assertBlocked(response.await())
    } finally {
      transport.result.complete(transport.received)
    }
  }

  @Test
  fun transportErrorAfterSwitchOffIsBlockedNotRethrown() = runTest {
    transport.ignoreCancellation = true
    settings.setAllowNetwork(true)
    val response = async { client.execute(REQUEST) }
    runCurrent()
    settings.setAllowNetwork(false)
    transport.result.completeExceptionally(java.io.IOException("Canceled host.example"))
    assertBlocked(response.await())
  }

  @Test
  fun requestStartedWhileOffStaysDeniedAfterEnable() = runTest {
    val response = async { client.execute(REQUEST) }
    runCurrent()
    settings.setAllowNetwork(true)
    assertBlocked(response.await())
    assertEquals(0, transport.calls)
  }

  @Test
  fun responseArrivingAfterSwitchOffIsDroppedEvenIfTransportIgnoresCancellation() = runTest {
    transport.ignoreCancellation = true
    settings.setAllowNetwork(true)
    val response = async { client.execute(REQUEST) }
    runCurrent()
    settings.setAllowNetwork(false)
    transport.result.complete(transport.received)
    assertBlocked(response.await())
  }

  @Test
  fun offThenOnBeforeCollectorsRunDoesNotResurrectOldRequest() = runTest {
    transport.ignoreCancellation = true
    settings.setAllowNetwork(true)
    val response = async { client.execute(REQUEST) }
    runCurrent()
    settings.setAllowNetwork(false)
    settings.setAllowNetwork(true)
    transport.result.complete(transport.received)
    assertBlocked(response.await())
    assertTrue(settings.allowNetwork.value)
  }

  @Test
  fun callerCancellationStillPropagatesToTransport() = runTest {
    settings.setAllowNetwork(true)
    val response = async { client.execute(REQUEST) }
    runCurrent()
    response.cancel()
    runCurrent()
    assertTrue(response.isCancelled)
    assertTrue(transport.cancelled)
  }

  private fun assertBlocked(response: PrototypeRequestResponse) {
    assertEquals(
      PrototypeRequestErrorCode.BLOCKED_DESTINATION,
      (response as PrototypeRequestResponse.Failed).error.code,
    )
  }

  private class SuspendedHttpClient : PrototypeHttpClient {
    val result = CompletableDeferred<PrototypeRequestResponse>()
    val received = PrototypeRequestResponse.Received(200, emptyMap(), null, 0)
    var calls = 0
    var cancelled = false
    var ignoreCancellation = false

    override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
      calls++
      var returned = false
      try {
        val response =
          if (ignoreCancellation) withContext(NonCancellable) { result.await() } else result.await()
        returned = true
        return response
      } finally {
        cancelled = !returned
      }
    }
  }

  private companion object {
    val REQUEST =
      PrototypeHttpRequest(
        "request",
        "prototype",
        "GET",
        "https://example.test",
        emptyMap(),
        null,
        1000,
      )
  }
}
