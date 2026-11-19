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
 * version; [awaitSaved] lets delivery hold a frame until the state it exposes is on disk, so a
 * restored process never reissues a sequence the host has seen.
 */
internal class AttachJournalWriter(
  private val journal: AttachJournal,
  private val executor: Executor,
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
      journal.save(state)
      saved.update { maxOf(it, through) }
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
      if (size > MAX_BYTES) throw IOException("Attach journal exceeds its size limit")
      val bytes = ByteArray(size.toInt())
      DataInputStream(Channels.newInputStream(channel)).readFully(bytes)
      Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
    }

  @Synchronized
  override fun save(state: AttachJournalState) {
    try {
      val document =
        JournalDocument(
          install,
          state.appInstanceId,
          state.showing,
          state.lastSequence,
          state.dropped,
          state.pending,
        )
      val bytes =
        attachJson
          .encodeToString(JournalDocument.serializer(), document)
          .toByteArray(Charsets.UTF_8)
      if (bytes.size > MAX_BYTES || state.pending.size > AppAttachAgent.MAX_PENDING_EVENTS) {
        throw IOException("Attach journal exceeds its size limit")
      }
      replace(bytes)
    } catch (_: IOException) {
      log("Could not save attach journal")
    } catch (_: IllegalArgumentException) {
      log("Could not encode attach journal")
    } catch (_: SecurityException) {
      log("Could not write attach journal")
    }
  }

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
