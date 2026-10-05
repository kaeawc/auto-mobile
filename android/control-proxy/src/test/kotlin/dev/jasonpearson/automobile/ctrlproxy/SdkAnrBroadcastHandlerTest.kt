package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.AnrEvent
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.websocket.CloseReason
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.util.ReflectionHelpers

class SdkAnrBroadcastHandlerTest {
  @Test
  fun `ordered ANR acknowledges after downstream handoff`() {
    val result = FakeResult(true)
    val fixture = Fixture(beforeEnqueue = { assertTrue(result.codes.isEmpty()) })
    fixture.handler.handle(json, result, "id")
    assertEquals(listOf(event), fixture.events)
    assertEquals(listOf(SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED), result.codes)
  }

  @Test
  fun `non ordered legacy ANR forwards without setting result`() {
    val fixture = Fixture()
    val result = FakeResult(false)
    fixture.handler.handle(json, result)
    assertEquals(listOf(event), fixture.events)
    assertTrue(result.codes.isEmpty())
  }

  @Test
  fun `missing malformed and wrong type payloads reject without forwarding`() {
    val fixture = Fixture()
    val result = FakeResult(true)
    for (invalid in listOf(null, "not-json", "{}", "{\"type\":\"event_batch\"}")) {
      fixture.handler.handle(invalid, result, "id")
    }
    assertTrue(fixture.events.isEmpty())
    assertEquals(
      List(4) { SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD },
      result.codes,
    )
    fixture.handler.handle(json, result, "id")
    assertEquals(listOf(event), fixture.events)
  }

  @Test
  fun `invalid non ordered payload never sets result`() {
    val fixture = Fixture()
    val result = FakeResult(false)
    fixture.handler.handle(null, result)
    assertTrue(fixture.events.isEmpty())
    assertTrue(result.codes.isEmpty())
  }

  @Test
  fun `replayed delivery id acknowledges twice and forwards once`() {
    val fixture = Fixture()
    val result = FakeResult(true)
    repeat(2) { fixture.handler.handle(json, result, "same") }
    assertEquals(listOf(event), fixture.events)
    assertEquals(List(2) { SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED }, result.codes)
  }

  @Test
  fun `deduplication is bounded and repeats do not refresh oldest id`() {
    val fixture = Fixture(capacity = 2)
    val result = FakeResult(true)
    for (id in listOf("oldest", "second", "oldest", "third", "oldest")) {
      fixture.handler.handle(json, result, id)
    }
    assertEquals(List(4) { event }, fixture.events)
    assertEquals(List(5) { SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED }, result.codes)
  }

  @Test
  fun `absent delivery id preserves legacy repeated forwarding`() {
    val fixture = Fixture()
    val result = FakeResult(false)
    repeat(2) { fixture.handler.handle(json, result) }
    assertEquals(List(2) { event }, fixture.events)
    assertTrue(result.codes.isEmpty())
  }

  @Test
  fun `failed handoff does not remember delivery id`() {
    var accept = false
    val fixture = Fixture(accept = { accept })
    val result = FakeResult(true)
    fixture.handler.handle(json, result, "retry")
    accept = true
    repeat(2) { fixture.handler.handle(json, result, "retry") }
    assertEquals(List(2) { event }, fixture.events)
    assertEquals(listOf(1001, 1000, 1000), result.codes)
  }

  @Test
  fun `invalid replay is rejected even after id was accepted`() {
    val fixture = Fixture()
    val result = FakeResult(true)
    fixture.handler.handle(json, result, "id")
    fixture.handler.handle("not-json", result, "id")
    fixture.handler.handle(json, result, "id")
    assertEquals(listOf(event), fixture.events)
    assertEquals(listOf(1000, 1002, 1000), result.codes)
  }

  private class Fixture(
    capacity: Int = 256,
    accept: () -> Boolean = { true },
    beforeEnqueue: () -> Unit = {},
  ) {
    val events = mutableListOf<SdkAnrEvent>()
    val handler =
      SdkAnrBroadcastHandler(
        enqueue = { event ->
          events.add(event)
          beforeEnqueue()
          accept()
        },
        log =
          object : SdkEventBatchBroadcastHandler.LogSink {
            override fun debug(message: String) {}

            override fun warn(message: String) {
              error(message)
            }
          },
        recentAnrCapacity = capacity,
      )
  }

  private class FakeResult(override val isOrdered: Boolean) :
    SdkEventBatchBroadcastHandler.ResultSink {
    val codes = mutableListOf<Int>()

    override fun setResultCode(code: Int) {
      check(isOrdered)
      codes.add(code)
    }
  }

  private companion object {
    val event =
      SdkAnrEvent(
        timestamp = 20L,
        applicationId = "app",
        pid = 123,
        processName = "app",
        importance = "FOREGROUND",
        trace = null,
        reason = "Application Not Responding",
      )
    val json = SdkEventSerializer.toJson(event)

    @BeforeClass
    @JvmStatic
    fun warmSerializer() {
      SdkEventSerializer.anrEventFromJson(json)
    }
  }
}

/** Exercises the real receiver handoff and SDK-event conversion without opening a listener. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class SdkAnrRetainedDeliveryTest {
  @Test
  fun `accepted ANR with no client is retained until a client connects`() = runTest {
    val fixture = Fixture(this)
    fixture.markRunning()
    fixture.processor.start()
    fixture.receive("no-client")
    assertEquals(listOf(1000), fixture.codes)
    runCurrent()
    assertTrue(fixture.transport.messages.isEmpty())
    fixture.connect()
    runCurrent()
    fixture.assertDelivered(1)
  }

  @Test
  fun `accepted ANR waits for server startup just like a batch`() = runTest {
    val fixture = Fixture(this)
    fixture.receive("startup")
    assertEquals(listOf(1000), fixture.codes)
    runCurrent()
    fixture.connect()
    assertTrue(fixture.transport.messages.isEmpty())
    fixture.markRunning()
    fixture.processor.start()
    runCurrent()
    fixture.assertDelivered(1)
  }

  @Test
  fun `full shared retention queue rejects without deduping and accepts later replay`() = runTest {
    val fixture = Fixture(this)
    fixture.markRunning()
    fixture.processor.start()
    fixture.receive("in-flight")
    runCurrent()
    repeat(64) { fixture.receive("queued-$it") }
    fixture.receive("retry")
    assertEquals(List(65) { 1000 } + 1001, fixture.codes)
    fixture.connect()
    runCurrent()
    fixture.assertDelivered(65)
    fixture.receive("retry")
    fixture.receive("retry")
    assertEquals(listOf(1001, 1000, 1000), fixture.codes.takeLast(3))
    runCurrent()
    fixture.assertDelivered(66)
  }

  @Test
  fun `stopped service rejects ANR when retention is impossible`() = runTest {
    val fixture = Fixture(this)
    fixture.cancelService()
    assertFalse(fixture.processor.enqueue(SdkEventBatch(timestamp = 0L, events = emptyList())))
    fixture.receive("retry-after-stop")
    assertEquals(listOf(1001), fixture.codes)
    assertTrue(fixture.transport.messages.isEmpty())
  }

  private class RecordingTransport : WebSocketServer.ClientTransport {
    val messages = mutableListOf<String>()

    override suspend fun send(message: String) {
      messages.add(message)
    }

    override suspend fun close(reason: CloseReason) = Unit
  }

  private class Fixture(test: TestScope) {
    private val proxy = Robolectric.buildService(CtrlProxy::class.java).get()
    private val scope =
      CoroutineScope(
        test.backgroundScope.coroutineContext + StandardTestDispatcher(test.testScheduler)
      )
    private val server = WebSocketServer(port = 0, scope = scope)
    val transport = RecordingTransport()
    val codes = mutableListOf<Int>()
    val processor: SdkEventBatchProcessor
    private val handler: SdkAnrBroadcastHandler
    private val event =
      SdkAnrEvent(
        timestamp = 20L,
        applicationId = "app",
        pid = 123,
        processName = "app",
        importance = "FOREGROUND",
        trace = "trace",
        reason = "Application Not Responding",
      )

    init {
      ReflectionHelpers.getField<CoroutineScope>(proxy, "serviceScope").cancel()
      ReflectionHelpers.setField(proxy, "serviceScope", scope)
      ReflectionHelpers.setField(proxy, "webSocketServer", server)
      processor =
        ReflectionHelpers.getField<Lazy<SdkEventBatchProcessor>>(
            proxy,
            "sdkEventBatchProcessor\$delegate",
          )
          .value
      handler = ReflectionHelpers.getField(proxy, "anrBroadcastHandler")
    }

    fun cancelService() {
      scope.cancel()
    }

    fun markRunning() {
      // An unstarted engine provides the running marker without binding a port.
      ReflectionHelpers.setField(server, "server", embeddedServer(CIO, port = 0) {})
    }

    fun connect() {
      server.registerClient(1, transport)
    }

    fun receive(id: String) {
      handler.handle(
        SdkEventSerializer.toJson(event),
        object : SdkEventBatchBroadcastHandler.ResultSink {
          override val isOrdered = true

          override fun setResultCode(code: Int) {
            codes.add(code)
          }
        },
        id,
      )
    }

    fun assertDelivered(count: Int) {
      assertEquals(count, transport.messages.size)
      val decoded = Json {
        ignoreUnknownKeys = true
      }
        .decodeFromString<AnrEvent>(transport.messages.last())
      assertEquals(event.timestamp, decoded.timestamp)
      assertEquals(event.pid, decoded.event.pid)
      assertEquals(event.trace, decoded.event.trace)
      assertEquals(event.applicationId, decoded.event.packageName)
    }
  }
}
