package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import java.io.DataInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.Channels
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.util.concurrent.Executor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable

internal interface AttachJournal {
  fun load(): AttachJournalState?

  fun save(state: AttachJournalState)
}

internal data class AttachJournalState(
  val appInstanceId: String,
  val showing: Long,
  val lastSequence: Long,
  val dropped: Long,
  val pending: List<PrototypeEvent>,
)

internal object NoAttachJournal : AttachJournal {
  override fun load(): AttachJournalState? = null

  override fun save(state: AttachJournalState) = Unit
}

/**
 * Saves journal snapshots on [executor], never on the recording thread. A write always saves the
 * newest snapshot, so saves stay in order and a burst costs one rewrite. Each snapshot gets a
 * version; [awaitSaved] lets delivery hold a frame until the write of the state it exposes
 * finishes, whether it saved or failed and was logged, so a failed write releases the frame rather
 * than stalling delivery. Only a successful write guarantees a restored process never reissues a
 * sequence the host has seen.
 */
internal class AttachJournalWriter(
  private val journal: AttachJournal,
  private val executor: Executor,
  private val log: (String) -> Unit = {},
) {
  private val lock = Any()
  private var unsaved: AttachJournalState? = null
  private var recorded = 0L
  private var flushWanted = false
  private var draining = false
  private val saved = MutableStateFlow(0L)

  val version: Long
    get() = synchronized(lock) { recorded }

  /** Records [state]; [flush] schedules a write, otherwise the next flush or await carries it. */
  fun record(state: AttachJournalState, flush: Boolean) {
    val start =
      synchronized(lock) {
        unsaved = state
        recorded++
        if (flush) flushWanted = true
        claimDrain()
      }
    if (start) executor.execute(::drain)
  }

  suspend fun awaitSaved(version: Long) {
    if (saved.value >= version) return
    val start =
      synchronized(lock) {
        // With nothing unsaved, the version is already being written.
        if (unsaved != null) flushWanted = true
        claimDrain()
      }
    if (start) executor.execute(::drain)
    saved.first { it >= version }
  }

  // Call while holding lock.
  private fun claimDrain(): Boolean {
    if (!flushWanted || draining || unsaved == null) return false
    draining = true
    return true
  }

  private fun drain() {
    while (true) {
      val (state, through) =
        synchronized(lock) {
          val next = unsaved
          if (!flushWanted || next == null) {
            flushWanted = false
            draining = false
            return
          }
          flushWanted = false
          unsaved = null
          next to recorded
        }
      // FileAttachJournal logs a failed save; delivery continues rather than stalling forever.
      saveLogged(state)
      saved.update { maxOf(it, through) }
    }
  }

  // An unexpected failure must not leave draining set, which would hold every later frame.
  @Suppress("TooGenericExceptionCaught") // Any journal failure shares this recovery boundary.
  private fun saveLogged(state: AttachJournalState) {
    try {
      journal.save(state)
    } catch (error: RuntimeException) {
      // Name only the type: the message may carry event payload.
      log("Could not save attach journal: ${error.javaClass.simpleName}")
    }
  }
}

/**
 * [install] identifies the installed build (Android: the package's last update time). `adb install
 * -r` keeps app storage, so a journal written under another install is discarded, never replayed.
 */
internal class FileAttachJournal(
  file: File,
  private val install: String,
  private val log: (String) -> Unit,
  private val maxBytes: Int = MAX_BYTES,
) : AttachJournal {
  private val target = file.absoluteFile
  private val temp = target.resolveSibling("${target.name}.tmp")

  @Synchronized
  override fun load(): AttachJournalState? =
    try {
      val document = attachJson.decodeFromString(JournalDocument.serializer(), readDocument())
      if (document.install == install) document.toState()
      else {
        log("Attach journal belongs to an earlier install; starting fresh")
        null
      }
    } catch (_: NoSuchFileException) {
      null // An install that has never saved state has no journal yet.
    } catch (_: IOException) {
      log("Attach journal is unreadable or exceeds its size limit")
      null
    } catch (_: IllegalArgumentException) {
      log("Attach journal is corrupt")
      null
    } catch (_: SecurityException) {
      log("Attach journal is unreadable")
      null
    }

  private fun readDocument(): String =
    Files.newByteChannel(target.toPath()).use { channel ->
      val size = channel.size()
      if (size > maxBytes) throw IOException("Attach journal exceeds its size limit")
      val bytes = ByteArray(size.toInt())
      DataInputStream(Channels.newInputStream(channel)).readFully(bytes)
      Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
    }

  @Synchronized
  override fun save(state: AttachJournalState) {
    try {
      replace(encodeFitting(state))
    } catch (_: IOException) {
      log("Could not save attach journal")
    } catch (_: IllegalArgumentException) {
      log("Could not encode attach journal")
    } catch (_: SecurityException) {
      log("Could not write attach journal")
    }
  }

  /**
   * Evicts the oldest pending events, counted as dropped, until the snapshot fits, so the sequence
   * counter is always saved: a restored counter below the host cursor would fail its hello ack.
   */
  private fun encodeFitting(state: AttachJournalState): ByteArray {
    var pending = state.pending.takeLast(AppAttachAgent.MAX_PENDING_EVENTS)
    var bytes = encode(state, pending, state.pending.size - pending.size)
    if (bytes.size > maxBytes && pending.isNotEmpty()) {
      // Estimate from per-event sizes so a large queue costs a few encodes, not one per event.
      val excess = bytes.size - maxBytes
      // Each event also frees its separating comma.
      val freed = pending.map { encodeEvent(it).size + 1 }.runningReduce(Int::plus)
      val evict = freed.indexOfFirst { it >= excess } + 1
      pending = pending.drop(if (evict == 0) pending.size else evict)
      bytes = encode(state, pending, state.pending.size - pending.size)
      while (bytes.size > maxBytes && pending.isNotEmpty()) {
        pending = pending.drop(1)
        bytes = encode(state, pending, state.pending.size - pending.size)
      }
    }
    if (bytes.size > maxBytes) throw IOException("Attach journal exceeds its size limit")
    if (pending.size < state.pending.size) {
      log(
        "Attach journal dropped ${state.pending.size - pending.size} oldest pending events to fit",
      )
    }
    return bytes
  }

  private fun encode(state: AttachJournalState, pending: List<PrototypeEvent>, evicted: Int) =
    attachJson
      .encodeToString(
        JournalDocument.serializer(),
        JournalDocument(
          install,
          state.appInstanceId,
          state.showing,
          state.lastSequence,
          state.dropped + evicted,
          pending,
        ),
      )
      .toByteArray(Charsets.UTF_8)

  private fun encodeEvent(event: PrototypeEvent) =
    attachJson.encodeToString(WebSocketResponse.serializer(), event).toByteArray(Charsets.UTF_8)

  private fun replace(bytes: ByteArray) {
    try {
      FileOutputStream(temp).use {
        it.write(bytes)
        it.fd.sync()
      }
      Files.move(temp.toPath(), target.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
    } finally {
      Files.deleteIfExists(temp.toPath())
    }
  }

  // The sealed response serializer gives each event the same discriminator and encoding as on wire.
  @Serializable
  private data class JournalDocument(
    val install: String,
    val appInstanceId: String,
    val showing: Long,
    val lastSequence: Long,
    val dropped: Long,
    val pending: List<WebSocketResponse>,
  ) {
    fun toState(): AttachJournalState {
      require(appInstanceId.isNotBlank())
      require(showing >= 0 && lastSequence >= 0 && dropped >= 0)
      require(pending.size <= AppAttachAgent.MAX_PENDING_EVENTS)
      val events = pending.map { response ->
        require(response is PrototypeEvent && response.sequence in 1..lastSequence)
        response
      }
      return AttachJournalState(appInstanceId, showing, lastSequence, dropped, events)
    }
  }

  companion object {
    const val MAX_BYTES = 4 * 1024 * 1024
  }
}
