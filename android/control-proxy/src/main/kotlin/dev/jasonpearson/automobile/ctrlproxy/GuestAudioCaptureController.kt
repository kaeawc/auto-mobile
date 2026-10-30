package dev.jasonpearson.automobile.ctrlproxy

import java.util.concurrent.RejectedExecutionException

internal const val GUEST_AUDIO_CAPTURE_DEFAULT_LEASE_MS = 30 * 60 * 1000L
internal const val GUEST_AUDIO_CAPTURE_MAX_LEASE_MS = 3_720_000L
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
  private class Lease(
    val id: String,
    val record: GuestAudioCaptureRecord,
    val startedAt: Long,
    val maxLeaseMs: Long,
  ) {
    var cancelTimeout: (() -> Unit)? = null
    var reader: GuestAudioCaptureReader? = null
  }

  // Serializes callers through disposal; the reader never takes this lock.
  private val operations = Any()
  private var held: Lease? = null
  // A read failure releases the record immediately, but the owner must still see why it ended.
  private var failure: Pair<String, String>? = null

  fun handle(op: String?, leaseId: String?, leaseTimeoutMs: Long? = null): String =
    synchronized(operations) {
      val disposals = mutableListOf<Lease>()
      val result = replySafely {
        expireLease()
          ?.let { dispose(it) }
          ?.let {
            return@replySafely failed(it)
          }
        synchronized(this) { dispatch(op, leaseId, leaseTimeoutMs, disposals) }
      }
      replySafely {
        val disposalFailure = disposals.firstNotNullOfOrNull { dispose(it) }
        if (disposalFailure == null) result else failed(disposalFailure)
      }
    }

  private fun expireLease(): Lease? =
    synchronized(this) {
      held?.takeIf { port.nowMs() - it.startedAt >= it.maxLeaseMs }?.also { detach(it) }
    }

  private fun dispatch(
    op: String?,
    leaseId: String?,
    leaseTimeoutMs: Long?,
    disposals: MutableList<Lease>,
  ): String {
    if (leaseId.isNullOrEmpty()) return "absent"
    return when (op) {
      "start" -> start(leaseId, leaseTimeoutMs, disposals)
      "status" -> status(leaseId, disposals)
      "stop" -> stop(leaseId, disposals)
      else -> failed("unknown capture operation")
    }
  }

  private fun stop(id: String, disposals: MutableList<Lease>): String {
    val lease = held
    if (lease?.id != id) {
      if (failure?.first == id) failure = null
      return "absent"
    }
    detach(lease)
    disposals.add(lease)
    return "stopped"
  }

  // Ordered broadcast replies must remain failures even for unexpected port exceptions.
  @Suppress("TooGenericExceptionCaught")
  private fun replySafely(reply: () -> String): String =
    try {
      reply()
    } catch (error: Exception) {
      failed(error.message ?: error.javaClass.simpleName)
    }

  private fun start(id: String, leaseTimeoutMs: Long?, disposals: MutableList<Lease>): String {
    if (!port.hasRecordAudioPermission()) {
      return failed("RECORD_AUDIO is not granted to CtrlProxy; reinstall the CtrlProxy APK")
    }
    held?.let {
      return if (it.id == id) "running" else failed("another guest capture is open")
    }
    val maxLeaseMs = leaseTimeoutMs ?: GUEST_AUDIO_CAPTURE_DEFAULT_LEASE_MS
    if (maxLeaseMs !in 1..GUEST_AUDIO_CAPTURE_MAX_LEASE_MS) return failed("invalid lease timeout")
    failure = null
    var record: GuestAudioCaptureRecord? = null
    val reason = captureFailure {
      val created = port.createRecord()
      record = created
      created.start()
      check(created.isRecording()) { "record is not RECORDING" }
      val lease = Lease(id, created, port.nowMs(), maxLeaseMs)
      held = lease
      lease.cancelTimeout =
        port.schedule(lease.maxLeaseMs) {
          synchronized(operations) {
            val expired =
              synchronized(this) {
                if (held === lease) lease.also { detach(it) } else null
              }
            expired?.let { dispose(it) }
          }
        }
      lease.reader = port.launchReader { drain(lease) }
    }
    if (reason == null) return "running"
    val lease = held
    if (lease != null) {
      detach(lease)
      disposals.add(lease)
    } else {
      record?.let { disposals.add(Lease(id, it, port.nowMs(), maxLeaseMs)) }
    }
    return failed(reason)
  }

  private fun status(id: String, disposals: MutableList<Lease>): String {
    val lease = held
    if (lease?.id == id) {
      val reason =
        captureFailure {
          check(lease.record.isRecording()) { "record is not RECORDING" }
        } ?: return "running"
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

  private fun drain(lease: Lease) {
    while (synchronized(this) { held === lease }) {
      val reason = captureFailure {
        val count = lease.record.read()
        check(count >= 0) { "capture read returned $count" }
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

private fun captureFailure(operation: () -> Unit): String? =
  try {
    operation()
    null
  } catch (error: IllegalStateException) {
    error.message ?: error.javaClass.simpleName
  } catch (error: IllegalArgumentException) {
    error.message ?: error.javaClass.simpleName
  } catch (error: SecurityException) {
    error.message ?: error.javaClass.simpleName
  } catch (error: RejectedExecutionException) {
    error.message ?: error.javaClass.simpleName
  }
