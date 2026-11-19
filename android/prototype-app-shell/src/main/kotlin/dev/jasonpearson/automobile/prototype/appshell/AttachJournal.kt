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

internal class FileAttachJournal(file: File, private val log: (String) -> Unit) : AttachJournal {
  private val target = file.absoluteFile
  private val temp = target.resolveSibling("${target.name}.tmp")

  @Synchronized
  override fun load(): AttachJournalState? =
    try {
      val document = attachJson.decodeFromString(JournalDocument.serializer(), readDocument())
      document.toState()
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
