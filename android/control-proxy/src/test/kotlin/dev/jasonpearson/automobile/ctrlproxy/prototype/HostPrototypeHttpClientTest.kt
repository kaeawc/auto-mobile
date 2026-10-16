package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `via: "host"` transport (#12528): the `prototype_request` frame it sends over the CtrlProxy
 * socket and how the matching `prototype_response` ends the wait. A fake link stands in for the
 * socket and the test's virtual clock for time.
 */
class HostPrototypeHttpClientTest {
  private val frames = mutableListOf<String>()
  private var connected = true
  private var socket: Any = "A"
  private val cancels = mutableListOf<Pair<Any, String>>()
  private val warnings = mutableListOf<String>()
  private var now = 0L

  private fun client(graceMs: Long = 1_000L) =
    HostPrototypeHttpClient(
      link =
        PrototypeHostLink { frame ->
          if (connected) frames += frame
          socket.takeIf { connected }
        },
      clock = { now },
      graceMs = graceMs,
      warn = { warnings += it },
      cancelLink = { target, frame -> cancels += target to frame },
    )

  private fun request(id: String = "r-1", timeoutMs: Int = 10_000) =
    PrototypeHttpRequest(
      requestId = id,
      prototypeId = "proto",
      method = "POST",
      url = "http://localhost:8080/items",
      headers = mapOf("Accept" to "application/json"),
      body = Json.parseToJsonElement("""{"a":1}"""),
      timeoutMs = timeoutMs,
    )

  private fun failure(response: PrototypeRequestResponse) =
    (response as PrototypeRequestResponse.Failed).error

  @Test
  fun `the request frame carries everything the host needs`() = runTest {
    val client = client()
    val pending = async { client.execute(request()) }
    runCurrent()

    val frame = Json.parseToJsonElement(frames.single()).jsonObject
    assertEquals(
      Json.parseToJsonElement(
        """{"type":"prototype_request","requestId":"r-1","prototypeId":"proto","method":"POST","url":"http://localhost:8080/items","headers":{"Accept":"application/json"},"body":{"a":1},"timeoutMs":10000}""",
      ),
      frame,
    )
    pending.cancel()
  }

  @Test
  fun `losing the socket a request went to fails it at once while another stays up`() = runTest {
    val client = client()
    socket = "B"
    val toB = async { client.execute(request("r-b")) }
    runCurrent()

    client.onHostLost("A")
    runCurrent()
    assertFalse(toB.isCompleted)

    client.onHostLost("B")
    runCurrent()
    assertEquals(PrototypeRequestErrorCode.NETWORK, failure(toB.await()).code)

    // The next request goes to the connection that remains.
    socket = "A"
    val toA = async { client.execute(request("r-a")) }
    runCurrent()
    client.onHostLost("B")
    runCurrent()
    assertFalse(toA.isCompleted)
    client.onResponse(
      """{"type":"prototype_response","requestId":"r-a","ok":true,"status":200,"durationMs":1}""",
    )
    runCurrent()
    assertTrue(toA.await() is PrototypeRequestResponse.Received)
  }

  @Test
  fun `a superseded request sends one cancel frame on its own connection`() = runTest {
    val client = client()
    socket = "B"
    val pending = async { client.execute(request("r-old")) }
    runCurrent()
    socket = "A"

    pending.cancel()
    runCurrent()

    assertEquals(
      listOf<Pair<Any, String>>(
        "B" to """{"type":"prototype_request_cancel","requestId":"r-old"}""",
      ),
      cancels,
    )
  }

  @Test
  fun `an answered request sends no cancel frame`() = runTest {
    val client = client()
    val pending = async { client.execute(request("r-1")) }
    runCurrent()
    client.onResponse(
      """{"type":"prototype_response","requestId":"r-1","ok":true,"status":200,"durationMs":1}""",
    )
    runCurrent()
    pending.await()

    assertEquals(emptyList<Pair<Any, String>>(), cancels)
  }

  @Test
  fun `the frame body has its object keys sorted`() = runTest {
    val client = client()
    val body = Json.parseToJsonElement("""{"b":1,"a":{"d":1,"c":2}}""")
    val pending = async { client.execute(request().copy(body = body)) }
    runCurrent()

    assertTrue(frames.single().contains(""""body":{"a":{"c":2,"d":1},"b":1}"""))
    pending.cancel()
  }

  @Test
  fun `a frame without headers or a body omits them`() = runTest {
    val client = client()
    val pending = async {
      client.execute(request().copy(method = "GET", headers = emptyMap(), body = null))
    }
    runCurrent()

    val frame = Json.parseToJsonElement(frames.single()).jsonObject
    assertFalse("headers" in frame)
    assertFalse("body" in frame)
    pending.cancel()
  }

  @Test
  fun `the matching response ends the wait`() = runTest {
    val client = client()
    val pending = async { client.execute(request()) }
    runCurrent()

    client.onResponse(
      """{"type":"prototype_response","requestId":"r-1","ok":true,"status":201,"headers":{"content-type":"application/json"},"body":{"id":7},"durationMs":31}""",
    )

    val response = pending.await() as PrototypeRequestResponse.Received
    assertEquals(201, response.status)
    assertEquals(mapOf("content-type" to "application/json"), response.headers)
    assertEquals(Json.parseToJsonElement("""{"id":7}"""), response.body)
    assertEquals(31L, response.durationMs)
  }

  @Test
  fun `a null body is an empty response and a string body stays a string`() = runTest {
    val client = client()
    val first = async { client.execute(request("a")) }
    val second = async { client.execute(request("b")) }
    runCurrent()

    client.onResponse(
      """{"type":"prototype_response","requestId":"a","ok":true,"status":204,"headers":{},"body":null,"durationMs":1}""",
    )
    client.onResponse(
      """{"type":"prototype_response","requestId":"b","ok":true,"status":200,"headers":{},"body":"text","durationMs":1.6}""",
    )

    assertEquals(null, (first.await() as PrototypeRequestResponse.Received).body)
    val text = second.await() as PrototypeRequestResponse.Received
    assertEquals(JsonPrimitive("text"), text.body)
    assertEquals(2L, text.durationMs)
  }

  @Test
  fun `a host error carries its code`() = runTest {
    val client = client()
    val pending = async { client.execute(request()) }
    runCurrent()

    client.onResponse(
      """{"type":"prototype_response","requestId":"r-1","ok":false,"error":{"code":"connection_refused","message":"Connection refused: http://localhost:8080/items"},"durationMs":4}""",
    )

    val error = failure(pending.await())
    assertEquals(PrototypeRequestErrorCode.CONNECTION_REFUSED, error.code)
    assertEquals("Connection refused: http://localhost:8080/items", error.message)
  }

  @Test
  fun `with no host connected the request fails at once as network and names via host`() = runTest {
    connected = false

    val error = failure(client().execute(request()))

    assertEquals(PrototypeRequestErrorCode.NETWORK, error.code)
    assertTrue(error.message, "via \"host\"" in error.message)
    assertTrue(frames.isEmpty())
  }

  @Test
  fun `a host that never answers times out a grace period after the request timeout`() = runTest {
    val client = client(graceMs = 1_000L)
    val pending = async { client.execute(request(timeoutMs = 2_000)) }
    runCurrent()

    advanceTimeBy(2_999L)
    runCurrent()
    assertFalse(pending.isCompleted)
    advanceTimeBy(2L)
    runCurrent()

    val error = failure(pending.await())
    assertEquals(PrototypeRequestErrorCode.TIMEOUT, error.code)
  }

  @Test
  fun `losing the host fails what is waiting`() = runTest {
    val client = client()
    val pending = async { client.execute(request()) }
    runCurrent()

    client.onHostLost()

    val error = failure(pending.await())
    assertEquals(PrototypeRequestErrorCode.NETWORK, error.code)
    assertEquals(HostPrototypeHttpClient.HOST_LOST_MESSAGE, error.message)
  }

  @Test
  fun `a response for nothing that waits is dropped`() = runTest {
    val client = client()

    client.onResponse(
      """{"type":"prototype_response","requestId":"ghost","ok":true,"status":200,"headers":{},"body":null,"durationMs":1}""",
    )

    val pending = async { client.execute(request()) }
    runCurrent()
    assertFalse(pending.isCompleted)
    pending.cancel()
  }

  @Test
  fun `a malformed response fails the request it names and a cancelled one stops waiting`() =
    runTest {
      val client = client()
      val pending = async { client.execute(request()) }
      runCurrent()

      client.onResponse("""{"type":"prototype_response","requestId":"r-1","ok":"yes"}""")

      assertEquals(PrototypeRequestErrorCode.NETWORK, failure(pending.await()).code)
      assertTrue(warnings.single().startsWith("Malformed prototype_response"))

      val cancelled = async { client.execute(request("r-2")) }
      runCurrent()
      cancelled.cancel()
      runCurrent()
      // Its late answer finds nobody waiting and changes nothing.
      client.onResponse(
        """{"type":"prototype_response","requestId":"r-2","ok":true,"status":200,"headers":{},"body":null,"durationMs":1}""",
      )
      assertTrue(cancelled.isCancelled)
    }
}
