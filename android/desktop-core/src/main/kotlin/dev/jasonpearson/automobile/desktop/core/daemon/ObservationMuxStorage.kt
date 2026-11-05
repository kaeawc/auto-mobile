package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.logging.Logger

/**
 * Storage observers on the multiplexed observation socket. Each device stream keeps its own
 * [StorageSubscriptionLedger]; commands name the device, acknowledgements are matched by request
 * id, and `storage_reconciliation_required` by the device serial it names.
 *
 * The daemon owns an observer per (serial, package, file) and per *socket*, so two device streams
 * for one serial on this socket (an outgoing and an incoming epoch) share one daemon-side owner. A
 * stream therefore never releases an observer another live stream for its serial still wants or
 * holds.
 */
internal class ObservationMuxStorage(
  private val table: ObservationMuxTable,
  private val wire: ObservationMuxWire,
  private val log: Logger,
) {
  // Orders storage commands on the wire: held from deciding a command to writing it, and around a
  // released device's owed unsubscribes, so a subscribe decided before a release cannot reach the
  // socket after that release's unsubscribe (#17117). Taken before [ObservationMuxTable.lock].
  private val writeOrder = Any()

  fun subscribe(channel: MuxObservationChannel, key: StorageSubscriptionKey) {
    if (synchronized(table.lock) { channel.storage.want(key) }) drive(channel, key)
  }

  fun unsubscribe(channel: MuxObservationChannel, key: StorageSubscriptionKey) {
    // A subscribe still in flight is compensated when its acknowledgement arrives.
    if (synchronized(table.lock) { channel.storage.unwant(key) }) drive(channel, key)
  }

  /** Re-register [channel]'s remembered files after its (re)subscribe. */
  fun reapply(channel: MuxObservationChannel) {
    synchronized(table.lock) { channel.storage.desiredKeys }.forEach { drive(channel, it) }
  }

  /**
   * Called under the table lock as [channel] leaves an open socket: the `unsubscribe_storage`
   * commands it owes for the observers it may hold that no other stream for its serial needs. Its
   * desired files stay remembered.
   */
  fun release(channel: MuxObservationChannel): List<StreamRequest> {
    val owed =
      channel.storage
        .daemonSideKeys()
        .filterNot { sharedWithAnother(channel, it) }
        .map {
          wire.storage(channel, it, subscribe = false)
        }
    channel.storage.connectionReset()
    return owed
  }

  /** Write the `unsubscribe_storage` commands a released device owes, after any decided command. */
  fun writeOwed(open: TelemetrySocket, owed: List<StreamRequest>) {
    if (owed.isEmpty()) return
    synchronized(writeOrder) { owed.forEach { wire.write(open, it) } }
  }

  /** Record a storage command's answer; false when [id] is not a storage command. */
  fun resolve(id: String, success: Boolean, error: String?): Boolean {
    val (channel, resolution, connection) =
      synchronized(table.lock) {
        val channel = table.storageRequests.take(id) ?: return false
        Triple(channel, channel.storage.resolve(id, success), channel.storage.connection)
      }
    val command = resolution?.command ?: return true
    channel.flows.storageResponses.trySend(
      StampedStorageResponse(
        connection,
        StorageSubscriptionResponse(id, command.key, command.subscribe, success, error),
      ),
    )
    if (resolution.redrive) drive(channel, command.key)
    return true
  }

  /** The daemon recreated [response]'s observer: its file needs a fresh snapshot. */
  fun reconcile(response: StreamResponse) {
    val packageName = response.packageName
    val fileName = response.fileName
    if (packageName == null || fileName == null) {
      log.warn("storage_reconciliation_required without packageName/fileName, ignoring")
      return
    }
    val key = StorageSubscriptionKey(packageName, fileName)
    val owners =
      synchronized(table.lock) {
        table.channels.filter { it.deviceId == response.deviceId && it.storage.isDesired(key) }
      }
    owners.forEach { it.flows.storageReconciliations.trySend(key) }
  }

  /** Send the one command that moves [key]'s daemon-side observer toward [channel]'s intent. */
  private fun drive(channel: MuxObservationChannel, key: StorageSubscriptionKey) {
    synchronized(writeOrder) { driveInOrder(channel, key) }
  }

  // Called holding [writeOrder].
  private fun driveInOrder(channel: MuxObservationChannel, key: StorageSubscriptionKey) {
    val step =
      synchronized(table.lock) {
        if (!channel.live || !channel.isConnected()) return
        val open = table.socket ?: return
        val command = channel.storage.next(key, wire::newId, 0L) ?: return
        if (!command.subscribe && sharedWithAnother(channel, key)) {
          // Another stream for this serial still needs the shared observer: settle locally.
          channel.storage.sent(command, sent = true)
          null to command
        } else {
          table.storageRequests.put(command.requestId, channel)
          open to command
        }
      }
    val (open, command) = step
    if (open == null) {
      resolveLocally(channel, command)
      return
    }
    val sent = wire.write(open, wire.storage(channel, key, command.subscribe, command.requestId))
    synchronized(table.lock) {
      channel.storage.sent(command, sent)
      if (!sent) table.storageRequests.take(command.requestId)
    }
    // The key stays desired, and nothing would drive it again while the socket stays open: close
    // it, so every device reconnects and re-registers its files (#17117).
    if (!sent) wire.closeQuietly(open)
  }

  private fun resolveLocally(channel: MuxObservationChannel, command: PendingStorageSubscription) {
    synchronized(table.lock) {
      table.storageRequests.put(command.requestId, channel)
    }
    resolve(command.requestId, success = true, error = null)
  }

  // Called under the table lock.
  private fun sharedWithAnother(channel: MuxObservationChannel, key: StorageSubscriptionKey) =
    table.channels
      .filter { it !== channel && it.deviceId == channel.deviceId }
      .any { it.storage.isDesired(key) || key in it.storage.daemonSideKeys() }
}
