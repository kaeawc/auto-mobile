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
  var store: (Context) -> SavedPrototypeStore = {
    SavedPrototypeStores.inDirectory(savedPrototypeRoot(it))
  }
  var isUserUnlocked: (Context) -> Boolean = {
    it.getSystemService(UserManager::class.java)?.isUserUnlocked == true
  }
  var ioDispatcher: CoroutineDispatcher = Dispatchers.IO
  var clock: () -> Long = System::currentTimeMillis
  var eventSink: PrototypeEventSink = PrototypeEventSink { SavedPrototypeEvents.send(it) }

  fun reset() {
    store = { SavedPrototypeStores.inDirectory(savedPrototypeRoot(it)) }
    isUserUnlocked = { it.getSystemService(UserManager::class.java)?.isUserUnlocked == true }
    ioDispatcher = Dispatchers.IO
    clock = System::currentTimeMillis
    eventSink = PrototypeEventSink { SavedPrototypeEvents.send(it) }
  }
}
