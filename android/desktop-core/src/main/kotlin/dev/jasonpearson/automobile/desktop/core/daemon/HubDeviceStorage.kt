package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** One lease's storage intent and its lossless, unicast storage flows. */
internal class LeaseStorage {
  // Guarded by the owning [HubDeviceStorage]'s lock.
  val files = LinkedHashSet<StorageSubscriptionKey>()

  val updates = Channel<StorageStreamUpdate>(Channel.UNLIMITED)
  val responses = Channel<StorageSubscriptionResponse>(Channel.UNLIMITED)
  val reconciliations = Channel<StorageSubscriptionKey>(Channel.UNLIMITED)

  fun close() {
    updates.close()
    responses.close()
    reconciliations.close()
  }
}

/**
 * One device's storage traffic on the hub's shared [stream], fanned out per lease (#17012). Each
 * `(package, file)` is ref-counted across the device's leases: the first lease that asks subscribes
 * the shared stream and the last one to let go unsubscribes it. Updates, acknowledgements and
 * reconciliation requests for a file reach only the leases holding it.
 *
 * A lease that joins a file the shared stream has confirmed is acknowledged at once, so it
 * reconciles its snapshot as it would after its own subscribe; one that joins while the subscribe
 * is in flight gets that acknowledgement too. A file whose registration failed is registered again
 * by the next lease that asks for it. A dropped connection forgets every confirmation and failure:
 * the stream re-registers its files after reconnecting and acknowledges every holder again. They
 * are forgotten on every reconnect call as well, since a conflated connection state can skip the
 * drop, and no joining lease is acknowledged from a confirmation while the stream is not connected.
 *
 * Routing starts with the device's first storage subscription, so a device without one pays
 * nothing.
 */
internal class HubDeviceStorage(
  private val stream: ObservationStream,
  private val scope: CoroutineScope,
  private val newRequestId: () -> String,
) {
  private enum class Join {
    Subscribe,
    Retry,
    Acknowledge,
    Await,
  }

  // Every field below is guarded by [lock].
  private val lock = Any()
  private val holders = HashMap<StorageSubscriptionKey, LinkedHashSet<LeaseStorage>>()
  private val confirmed = HashSet<StorageSubscriptionKey>()
  private val failed = HashSet<StorageSubscriptionKey>()
  private var routing: Job? = null

  fun subscribe(lease: LeaseStorage, file: StorageSubscriptionKey) {
    val join =
      synchronized(lock) {
        if (!lease.files.add(file)) return
        if (routing == null) routing = scope.launch { route() }
        val fileHolders = holders.getOrPut(file) { LinkedHashSet() }
        fileHolders.add(lease)
        when {
          fileHolders.size == 1 -> Join.Subscribe
          failed.remove(file) -> Join.Retry
          file in confirmed && stream.isConnected() -> Join.Acknowledge
          else -> Join.Await
        }
      }
    when (join) {
      Join.Subscribe -> stream.subscribeStorage(file.packageName, file.fileName)
      // The stream does not retry an unchanged failed registration; re-stating the intent does.
      Join.Retry -> {
        stream.unsubscribeStorage(file.packageName, file.fileName)
        stream.subscribeStorage(file.packageName, file.fileName)
      }
      Join.Acknowledge ->
        lease.responses.trySend(
          StorageSubscriptionResponse(newRequestId(), file, subscribe = true, success = true),
        )
      Join.Await -> Unit
    }
  }

  fun unsubscribe(lease: LeaseStorage, file: StorageSubscriptionKey) {
    val last =
      synchronized(lock) {
        if (!lease.files.remove(file)) return
        drop(lease, file)
      }
    if (last) stream.unsubscribeStorage(file.packageName, file.fileName)
  }

  /**
   * [lease] leaves: unsubscribe the files only it held, unless [streamDisposed] (disposing the
   * stream releases them all), and end its flows.
   */
  fun release(lease: LeaseStorage, streamDisposed: Boolean) {
    val unwanted =
      synchronized(lock) {
        lease.files.filter { drop(lease, it) }.also { lease.files.clear() }
      }
    lease.close()
    if (streamDisposed) {
      synchronized(lock) { routing }?.cancel()
      return
    }
    unwanted.forEach { stream.unsubscribeStorage(it.packageName, it.fileName) }
  }

  /** The shared stream's connection moved to [state]. */
  fun connectionChanged(state: ConnectionState) {
    if (state !is ConnectionState.Connected) connectionReset()
  }

  /**
   * The shared stream is (re)connecting: its earlier registrations are gone, whether or not a
   * collected connection state showed the drop.
   */
  fun connectionReset() {
    synchronized(lock) {
      confirmed.clear()
      failed.clear()
    }
  }

  // Called under [lock]; true when [lease] was [file]'s last holder.
  private fun drop(lease: LeaseStorage, file: StorageSubscriptionKey): Boolean {
    val fileHolders = holders[file] ?: return false
    fileHolders.remove(lease)
    if (fileHolders.isNotEmpty()) return false
    holders.remove(file)
    failed.remove(file)
    return true
  }

  private suspend fun route() = coroutineScope {
    launch {
      stream.storageUpdates.collect { update ->
        val file = StorageSubscriptionKey(update.packageName, update.fileName)
        holdersOf(file).forEach { it.updates.trySend(update) }
      }
    }
    launch { stream.storageSubscriptionResponses.collect(::acknowledged) }
    launch {
      stream.storageReconciliationRequests.collect { file ->
        holdersOf(file).forEach { it.reconciliations.trySend(file) }
      }
    }
  }

  private fun acknowledged(response: StorageSubscriptionResponse) {
    val file = response.key
    val recipients =
      synchronized(lock) {
        when {
          // The stream drops acknowledgements from an earlier connection; one that arrives while
          // the stream is down still confirms nothing.
          response.subscribe && response.success ->
            failed.remove(file).also { if (stream.isConnected()) confirmed.add(file) }
          response.subscribe -> confirmed.remove(file).also { failed.add(file) }
          response.success -> confirmed.remove(file)
        }
        // An unsubscribe's acknowledgement answers a lease that has already let go.
        if (response.subscribe) holders[file]?.toList() else null
      }
    recipients?.forEach { it.responses.trySend(response) }
  }

  private fun holdersOf(file: StorageSubscriptionKey): List<LeaseStorage> =
    synchronized(lock) { holders[file]?.toList().orEmpty() }
}
