package dev.jasonpearson.automobile.ctrlproxy

internal const val GUEST_AUDIO_CAPTURE_MAX_LEASE_MS = 30 * 60 * 1000L

internal interface GuestAudioCaptureRecord {
  fun start()

  fun isRecording(): Boolean

  /** Blocking read on the reader thread only; PCM is discarded. */
  fun read(): Int

  fun stop()

  fun release()
}

internal interface GuestAudioCapturePort {
  fun hasRecordAudioPermission(): Boolean

  fun createRecord(): GuestAudioCaptureRecord

  fun nowMs(): Long

  /** Enqueues work without waiting for it to finish. */
  fun launchReader(read: () -> Unit)

  fun schedule(delayMs: Long, task: () -> Unit): () -> Unit
}

/** Process-local recording ownership. No Android API or real clock is needed by its tests. */
internal class GuestAudioCaptureController(private val port: GuestAudioCapturePort) {
  private class Lease(val id: String, val record: GuestAudioCaptureRecord, val startedAt: Long) {
    var cancelTimeout: (() -> Unit)? = null
  }

  private var held: Lease? = null
  // A read failure releases the record immediately, but the owner must still see why it ended.
  private var failure: Pair<String, String>? = null

  @Synchronized
  fun handle(op: String?, leaseId: String?): String {
    return try {
      expire()
      if (leaseId.isNullOrEmpty()) return "absent"
      when (op) {
        "start" -> start(leaseId)
        "status" -> status(leaseId)
        "stop" -> {
          if (held?.id != leaseId) {
            if (failure?.first == leaseId) failure = null
            "absent"
          } else {
            release(requireNotNull(held))
            "stopped"
          }
        }
        else -> failed("unknown capture operation")
      }
    } catch (error: Exception) {
      failed(error.message ?: error.javaClass.simpleName)
    }
  }

  private fun start(id: String): String {
    if (!port.hasRecordAudioPermission()) {
      return failed("RECORD_AUDIO is not granted to CtrlProxy; reinstall the CtrlProxy APK")
    }
    held?.let {
      return if (it.id == id) "running" else failed("another guest capture is open")
    }
    failure = null
    var record: GuestAudioCaptureRecord? = null
    try {
      record = port.createRecord()
      record.start()
      check(record.isRecording()) { "record is not RECORDING" }
      val lease = Lease(id, record, port.nowMs())
      held = lease
      lease.cancelTimeout =
        port.schedule(GUEST_AUDIO_CAPTURE_MAX_LEASE_MS) {
          synchronized(this) {
            if (held === lease) release(lease)
          }
        }
      port.launchReader { drain(lease) }
      return "running"
    } catch (error: Exception) {
      val lease = held
      if (lease != null) release(lease) else if (record != null) dispose(record)
      return failed(error.message ?: error.javaClass.simpleName)
    }
  }

  private fun status(id: String): String {
    val lease = held
    if (lease?.id == id) {
      val reason =
        try {
          if (lease.record.isRecording()) return "running"
          "record is not RECORDING"
        } catch (error: Exception) {
          error.message ?: error.javaClass.simpleName
        }
      release(lease)
      return failed(reason)
    }
    val ended = failure
    if (ended?.first == id) {
      failure = null
      return failed(ended.second)
    }
    return "absent"
  }

  private fun drain(lease: Lease) {
    while (synchronized(this) { held === lease }) {
      val reason =
        try {
          val count = lease.record.read()
          if (count < 0) "capture read returned $count" else null
        } catch (error: Exception) {
          error.message ?: error.javaClass.simpleName
        }
      if (reason != null) {
        synchronized(this) {
          // A stop can unblock a read with an error; it must not fail or release a newer lease.
          if (held === lease) {
            failure = lease.id to reason
            release(lease)
          }
        }
        return
      }
    }
  }

  private fun expire() {
    held?.let { if (port.nowMs() - it.startedAt >= GUEST_AUDIO_CAPTURE_MAX_LEASE_MS) release(it) }
  }

  private fun release(lease: Lease) {
    held = null
    lease.cancelTimeout?.invoke()
    dispose(lease.record)
  }

  private fun dispose(record: GuestAudioCaptureRecord) {
    try {
      record.stop()
    } finally {
      record.release()
    }
  }

  private fun failed(reason: String): String =
    "failed " + reason.replace('"', ' ').replace('\r', ' ').replace('\n', ' ')
}
