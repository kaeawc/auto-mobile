package dev.jasonpearson.automobile.ctrlproxy

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GuestAudioCaptureControllerTest {
  private class FakeRecord : GuestAudioCaptureRecord {
    var started = 0
    var released = 0
    var stopped = 0
    var reads = 0
    var recording = false
    var startError: Exception? = null
    var onRead: () -> Int = { 16 }
    var onStop: () -> Unit = {}
    var onRelease: () -> Unit = {}

    override fun start() {
      started++
      startError?.let { throw it }
      recording = true
    }

    override fun isRecording() = recording

    override fun read(): Int {
      reads++
      return onRead()
    }

    override fun stop() {
      stopped++
      recording = false
      onStop()
    }

    override fun release() {
      released++
      onRelease()
    }
  }

  private class FakePort : GuestAudioCapturePort {
    var permission = true
    var creates = 0
    var createError: Exception? = null
    val record = FakeRecord()
    var now = 0L
    val workers = mutableListOf<() -> Unit>()
    val deadlines = mutableListOf<Pair<Long, () -> Unit>>()
    val events: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val readerExited = CountDownLatch(1)
    val awaitBounds = mutableListOf<Long>()
    var threadedReader = false
    var awaitResult = true

    override fun hasRecordAudioPermission() = permission

    override fun createRecord(): GuestAudioCaptureRecord {
      creates++
      createError?.let { throw it }
      return record
    }

    override fun nowMs() = now

    override fun launchReader(read: () -> Unit): GuestAudioCaptureReader {
      val worker = {
        try {
          read()
        } finally {
          events.add("reader-exit")
          readerExited.countDown()
        }
      }
      if (threadedReader) thread(isDaemon = true) { worker() } else workers.add(worker)
      return GuestAudioCaptureReader { timeoutMs ->
        awaitBounds.add(timeoutMs)
        if (threadedReader) readerExited.await(timeoutMs, TimeUnit.MILLISECONDS) else awaitResult
      }
    }

    override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
      val entry = now + delayMs to task
      deadlines.add(entry)
      return { deadlines.remove(entry) }
    }

    fun advance(ms: Long) {
      now += ms
      deadlines
        .toList()
        .filter { it.first <= now }
        .forEach {
          deadlines.remove(it)
          it.second()
        }
    }
  }

  private fun blockedReader(): Pair<FakePort, GuestAudioCaptureController> {
    val reading = CountDownLatch(1)
    val stopped = CountDownLatch(1)
    val port =
      FakePort().apply {
        threadedReader = true
        record.onRead = {
          reading.countDown()
          check(stopped.await(1, TimeUnit.SECONDS)) { "stop did not unblock read" }
          16
        }
        record.onStop = {
          events.add("stop")
          stopped.countDown()
        }
        record.onRelease = { events.add("release") }
      }
    val controller = GuestAudioCaptureController(port)
    assertEquals("running", controller.handle("start", "one"))
    assertTrue("reader did not enter read", reading.await(1, TimeUnit.SECONDS))
    return port to controller
  }

  @Test
  fun `stop waits for blocked reader exit before releasing record`() {
    val (port, controller) = blockedReader()
    assertEquals("stopped", controller.handle("stop", "one"))
    assertEquals(listOf("stop", "reader-exit", "release"), port.events.toList())
    assertEquals(0L, port.readerExited.count)
  }

  @Test
  fun `reader timeout is bounded recorded and still releases on stop and status`() {
    for (op in listOf("stop", "status")) {
      val port = FakePort().apply { awaitResult = false }
      val controller = GuestAudioCaptureController(port)
      controller.handle("start", "one")
      if (op == "status") port.record.recording = false
      assertEquals(
        "failed capture reader did not exit within 1000 ms",
        controller.handle(op, "one"),
      )
      assertEquals(listOf(1000L), port.awaitBounds)
      assertEquals(1, port.record.released)
      assertEquals(
        "failed capture reader did not exit within 1000 ms",
        controller.handle("status", "one"),
      )
    }
  }

  @Test
  fun `stop on another thread completes while read is blocked without deadlock`() {
    val (port, controller) = blockedReader()
    val finished = CountDownLatch(1)
    val result = AtomicReference<String>()
    val failure = AtomicReference<Throwable>()
    thread(isDaemon = true) {
      try {
        result.set(controller.handle("stop", "one"))
      } catch (error: Throwable) {
        failure.set(error)
      } finally {
        finished.countDown()
      }
    }
    assertTrue("stop deadlocked with the reader", finished.await(1, TimeUnit.SECONDS))
    assertEquals(null, failure.get())
    assertEquals("stopped", result.get())
    assertEquals(listOf("stop", "reader-exit", "release"), port.events.toList())
  }

  @Test
  fun `start creates starts and schedules draining`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    assertEquals("running", controller.handle("start", "one"))
    assertEquals(1, port.creates)
    assertEquals(1, port.record.started)
    assertEquals(1, port.workers.size)
  }

  @Test
  fun `permission is checked before record creation`() {
    val port = FakePort().apply { permission = false }
    assertEquals(
      "failed RECORD_AUDIO is not granted to CtrlProxy; reinstall the CtrlProxy APK",
      GuestAudioCaptureController(port).handle("start", "one"),
    )
    assertEquals(0, port.creates)
  }

  @Test
  fun `creation failure reports reason without a reader`() {
    val port = FakePort().apply { createError = IllegalStateException("cannot create record") }
    assertEquals(
      "failed cannot create record",
      GuestAudioCaptureController(port).handle("start", "one"),
    )
    assertTrue(port.workers.isEmpty())
  }

  @Test
  fun `start failure releases the created record`() {
    val port = FakePort().apply { record.startError = IllegalStateException("cannot start record") }
    assertEquals(
      "failed cannot start record",
      GuestAudioCaptureController(port).handle("start", "one"),
    )
    assertEquals(1, port.record.released)
    assertTrue(port.workers.isEmpty())
  }

  @Test
  fun `unsupported start releases the created record once and leaves no lease`() {
    val port =
      FakePort().apply { record.startError = UnsupportedOperationException("cannot start record") }
    val controller = GuestAudioCaptureController(port)
    assertEquals("failed cannot start record", controller.handle("start", "one"))
    assertEquals(1, port.creates)
    assertEquals(1, port.record.released)
    assertEquals("absent", controller.handle("stop", "one"))
    assertEquals(1, port.record.released)
    assertTrue(port.workers.isEmpty())
  }

  @Test
  fun `unsupported creation reports failure without a record or lease`() {
    val port =
      FakePort().apply { createError = UnsupportedOperationException("cannot create record") }
    val controller = GuestAudioCaptureController(port)
    assertEquals("failed cannot create record", controller.handle("start", "one"))
    assertEquals(1, port.creates)
    assertEquals(0, port.record.started)
    assertEquals(0, port.record.released)
    assertEquals("absent", controller.handle("status", "one"))
    assertTrue(port.workers.isEmpty())
  }

  @Test
  fun `unsupported read releases the lease once and next status reports failure`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    assertEquals("running", controller.handle("start", "one"))
    port.record.onRead = { throw UnsupportedOperationException("cannot read record") }
    port.workers.single()()
    assertEquals(1, port.record.reads)
    assertEquals(1, port.record.stopped)
    assertEquals(1, port.record.released)
    assertEquals("failed cannot read record", controller.handle("status", "one"))
    assertEquals("absent", controller.handle("status", "one"))
    assertEquals("absent", controller.handle("stop", "one"))
    port.workers.single()()
    assertEquals(1, port.record.reads)
    assertEquals(1, port.record.released)
    assertTrue(port.awaitBounds.isEmpty())
    assertTrue(port.deadlines.isEmpty())
  }

  @Test
  fun `another lease cannot replace the held lease`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    assertEquals("failed another guest capture is open", controller.handle("start", "two"))
    assertEquals("running", controller.handle("status", "one"))
    assertEquals(1, port.creates)
    assertEquals(0, port.record.released)
  }

  @Test
  fun `repeated start is idempotent and status checks lease identity`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    assertEquals("running", controller.handle("start", "one"))
    assertEquals("running", controller.handle("status", "one"))
    assertEquals("absent", controller.handle("status", "two"))
    assertEquals(1, port.creates)
  }

  @Test
  fun `stopped record fails status and releases once`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    port.record.recording = false
    assertEquals("failed record is not RECORDING", controller.handle("status", "one"))
    assertEquals(1, port.record.released)
    assertEquals("absent", controller.handle("stop", "one"))
  }

  @Test
  fun `read error releases the lease and next status reports failure`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    port.record.onRead = { -3 }
    port.workers.single()()
    assertEquals(1, port.record.reads)
    assertEquals(1, port.record.released)
    assertEquals("absent", controller.handle("status", "two"))
    assertEquals("failed capture read returned -3", controller.handle("status", "one"))
    assertEquals("absent", controller.handle("status", "one"))
  }

  @Test
  fun `stop releases once and a second stop is absent`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    assertEquals("stopped", controller.handle("stop", "one"))
    assertEquals("absent", controller.handle("stop", "one"))
    assertEquals(1, port.record.stopped)
    assertEquals(1, port.record.released)
    assertTrue(port.deadlines.isEmpty())
  }

  @Test
  fun `stop for a different lease cannot release the record`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    assertEquals("absent", controller.handle("stop", "two"))
    assertEquals(0, port.record.released)
  }

  @Test
  fun `62 minute lease survives 31 minutes and expires at its deadline`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    assertEquals("running", controller.handle("start", "one", 3_720_000L))
    port.advance(31 * 60 * 1000L)
    assertEquals("running", controller.handle("status", "one"))
    assertEquals(0, port.record.released)
    port.advance(31 * 60 * 1000L - 1)
    assertEquals(0, port.record.released)
    port.advance(1)
    assertEquals(1, port.record.released)
    assertEquals("absent", controller.handle("status", "one"))
  }

  @Test
  fun `absent timeout expires after 30 minutes`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    port.advance(30 * 60 * 1000L - 1)
    assertEquals("running", controller.handle("status", "one"))
    port.advance(1)
    assertEquals(1, port.record.released)
    assertEquals("absent", controller.handle("status", "one"))
  }

  @Test
  fun `invalid lease timeout is refused before creating a record`() {
    for (timeout in listOf(0L, -1L, 3_720_001L)) {
      val port = FakePort()
      val controller = GuestAudioCaptureController(port)
      assertEquals("failed invalid lease timeout", controller.handle("start", "one", timeout))
      assertEquals(0, port.creates)
      assertTrue(port.deadlines.isEmpty())
    }
  }

  @Test
  fun `clock expiry uses the held lease timeout before the callback runs`() {
    for (timeout in listOf(100L, 3_720_000L)) {
      val port = FakePort()
      val controller = GuestAudioCaptureController(port)
      controller.handle("start", "one", timeout)
      port.now = timeout - 1
      assertEquals("running", controller.handle("status", "one"))
      assertEquals(0, port.record.released)
      port.now = timeout
      assertEquals("absent", controller.handle("status", "one"))
      assertEquals(1, port.record.released)
      assertTrue(port.deadlines.isEmpty())
    }
  }

  @Test
  fun `repeated start ignores replacement timeout and keeps the original deadline`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one", 3_720_000L)
    port.advance(31 * 60 * 1000L)
    val deadline = port.deadlines.single().first
    for (replacement in listOf(100L, 0L, -1L, 3_720_001L)) {
      assertEquals("running", controller.handle("start", "one", replacement))
      assertEquals(deadline, port.deadlines.single().first)
    }
    assertEquals(1, port.creates)
    port.advance(31 * 60 * 1000L)
    assertEquals(1, port.record.released)
  }

  @Test
  fun `timeout releases even without a status call`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    port.advance(GUEST_AUDIO_CAPTURE_MAX_LEASE_MS + 1)
    assertEquals(1, port.record.released)
    assertEquals("absent", controller.handle("status", "one"))
    assertEquals("absent", controller.handle("stop", "one"))
  }

  @Test
  fun `clock expiry is enforced even before the scheduled callback runs`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    port.now = GUEST_AUDIO_CAPTURE_MAX_LEASE_MS + 1
    assertEquals("absent", controller.handle("status", "one"))
    assertEquals(1, port.record.released)
  }

  @Test
  fun `reader repeatedly drains until stop and never reads after stop`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    port.record.onRead = {
      if (port.record.reads == 4) controller.handle("stop", "one")
      16
    }
    port.workers.single()()
    assertEquals(4, port.record.reads)
    port.workers.single()()
    assertEquals(4, port.record.reads)
    assertFalse(port.record.recording)
  }

  @Test
  fun `reasons replace quotes and line breaks`() {
    val port =
      FakePort().apply { record.startError = IllegalStateException("bad \"record\"\r\nstate") }
    assertEquals(
      "failed bad  record   state",
      GuestAudioCaptureController(port).handle("start", "one"),
    )
  }

  @Test
  fun `queued reader and timeout from old lease cannot affect a new lease`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    val oldTimeout = port.deadlines.single().second
    controller.handle("stop", "one")
    controller.handle("start", "two")
    port.workers.first()()
    oldTimeout()
    assertEquals("running", controller.handle("status", "two"))
    assertEquals(0, port.record.reads)
    assertEquals(1, port.record.released)
  }

  @Test
  fun `read exception reports a sanitized failure and releases the record`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    port.record.onRead = { error("read \"failed\"\nagain") }
    port.workers.single()()
    assertEquals(1, port.record.released)
    assertEquals("failed read  failed  again", controller.handle("status", "one"))
  }

  @Test
  fun `read error racing with stop cannot fail the next lease`() {
    val port = FakePort()
    val controller = GuestAudioCaptureController(port)
    controller.handle("start", "one")
    port.record.onRead = {
      controller.handle("stop", "one")
      controller.handle("start", "two")
      -3
    }
    port.workers.first()()
    assertEquals("running", controller.handle("status", "two"))
    assertEquals(1, port.record.released)
  }
}
