package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.protocol.ErrorResponse
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.websocket.CloseReason
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.suspendCoroutineUninterceptedOrReturn
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.util.ReflectionHelpers

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class CtrlProxyHierarchyRequestTest {
  private class RecordingTransport : WebSocketServer.ClientTransport {
    val messages = mutableListOf<String>()

    override suspend fun send(message: String) {
      messages += message
    }

    override suspend fun close(reason: CloseReason) = Unit
  }

  private class Fixture(test: TestScope, extract: (HierarchySnapshotOptions) -> ViewHierarchy?) {
    val proxy: CtrlProxy = Robolectric.buildService(CtrlProxy::class.java).get()
    private val dispatcher = StandardTestDispatcher(test.testScheduler)
    private val oldScope: CoroutineScope = ReflectionHelpers.getField(proxy, "serviceScope")
    private val scope =
      CoroutineScope(
        test.backgroundScope.coroutineContext +
          dispatcher +
          checkNotNull(oldScope.coroutineContext[kotlinx.coroutines.CoroutineExceptionHandler])
      )
    val debouncer =
      HierarchyDebouncer(scope = scope, extractHierarchy = { _, options -> extract(options) })
    private val handler =
      proxy.queuedMessageHandler(CtrlProxyMessageHandler(proxy), scope, dispatcher)
    val server =
      WebSocketServer(
        scope = scope,
        messageHandler = handler,
        onClientDisconnected = handler::disconnect,
      )
    val requester = RecordingTransport()
    val peer = RecordingTransport()
    val owner: WebSocketServer.ConnectedClient
    private val json = Json { ignoreUnknownKeys = true }

    init {
      oldScope.cancel()
      ReflectionHelpers.setField(proxy, "serviceScope", scope)
      ReflectionHelpers.setField(proxy, "hierarchyDebouncer", debouncer)
      ReflectionHelpers.setField(proxy, "webSocketServer", server)
      // An unstarted engine marks the server running without opening a socket or launching jobs.
      ReflectionHelpers.setField(server, "server", embeddedServer(CIO, port = 0) {})
      owner = server.registerClient(1, requester)
      server.registerClient(2, peer)
    }

    suspend fun dispatch(id: String, stale: Boolean = false, since: Long = Long.MAX_VALUE) {
      val command =
        if (stale) {
          """{"type":"request_hierarchy_if_stale","requestId":"$id","sinceTimestamp":$since}"""
        } else {
          """{"type":"request_hierarchy","requestId":"$id"}"""
        }
      server.handleClientMessage(command, owner)
    }

    fun cancelServiceScope() = scope.cancel()

    fun markServerStopped() {
      ReflectionHelpers.setField(server, "server", null)
    }

    fun assertNoReply(id: String) {
      assertTrue(requester.messages.isEmpty())
      assertTrue(peer.messages.isEmpty())
      assertFalse(server.hasRequestOwner(id))
    }

    fun assertError(id: String, message: String) {
      assertEquals(1, requester.messages.size)
      val frame = json.decodeFromString<ErrorResponse>(requester.messages.single())
      assertEquals(id, frame.requestId)
      assertEquals(message, frame.error)
      assertTrue(peer.messages.isEmpty())
      assertFalse(server.hasRequestOwner(id))
    }

    suspend fun extractSnapshot(id: String, options: HierarchySnapshotOptions): Unit =
      suspendCoroutineUninterceptedOrReturn { continuation ->
        // Exercise the private service entry point without widening its production API.
        val method =
          CtrlProxy::class
            .java
            .getDeclaredMethod(
              "extractHierarchyNow",
              Boolean::class.javaPrimitiveType,
              HierarchySnapshotOptions::class.java,
              String::class.java,
              Continuation::class.java,
            )
        method.isAccessible = true
        method.invoke(proxy, false, options, id, continuation)
      }
  }

  @Test
  fun `null extraction replies once only to the requester`() = runTest {
    val fixture = Fixture(this) { null }
    fixture.dispatch("req_null")
    runCurrent()
    fixture.assertError("req_null", HierarchyExtractErrorFrames.NULL_HIERARCHY_ERROR)
    assertTrue(fixture.debouncer.hierarchyFlow.replayCache.isEmpty())
  }

  @Test
  fun `queued extraction throw replies once with the hierarchy error format`() = runTest {
    val fixture = Fixture(this) { error("tree unavailable") }
    fixture.dispatch("req_throw")
    runCurrent()
    fixture.assertError("req_throw", "Hierarchy extraction failed: tree unavailable")
  }

  @Test
  fun `stale extraction throw reaches its requester`() = runTest {
    val fixture = Fixture(this) { error("stale tree unavailable") }
    fixture.dispatch("stale_throw", stale = true)
    runCurrent()
    fixture.assertError("stale_throw", "Hierarchy extraction failed: stale tree unavailable")
  }

  @Test
  fun `cancelled snapshot with a live command gets one error reply`() = runTest {
    val fixture = Fixture(this) { ViewHierarchy(updatedAt = 0, packageName = "discarded") }
    fixture.server.registerRequestOwner("req_snapshot", fixture.owner)
    fixture.extractSnapshot("req_snapshot", HierarchySnapshotOptions(isCancelled = { true }))
    runCurrent()
    fixture.assertError("req_snapshot", HierarchyExtractErrorFrames.NULL_HIERARCHY_ERROR)
    assertTrue(fixture.debouncer.hierarchyFlow.replayCache.isEmpty())
  }

  @Test
  fun `stale null extraction replies once only to its requester`() = runTest {
    val fixture = Fixture(this) { null }
    fixture.dispatch("stale_null", stale = true)
    runCurrent()
    fixture.assertError("stale_null", HierarchyExtractErrorFrames.NULL_HIERARCHY_ERROR)
  }

  @Test
  fun `correlated stale request skips extraction and releases owner when a newer event exists`() =
    runTest {
      var extractions = 0
      val fixture =
        Fixture(this) {
          extractions++
          null
        }
      // The initial last-event timestamp is zero, newer than this caller's timestamp.
      fixture.dispatch("stale_event", stale = true, since = -1)
      runCurrent()
      assertEquals(0, extractions)
      fixture.assertNoReply("stale_event")
    }

  @Test
  fun `successful correlated extraction broadcasts to both clients and releases owner`() = runTest {
    val fixture = Fixture(this) { ViewHierarchy(updatedAt = 0, packageName = "fixture") }
    fixture.dispatch("req_success")
    runCurrent()
    assertEquals(1, fixture.requester.messages.size)
    assertEquals(
      "req_success",
      WebSocketServer.extractRequestId(fixture.requester.messages.single()),
    )
    assertTrue(fixture.requester.messages.single().contains("\"type\":\"hierarchy_update\""))
    assertEquals(fixture.requester.messages, fixture.peer.messages)
    assertFalse(fixture.server.hasRequestOwner("req_success"))
    assertTrue(fixture.debouncer.hierarchyFlow.replayCache.isEmpty())
  }

  @Test
  fun `successful correlated stale extraction broadcasts to both clients and releases owner`() =
    runTest {
      val fixture = Fixture(this) { ViewHierarchy(updatedAt = 0, packageName = "fixture") }
      fixture.dispatch("stale_success", stale = true)
      runCurrent()
      assertEquals(1, fixture.requester.messages.size)
      assertEquals(
        "stale_success",
        WebSocketServer.extractRequestId(fixture.requester.messages.single()),
      )
      assertTrue(fixture.requester.messages.single().contains("\"type\":\"hierarchy_update\""))
      assertEquals(fixture.requester.messages, fixture.peer.messages)
      assertFalse(fixture.server.hasRequestOwner("stale_success"))
    }

  @Test
  fun `uncorrelated successful extraction retains broadcast routing`() = runTest {
    val fixture = Fixture(this) { ViewHierarchy(updatedAt = 0, packageName = "fixture") }
    fixture.proxy.requestHierarchy(false, null)
    runCurrent()
    assertEquals(1, fixture.requester.messages.size)
    assertEquals(fixture.requester.messages, fixture.peer.messages)
    assertTrue(fixture.requester.messages.single().contains("\"type\":\"hierarchy_update\""))
  }

  @Test
  fun `stale extraction cancellation releases owner without a reply`() = runTest {
    val fixture = Fixture(this) { throw CancellationException("cancelled") }
    fixture.dispatch("stale_cancel", stale = true)
    runCurrent()
    fixture.assertNoReply("stale_cancel")
  }

  @Test
  fun `cooperative extraction cancellation propagates and releases owner without a reply`() =
    runTest {
      val cancellation = CancellationException("command cancelled")
      val fixture = Fixture(this) { throw cancellation }
      fixture.server.registerRequestOwner("req_cancel", fixture.owner)
      try {
        fixture.proxy.requestHierarchy(false, "req_cancel")
        error("expected cancellation")
      } catch (actual: CancellationException) {
        assertSame(cancellation, actual)
      }
      runCurrent()
      fixture.assertNoReply("req_cancel")
    }

  @Test
  fun `command cancelled during a null extraction releases owner without a reply`() = runTest {
    lateinit var command: Job
    val fixture =
      Fixture(this) {
        command.cancel()
        null
      }
    fixture.server.registerRequestOwner("req_cancel_null", fixture.owner)
    command = launch { fixture.proxy.requestHierarchy(false, "req_cancel_null") }
    runCurrent()
    assertTrue(command.isCancelled)
    fixture.assertNoReply("req_cancel_null")
  }

  @Test
  fun `stale launch cancelled before extraction starts releases owner without a reply`() = runTest {
    var extractions = 0
    val fixture =
      Fixture(this) {
        extractions++
        null
      }
    fixture.server.registerRequestOwner("stale_cancel_launch", fixture.owner)
    fixture.proxy.requestHierarchyIfStale(Long.MAX_VALUE, "stale_cancel_launch")
    fixture.cancelServiceScope()
    runCurrent()
    assertEquals(0, extractions)
    fixture.assertNoReply("stale_cancel_launch")
  }

  @Test
  fun `successful extraction releases owner when the server is not running`() = runTest {
    val fixture = Fixture(this) { ViewHierarchy(updatedAt = 0, packageName = "fixture") }
    // Model an admitted request: the queue skips new commands once the server is stopped.
    fixture.server.registerRequestOwner("req_stopped_success", fixture.owner)
    fixture.markServerStopped()
    fixture.proxy.requestHierarchy(false, "req_stopped_success")
    runCurrent()
    fixture.assertNoReply("req_stopped_success")
  }

  @Test
  fun `null extraction releases owner when the server is not running`() = runTest {
    val fixture = Fixture(this) { null }
    fixture.server.registerRequestOwner("req_stopped_null", fixture.owner)
    fixture.markServerStopped()
    fixture.proxy.requestHierarchy(false, "req_stopped_null")
    runCurrent()
    fixture.assertNoReply("req_stopped_null")
  }

  @Test
  fun `thrown extraction releases owner when the server is not running`() = runTest {
    val fixture = Fixture(this) { error("tree unavailable") }
    fixture.server.registerRequestOwner("req_stopped_throw", fixture.owner)
    fixture.markServerStopped()
    fixture.proxy.requestHierarchy(false, "req_stopped_throw")
    runCurrent()
    fixture.assertNoReply("req_stopped_throw")
  }
}
