package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.os.UserManager
import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import java.io.File
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient

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

  /** Outlives any one activity: the last storage flush of a stopped activity runs here. */
  @Volatile var flushScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  @Volatile var clock: () -> Long = System::currentTimeMillis

  /**
   * The transports behind a saved prototype's `request` actions. `via: "device"` calls from the
   * device itself; `via: "host"` needs the live CtrlProxy socket, which a standalone activity does
   * not reach, so it fails as a typed `network` error that says what to do instead.
   */
  @Volatile var httpClients: () -> PrototypeHttpClients = { defaultHttpClients() }
  @Volatile var eventSink: PrototypeEventSink = PrototypeEventSink { SavedPrototypeEvents.send(it) }

  fun reset() {
    storageStore = { PrototypeStorageStores.inDirectory(prototypeStorageRoot(it.filesDir)) }
    store = { SavedPrototypeStores.inDirectory(savedPrototypeRoot(it)) }
    isUserUnlocked = { it.getSystemService(UserManager::class.java)?.isUserUnlocked == true }
    ioDispatcher = Dispatchers.IO
    flushScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    clock = System::currentTimeMillis
    httpClients = { defaultHttpClients() }
    eventSink = PrototypeEventSink { SavedPrototypeEvents.send(it) }
  }
}

internal const val SAVED_PROTOTYPE_HOST_UNAVAILABLE =
  "The host request proxy is not available for a saved prototype; use via \"device\"."

private val sharedOkHttp by lazy { OkHttpClient() }

private fun defaultHttpClients() =
  PrototypeHttpClients(
    host =
      PrototypeHttpClient {
        PrototypeRequestResponse.Failed(
          PrototypeRequestError(
            PrototypeRequestErrorCode.NETWORK,
            SAVED_PROTOTYPE_HOST_UNAVAILABLE,
          ),
        )
      },
    device = RetrofitPrototypeHttpClient(sharedOkHttp),
  )
