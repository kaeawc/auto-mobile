package dev.jasonpearson.automobile.ctrlproxy

internal const val GUEST_AUDIO_CAPTURE_MAX_LEASE_MS = 30 * 60 * 1000L
private const val READER_EXIT_TIMEOUT_MS = 1000L

internal fun interface GuestAudioCaptureReader {
  /** Returns false when the reader has not exited within the supplied bound. */
  fun awaitExit(timeoutMs: Long): Boolean
}

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
  fun launchReader(read: () -> Unit): GuestAudioCaptureReader

  fun schedule(delayMs: Long, task: () -> Unit): () -> Unit
}

/** Process-local recording ownership. No Android API or real clock is needed by its tests. */
internal class GuestAudioCaptureController(private val port: GuestAudioCapturePort) {
  private class Lease(val id: String, val record: GuestAudioCaptureRecord, val startedAt: Long) {
    var cancelTimeout: (() -> Unit)? = null
    var reader: GuestAudioCaptureReader? = null
  }

  // Serializes callers through disposal; the reader never takes this lock.
  private val operations = Any()
  private var held: Lease? = null
  // A read failure releases the record immediately, but the owner must still see why it ended.
  private var failure: Pair<String, String>? = null

  fun handle(op: String?, leaseId: String?): String =
    synchronized(operations) {
      val disposals = mutableListOf<Lease>()
      val result =
        try {
          val expired =
            synchronized(this) {
              held
                ?.takeIf { port.nowMs() - it.startedAt >= GUEST_AUDIO_CAPTURE_MAX_LEASE_MS }
                ?.also { detach(it) }
            }
          expired
            ?.let { dispose(it) }
            ?.let {
              return@synchronized failed(it)
            }
          synchronized(this) {
            if (leaseId.isNullOrEmpty()) return@synchronized "absent"
            when (op) {
              "start" -> start(leaseId, disposals)
              "status" -> status(leaseId, disposals)
              "stop" -> stop(leaseId, disposals)
              else -> failed("unknown capture operation")
            }
          }
        } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
          // Port calls and timeout cancellation have no exception contract; preserve protocol
          // replies.
          failed(error.message ?: error.javaClass.simpleName)
        }
      try {
        val disposalFailure = disposals.firstNotNullOfOrNull { dispose(it) }
        if (disposalFailure == null) result else failed(disposalFailure)
      } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
        // AudioRecord teardown and reader await (including interruption) must become failed
        // replies.
        failed(error.message ?: error.javaClass.simpleName)
      }
    }

  private fun start(id: String, disposals: MutableList<Lease>): String {
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
          synchronized(operations) {
            val expired =
              synchronized(this) {
                if (held === lease) lease.also { detach(it) } else null
              }
            expired?.let { dispose(it) }
          }
        }
      lease.reader = port.launchReader { drain(lease) }
      return "running"
    } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
      // Record creation/start and port scheduling can throw unspecified exceptions; retain cleanup.
      val lease = held
      if (lease != null) {
        detach(lease)
        disposals.add(lease)
      } else if (record != null) {
        disposals.add(Lease(id, record, port.nowMs()))
      }
      return failed(error.message ?: error.javaClass.simpleName)
    }
  }

  private fun status(id: String, disposals: MutableList<Lease>): String {
    val lease = held
    if (lease?.id == id) {
      val reason =
        try {
          if (lease.record.isRecording()) return "running"
          "record is not RECORDING"
        } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
          // The record port has no exception contract; report any failure and release its lease.
          error.message ?: error.javaClass.simpleName
        }
      detach(lease)
      disposals.add(lease)
      return failed(reason)
    }
    val ended = failure
    if (ended?.first == id) {
      failure = null
      return failed(ended.second)
    }
    return "absent"
  }

  private fun stop(id: String, disposals: MutableList<Lease>): String {
    val lease = held
    return if (lease?.id != id) {
      if (failure?.first == id) failure = null
      "absent"
    } else {
      detach(lease)
      disposals.add(lease)
      "stopped"
    }
  }

  private fun drain(lease: Lease) {
    while (synchronized(this) { held === lease }) {
      val reason =
        try {
          val count = lease.record.read()
          if (count < 0) "capture read returned $count" else null
        } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
          // The record port may throw unspecified exceptions; the owner must see why reading ended.
          error.message ?: error.javaClass.simpleName
        }
      if (reason != null) {
        synchronized(this) {
          // A stop can unblock a read with an error; it must not fail or release a newer lease.
          if (held === lease) {
            failure = lease.id to reason
            detach(lease)
            // The final read has returned. Keep ownership serialized, but never await ourselves.
            dispose(lease, awaitReader = false)
          }
        }
        return
      }
    }
  }

  /** Detach under the state monitor; any reader await must happen outside it. */
  private fun detach(lease: Lease) {
    held = null
    lease.cancelTimeout?.invoke()
  }

  private fun dispose(lease: Lease, awaitReader: Boolean = true): String? {
    var reason: String? = null
    try {
      lease.record.stop()
    } finally {
      try {
        if (awaitReader && lease.reader?.awaitExit(READER_EXIT_TIMEOUT_MS) == false) {
          reason = "capture reader did not exit within $READER_EXIT_TIMEOUT_MS ms"
          synchronized(this) {
            if (held == null) failure = lease.id to requireNotNull(reason)
          }
        }
      } finally {
        lease.record.release()
      }
    }
    return reason
  }

  private fun failed(reason: String): String =
    "failed " + reason.replace('"', ' ').replace('\r', ' ').replace('\n', ' ')
}
