package dev.jasonpearson.automobile.desktop.core.daemon

/**
 * One observation stream's per-file storage observer bookkeeping: what the UI asked for (desired)
 * versus what the daemon confirmed. They are deliberately distinct: a command can be in flight
 * while the UI removes a file, so "asked for" does not mean the observer exists on the runner.
 *
 * At most one command per file is pending at a time, which preserves order (subscribe→unsubscribe
 * and unsubscribe→subscribe) without guessing whether the daemon completed the older command. Not
 * thread-safe: the owning stream calls every member under its own lock.
 */
internal class StorageSubscriptionLedger {
  private val desired = LinkedHashSet<StorageSubscriptionKey>()
  private val confirmed = LinkedHashSet<StorageSubscriptionKey>()
  private val pending = LinkedHashMap<String, PendingStorageSubscription>()
  private val intentVersions = LinkedHashMap<StorageSubscriptionKey, Long>()
  private val forcedReconciliations = LinkedHashSet<StorageSubscriptionKey>()

  /** Bumped by every [connectionReset], so an answer can name the connection that produced it. */
  var connection = 0L
    private set

  /** Every file the UI currently wants observed. */
  val desiredKeys: List<StorageSubscriptionKey>
    get() = desired.toList()

  fun isDesired(key: StorageSubscriptionKey): Boolean = key in desired

  /** Record the wish to observe [key]; false when it was already wanted. */
  fun want(key: StorageSubscriptionKey): Boolean = desired.add(key).also { if (it) bump(key) }

  /** Record the wish to stop observing [key]; false when it was not wanted. */
  fun unwant(key: StorageSubscriptionKey): Boolean = desired.remove(key).also { if (it) bump(key) }

  /**
   * The one command that moves [key]'s confirmed state toward its desired state, recorded as
   * pending under [requestId] for [connectionGeneration]; null when nothing is needed or a command
   * for [key] is already in flight.
   */
  fun next(
    key: StorageSubscriptionKey,
    requestId: () -> String,
    connectionGeneration: Long,
  ): PendingStorageSubscription? {
    if (pending.values.any { it.key == key }) return null
    val subscribe = direction(key) ?: return null
    return PendingStorageSubscription(
        requestId = requestId(),
        key = key,
        subscribe = subscribe,
        intentVersion = intentVersions[key] ?: 0L,
        forcedReconciliation = forced,
        connectionGeneration = connectionGeneration,
      )
      .also { pending[it.requestId] = it }
  }

  /** Whether [next] would issue a command for [key] now, without recording one. */
  fun needsCommand(key: StorageSubscriptionKey): Boolean =
    pending.values.none { it.key == key } && direction(key) != null

  // The command [key] needs: true to subscribe, false to unsubscribe, null when none.
  private fun direction(key: StorageSubscriptionKey): Boolean? {
    val wanted = key in desired
    val held = key in confirmed
    return when {
      key in forcedReconciliations -> wanted
      wanted && !held -> true
      !wanted && held -> false
      else -> null
    }
  }

  /** [command] reached the wire (or did not, when [sent] is false). */
  fun sent(command: PendingStorageSubscription, sent: Boolean) {
    if (!sent) {
      pending.remove(command.requestId)
    } else if (command.forcedReconciliation) {
      forcedReconciliations.remove(command.key)
    }
  }

  /**
   * Record the daemon's answer to [requestId]; null when it is not one of this stream's pending
   * commands (an ordinary stream response, or a stale reply from a released socket). The result
   * says whether the file must be driven again.
   */
  fun resolve(requestId: String, success: Boolean): StorageResolution? {
    val command = pending.remove(requestId) ?: return null
    if (success) {
      if (command.subscribe) confirmed.add(command.key) else confirmed.remove(command.key)
    }
    val intentChanged = (intentVersions[command.key] ?: 0L) != command.intentVersion
    // A permanent rejection establishes no new daemon state. Redriving an unchanged intent creates
    // a request/error busy loop. But if the user changed their intent while the command's outcome
    // became ambiguous, force one compensating command for the latest state.
    if (!success && intentChanged) forcedReconciliations.add(command.key)
    return StorageResolution(command, redrive = success || intentChanged)
  }

  /** Files the daemon may hold an observer for: confirmed, or with a command in flight. */
  fun daemonSideKeys(): Set<StorageSubscriptionKey> = confirmed + pending.values.map { it.key }

  /**
   * The connection carrying the daemon-side observers is gone: its acknowledgements can no longer
   * be trusted, so forget them while keeping the desired intent to re-apply.
   */
  fun connectionReset() {
    confirmed.clear()
    pending.clear()
    connection++
  }

  private fun bump(key: StorageSubscriptionKey) {
    intentVersions[key] = (intentVersions[key] ?: 0L) + 1L
  }
}

/** A resolved storage command, and whether its file needs another command. */
internal data class StorageResolution(val command: PendingStorageSubscription, val redrive: Boolean)
