package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.os.UserManager
import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import java.io.File
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/** Credential-encrypted app-private root shared by saving and shortcut publishing. */
fun savedPrototypeRoot(context: Context): File = File(context.filesDir, "saved-prototypes")

fun interface SavedPrototypeEventDelivery {
  /** True only after the connected host accepted the event; false keeps it for later replay. */
  fun deliver(event: PrototypeEvent): Boolean
}

/** Process-level hand-off. Replay must serialize drain/restore on [buffer], like [send]. */
object SavedPrototypeEvents {
  val buffer = PrototypeOfflineEventBuffer()
  @Volatile var delivery: SavedPrototypeEventDelivery? = null
  private val sequences = mutableMapOf<String, Long>()

  /**
   * Activity recreation and document relaunch never rewind a prototype's process-level sequence.
   */
  fun nextSequence(id: String): Long =
    synchronized(buffer) {
      val next = (sequences[id] ?: 0L) + 1
      sequences[id] = next
      next
    }

  internal fun reset() =
    synchronized(buffer) {
      delivery = null
      buffer.drain()
      sequences.clear()
    }

  fun send(event: PrototypeEvent) =
    synchronized(buffer) {
      val delivered =
        try {
          delivery?.deliver(event) == true
        } catch (error: Exception) {
          Log.w("SavedPrototypeActivity", "Saved prototype event delivery failed", error)
          false
        }
      if (!delivered) buffer.add(event)
    }
}

internal object SavedPrototypeActivityDependencies {
  /** Where the values a saved prototype's `storage` block keeps live (#12522). */
  @Volatile
  var storageStore: (Context) -> PrototypeStorageStore = {
    PrototypeStorageStores.inDirectory(prototypeStorageRoot(it.filesDir))
  }
  @Volatile
  var store: (Context) -> SavedPrototypeStore = {
    SavedPrototypeStores.inDirectory(savedPrototypeRoot(it))
  }
  @Volatile
  var isUserUnlocked: (Context) -> Boolean = {
    it.getSystemService(UserManager::class.java)?.isUserUnlocked == true
  }
  @Volatile var ioDispatcher: CoroutineDispatcher = Dispatchers.IO
  @Volatile var clock: () -> Long = System::currentTimeMillis
  @Volatile var eventSink: PrototypeEventSink = PrototypeEventSink { SavedPrototypeEvents.send(it) }

  fun reset() {
    storageStore = { PrototypeStorageStores.inDirectory(prototypeStorageRoot(it.filesDir)) }
    store = { SavedPrototypeStores.inDirectory(savedPrototypeRoot(it)) }
    isUserUnlocked = { it.getSystemService(UserManager::class.java)?.isUserUnlocked == true }
    ioDispatcher = Dispatchers.IO
    clock = System::currentTimeMillis
    eventSink = PrototypeEventSink { SavedPrototypeEvents.send(it) }
  }
}
