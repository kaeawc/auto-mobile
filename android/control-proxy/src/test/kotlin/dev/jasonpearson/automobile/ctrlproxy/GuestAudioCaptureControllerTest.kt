package dev.jasonpearson.automobile.ctrlproxy

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
    var startError: String? = null
    var onRead: () -> Int = { 16 }

    override fun start() {
      started++
      startError?.let { error(it) }
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
    }

    override fun release() {
      released++
    }
  }

  private class FakePort : GuestAudioCapturePort {
    var permission = true
    var creates = 0
    var createError: String? = null
    val record = FakeRecord()
    var now = 0L
    val workers = mutableListOf<() -> Unit>()
    val deadlines = mutableListOf<Pair<Long, () -> Unit>>()

    override fun hasRecordAudioPermission() = permission

    override fun createRecord(): GuestAudioCaptureRecord {
      creates++
      createError?.let { error(it) }
      return record
    }

    override fun nowMs() = now

    override fun launchReader(read: () -> Unit) {
      workers.add(read)
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
    val port = FakePort().apply { createError = "cannot create record" }
    assertEquals(
      "failed cannot create record",
      GuestAudioCaptureController(port).handle("start", "one"),
    )
    assertTrue(port.workers.isEmpty())
  }

  @Test
  fun `start failure releases the created record`() {
    val port = FakePort().apply { record.startError = "cannot start record" }
    assertEquals(
      "failed cannot start record",
      GuestAudioCaptureController(port).handle("start", "one"),
    )
    assertEquals(1, port.record.released)
    assertTrue(port.workers.isEmpty())
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
    val port = FakePort().apply { record.startError = "bad \"record\"\r\nstate" }
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
