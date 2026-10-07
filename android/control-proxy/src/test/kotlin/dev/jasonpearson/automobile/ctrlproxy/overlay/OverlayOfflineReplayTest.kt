package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Offline buffering, replay and `inspect_overlays` for device-persistent overlays (#10494). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayOfflineReplayTest {
  private val host = FakeInteractiveOverlayHost()
  private val timer = FakeOverlayTimer()
  private val events = mutableListOf<OverlayEvent>()
  private val statuses = mutableListOf<Triple<String?, List<OverlayStatusEntry>, Long>>()
  private val failures = mutableListOf<String?>()
  private var clients = 1
  private var failSends = 0

  private fun controller(buffer: OverlayOfflineEventBuffer = OverlayOfflineEventBuffer()) =
    OverlayController(
      host,
      object : OverlayResultSink {
        override suspend fun send(requestId: String?, success: Boolean, error: String?) {
          if (!success) failures += error
        }

        override suspend fun sendOverlayStatus(
          requestId: String?,
          overlays: List<OverlayStatusEntry>,
          droppedEvents: Long,
        ) {
          statuses += Triple(requestId, overlays, droppedEvents)
        }
      },
      eventSink =
        OverlayEventSink {
          if (failSends > 0) {
            failSends--
            error("socket closed")
          }
          events += it
        },
      clock = { timer.now },
      lifecycle = OverlayLifecycle(timer, TTL, clientCount = { clients }),
      offlineEvents = buffer,
    )

  private fun spec(persistence: String? = "device") =
    OverlaySpec(
      "proto",
      OverlayWindow(OverlayFullscreenPlacement(), persistence = persistence),
      state = mapOf("label" to OverlayScalar.Text("start")),
      root = OverlayPagerNode("pager", children = List(3) { OverlayTextNode(text = "screen") }),
    )

  private suspend fun OverlayController.emit(name: String) =
    interact(checkNotNull(activeRuntime), OverlayInteraction.Tap(listOf(OverlayEmitAction(name))))

  private suspend fun OverlayController.nextPage() =
    interact(
      checkNotNull(activeRuntime),
      OverlayInteraction.Tap(listOf(OverlaySetPageAction("pager", OverlayPageTarget.Next))),
    )

  @Test
  fun `events produced with no host connected are held then replayed in order on connect`() =
    runTest {
      val controller = controller()
      controller.show(null, spec())
      clients = 0
      controller.onClientCountChanged(0)
      controller.emit("tap")
      controller.nextPage()
      controller.emit("again")
      assertTrue(events.isEmpty())

      clients = 1
      controller.onClientConnected()

      assertEquals(listOf("tap", null, "again"), events.map { it.name })
      assertEquals(
        listOf(OverlayEventKind.EMIT, OverlayEventKind.PAGE_CHANGED, OverlayEventKind.EMIT),
        events.map { it.kind },
      )
      assertEquals(listOf(1L, 2L, 3L), events.map { it.sequence })
      assertEquals(1, events[1].pages["pager"])
    }

  @Test
  fun `a connected host receives events directly and nothing is held`() = runTest {
    val controller = controller()
    controller.show(null, spec())
    controller.emit("live")
    assertEquals(listOf("live"), events.map { it.name })
    controller.onClientConnected()
    assertEquals(1, events.size)
  }

  @Test
  fun `a live event is preceded by anything still held so order never inverts`() = runTest {
    val controller = controller()
    controller.show(null, spec())
    clients = 0
    controller.emit("offline")
    clients = 1
    controller.emit("live")
    assertEquals(listOf("offline", "live"), events.map { it.name })
    assertEquals(listOf(1L, 2L), events.map { it.sequence })
  }

  @Test
  fun `a failed delivery keeps the failed event and the tail for the next replay`() = runTest {
    val controller = controller()
    controller.show(null, spec())
    clients = 0
    for (name in listOf("a", "b", "c")) controller.emit(name)
    clients = 1
    failSends = 1

    controller.inspect("first")
    assertTrue(events.isEmpty())

    controller.inspect("second")
    assertEquals(listOf("a", "b", "c"), events.map { it.name })
    assertEquals(listOf(1L, 2L, 3L), events.map { it.sequence })
  }

  @Test
  fun `a live event queues behind held events that could not be delivered`() = runTest {
    val controller = controller()
    controller.show(null, spec())
    clients = 0
    controller.emit("held")
    clients = 1
    failSends = 1

    controller.emit("live")
    assertTrue(events.isEmpty())

    controller.onClientConnected()
    assertEquals(listOf("held", "live"), events.map { it.name })
  }

  @Test
  fun `the host leaving mid replay keeps the undelivered events`() = runTest {
    val controller = controller()
    controller.show(null, spec())
    clients = 0
    for (name in listOf("a", "b")) controller.emit(name)
    clients = 1
    controller.onClientConnected()
    assertEquals(listOf("a", "b"), events.map { it.name })

    clients = 0
    controller.emit("c")
    controller.onClientConnected()
    assertEquals(listOf("a", "b"), events.map { it.name })

    clients = 1
    controller.onClientConnected()
    assertEquals(listOf("a", "b", "c"), events.map { it.name })
  }

  @Test
  fun `restore puts events back ahead of newer ones and respects capacity`() {
    val buffer = OverlayOfflineEventBuffer(capacity = 3)
    fun event(sequence: Long) =
      OverlayEvent(0, "id", sequence, OverlayEventKind.EMIT, null, null, emptyMap())
    buffer.add(event(4))
    buffer.restore(listOf(event(1), event(2), event(3)))
    assertEquals(1L, buffer.dropped)
    assertEquals(listOf(1L, 2L, 3L), buffer.drain().map { it.sequence })
  }

  @Test
  fun `the buffer is bounded, drops the oldest and counts what it dropped`() = runTest {
    val controller = controller(OverlayOfflineEventBuffer(capacity = 2))
    controller.show(null, spec())
    clients = 0
    for (name in listOf("a", "b", "c", "d")) controller.emit(name)

    clients = 1
    controller.inspect("inspect")

    assertEquals(listOf("c", "d"), events.map { it.name })
    assertEquals(listOf(3L, 4L), events.map { it.sequence })
    assertEquals(2L, statuses.single().third)
  }

  @Test
  fun `session overlays never use the offline buffer`() = runTest {
    val controller = controller(OverlayOfflineEventBuffer(capacity = 1))
    controller.show(null, spec(persistence = "session"))
    controller.emit("one")
    controller.emit("two")
    assertEquals(listOf("one", "two"), events.map { it.name })
    controller.inspect("r")
    assertEquals(0L, statuses.single().third)
  }

  @Test
  fun `inspect delivers held events first then reports the persisted overlay`() = runTest {
    val controller = controller()
    controller.show(null, spec())
    clients = 0
    controller.emit("held")
    controller.nextPage()
    controller.interact(
      checkNotNull(controller.activeRuntime),
      OverlayInteraction.TextChange("label", "typed"),
    )
    clients = 1

    controller.inspect("inspect-1")

    assertEquals(listOf("held", null, "change"), events.map { it.name })
    val (requestId, overlays, dropped) = statuses.single()
    assertEquals("inspect-1", requestId)
    assertEquals(0L, dropped)
    val entry = overlays.single()
    assertEquals("proto", entry.id)
    assertTrue(entry.persistent)
    assertEquals(1, entry.pages["pager"])
    assertEquals(OverlayScalar.Text("typed"), entry.state["label"])
    assertEquals(3L, entry.lastSequence)
    // Sequences continue from the ledger; there is no rewind.
    controller.emit("next")
    assertEquals(4L, events.last().sequence)
  }

  @Test
  fun `inspect with nothing showing reports an empty list`() = runTest {
    val controller = controller()
    controller.inspect("none")
    assertTrue(statuses.single().second.isEmpty())
    assertTrue(failures.isEmpty())
  }

  @Test
  fun `a held dismissed event is replayed when the host returns`() = runTest {
    val controller = controller()
    controller.show(null, spec())
    clients = 0
    host.requests.last().onHostDismiss()
    assertTrue(events.isEmpty())
    clients = 1
    controller.onClientConnected()
    assertEquals(listOf(OverlayEventKind.DISMISSED), events.map { it.kind })
    controller.inspect("after")
    assertTrue(statuses.single().second.isEmpty())
  }

  @Test
  fun `the offline buffer drops the oldest and drains oldest first`() {
    val buffer = OverlayOfflineEventBuffer(capacity = 2)
    fun event(sequence: Long) =
      OverlayEvent(0, "id", sequence, OverlayEventKind.EMIT, null, null, emptyMap())
    buffer.add(event(1))
    buffer.add(event(2))
    buffer.add(event(3))
    assertEquals(1L, buffer.dropped)
    assertEquals(2, buffer.size)
    assertEquals(listOf(2L, 3L), buffer.drain().map { it.sequence })
    assertEquals(0, buffer.size)
    assertEquals(1L, buffer.dropped)
    assertThrows(IllegalArgumentException::class.java) { OverlayOfflineEventBuffer(0) }
  }

  private companion object {
    const val TTL = 1_000L
  }
}
