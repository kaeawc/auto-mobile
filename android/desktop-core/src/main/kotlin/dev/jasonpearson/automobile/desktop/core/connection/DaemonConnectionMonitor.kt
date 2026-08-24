package dev.jasonpearson.automobile.desktop.core.connection

import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeout

/**
 * Injectable, timeout-bounded poller for daemon connectivity (#4858).
 *
 * This is the single seam behind daemon-health polling in the desktop app: it replaces the two
 * hand-rolled `while (true) { getDaemonStatus(); delay(5s) }` loops that previously lived in
 * `Main.kt` (system-tray dot) and `AutoMobileDesktopApp` (status dot). One instance is created in
 * `Main.kt` and its [connectionStates] is collected once, feeding both the tray icon and the status
 * dot — a single daemon-health source rather than two overlapping polls. The loop is a plain
 * suspend flow so its cadence, its exception→[ConnectionState.Disconnected] transitions, and its
 * cancellation behavior are all coverable with virtual time.
 *
 * The [probe] is bounded by [probeTimeout] via [withTimeout]. A [TimeoutCancellationException] is a
 * [CancellationException] subtype, so it MUST be caught before the plain-cancellation rethrow —
 * otherwise a hung daemon (socket accepted but no reply) would tear the collecting effect down
 * during a live poll instead of surfacing as Disconnected, leaving the dot stuck and disposal slow.
 * The rethrow of a genuine [CancellationException] (effect disposal) stays intact so teardown does
 * not log a false daemon failure.
 *
 * @param probe suspends until the daemon status resolves, or throws if it is unreachable. Callers
 *   dispatch the blocking client call (e.g. `withContext(Dispatchers.IO) { client.getDaemonStatus()
 *   }`). The real hang bound lives in the client: `getDaemonStatus()` passes a transport hang
 *   ceiling that closes the socket on a wedged daemon, which makes the blocking read throw so the
 *   probe returns as Disconnected. [probeTimeout] here is a coarser coroutine-level backstop — it
 *   cannot interrupt an uninterruptible blocking read (structured concurrency waits for the
 *   `withContext` child), so it only bounds cooperative probes; the transport ceiling is what
 *   actually un-sticks the dot.
 * @param pollInterval delay between the end of one probe and the start of the next.
 * @param probeTimeout deadline for a single probe before it is treated as Disconnected.
 * @param onProbeFailure invoked with the failure (a timeout or a thrown error) whenever a probe
 *   resolves to Disconnected, so callers can keep a log trace behind the dot. Never invoked for a
 *   successful probe or for genuine collector cancellation.
 */
class DaemonConnectionMonitor(
  private val probe: suspend () -> Unit,
  private val pollInterval: Duration = DEFAULT_POLL_INTERVAL,
  private val probeTimeout: Duration = DEFAULT_PROBE_TIMEOUT,
  private val onProbeFailure: (Throwable) -> Unit = {},
) {

  /**
   * Emits [ConnectionState.Connecting] immediately, then one state per poll until the collector is
   * cancelled. The flow never completes on its own.
   *
   * This is a stable `val`, not a method: `collectAsState` keys its collection on the flow
   * instance, so handing out a fresh cold flow per access (a `fun`) would restart collection on
   * every recomposition — re-emitting Connecting and re-probing immediately, defeating
   * [pollInterval]. One cached instance keeps a single collection alive across recompositions. It
   * is a cold flow, so each distinct collector still gets its own independent poll loop.
   */
  val connectionStates: Flow<ConnectionState> = flow {
    emit(ConnectionState.Connecting)
    while (currentCoroutineContext().isActive) {
      emit(probeOnce())
      delay(pollInterval)
    }
  }

  private suspend fun probeOnce(): ConnectionState =
    try {
      withTimeout(probeTimeout) { probe() }
      ConnectionState.Connected()
    } catch (timeout: TimeoutCancellationException) {
      // Bounded probe deadline hit. Caught BEFORE the CancellationException branch below so a
      // timeout surfaces as Disconnected and the loop keeps polling, rather than being rethrown.
      onProbeFailure(timeout)
      ConnectionState.Disconnected("Daemon status probe timed out after $probeTimeout")
    } catch (cancellation: CancellationException) {
      // Genuine disposal (collector cancelled). Propagate so teardown does not log a false daemon
      // failure and flip the dot to disconnected while the app is closing.
      throw cancellation
    } catch (error: Exception) {
      // A failed status call means the daemon socket is unreachable; surface it as Disconnected.
      onProbeFailure(error)
      ConnectionState.Disconnected(error.message)
    }

  companion object {
    /**
     * Matches the health sheet's read-only refresh cadence
     * (WorkspaceShell.HEALTH_SHEET_REFRESH_MS).
     */
    val DEFAULT_POLL_INTERVAL: Duration = 5.seconds

    /** Deadline for a single status probe before the daemon is treated as unreachable. */
    val DEFAULT_PROBE_TIMEOUT: Duration = 10.seconds
  }
}
