package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DeviceControlDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceControlInputs
import dev.jasonpearson.automobile.desktop.domain.DeviceControlPolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshState
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshTracker
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The one seam client device control runs through (issue #3348).
 *
 * [#3347](https://github.com/kaeawc/auto-mobile/pull/4475) accumulated its safety machinery as
 * separate pieces wired individually into the Compose host: an error-ordering gate, a bounded
 * ordered dispatch queue, a frame-generation guard and a geometry check, each with its own
 * lifecycle call site. Every new input action would have had to re-wire all of it and re-derive its
 * own gates. This type owns them instead, so the Compose layer wires it **once** and later actions
 * — drag/swipe ([#3350](https://github.com/kaeawc/auto-mobile/issues/3350)) and keyboard/text
 * ([#3351](https://github.com/kaeawc/auto-mobile/issues/3351)) — add a dispatch method here rather
 * than a new gate up there.
 *
 * Responsibilities:
 * - **Decide** whether control is available, via the pure [DeviceControlPolicy], and expose the one
 *   [DeviceFrameSnapshot] every click must map and dispatch through.
 * - **Dispatch** an action against the snapshot it was clicked on. The snapshot travels with the
 *   command, so a snapshot swap between click and dispatch cannot change what the daemon receives.
 * - **Order** overlapping attempts so only the newest may publish the error banner (the former
 *   `ControlTapErrorGate`, folded in — its `AtomicLong` claim/check is [errorToken] below).
 * - **Track** the post-input refresh policy ([PostInputRefreshTracker]).
 * - **Reset** all of the above coherently when the control context changes.
 *
 * Compose-free and unit-testable: the daemon client, the clock, the UI context and the IO
 * dispatcher are all injected, so tests drive it with fakes and no real device, socket or timer.
 *
 * @param scope the coroutine scope the single dispatch consumer runs in (cancelled with the host).
 * @param clientProvider mints a daemon client per action; the consumer closes it after dispatch.
 *   Read at enqueue time, so a host whose provider changes (a daemon reconnect) can swap it behind
 *   this lambda and keep ONE session rather than building a replacement — a replacement would
 *   strand the previous session's dispatch consumer, still running in the host's stable scope with
 *   taps queued against the old client, and its independent error claim could publish into the new
 *   context. Call [reset] before swapping so nothing queued against the old provider survives.
 * @param platform the daemon platform string for the target device ("android" / "ios"), read at
 *   dispatch-enqueue time on the UI thread.
 * @param nowMs client wall clock, injected so freshness decisions are deterministic in tests.
 * @param publishError receives the actionable error to show (or null to clear). Invoked on
 *   [uiContext].
 * @param uiContext the context error publication is marshaled onto, so the claim/check and the
 *   banner write are serialized. Production passes `Dispatchers.Main`.
 * @param ioDispatcher where the blocking daemon call runs.
 */
class DeviceControlSession(
  scope: CoroutineScope,
  private val clientProvider: () -> AutoMobileClient?,
  private val platform: () -> String,
  private val nowMs: () -> Long,
  private val publishError: (String?) -> Unit,
  private val uiContext: CoroutineContext = Dispatchers.Main,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  private val forwarder: DeviceControlTapForwarder = DeviceControlTapForwarder(),
  private val refreshTracker: PostInputRefreshTracker = PostInputRefreshTracker(),
) {
  /**
   * Newest-attempt claim, folded in from the former `ControlTapErrorGate`. Actions are
   * asynchronous: a click claims a monotonically increasing token on the UI thread and, when it
   * completes on the IO dispatcher, publishes its error only while the token is still current — so
   * a late failure from a superseded attempt cannot resurrect a banner a newer attempt cleared.
   */
  private val errorToken = AtomicLong(0L)

  private val dispatcher = DeviceControlTapDispatcher(scope) { command -> execute(command) }

  /** The post-input refresh state a client should be rendering; see [PostInputRefreshTracker]. */
  val refreshState: PostInputRefreshState
    get() = refreshTracker.state

  /**
   * The snapshot the inspector should RENDER, as opposed to the one control may act through.
   *
   * These differ only while a post-input refresh is pending. After a successful input the clicked
   * snapshot is retained here until a snapshot that genuinely *supersedes* it arrives — meaning a
   * newly-paired screenshot **and** hierarchy, since a snapshot cannot exist without both. A
   * screenshot-only update in the meantime carries a capture identity the retained hierarchy does
   * not match, so it produces no snapshot and does not replace this one; the inspector keeps
   * showing a coherent picture instead of flickering to a half-updated one. The timeout in
   * [PostInputRefreshTracker] bounds how long that can last.
   *
   * Updated by [evaluate]; null before the first snapshot and after [reset].
   */
  var renderSnapshot: DeviceFrameSnapshot? = null
    private set

  /**
   * Evaluate control availability for [inputs] and, on the way, offer the resulting snapshot to the
   * refresh tracker so a pending post-input wait settles on the first superseding snapshot.
   *
   * Call once per composition pass. The returned [DeviceControlDecision.Available.snapshot] is what
   * must be handed to the view: the view maps clicks through it and hands it back with each tap.
   */
  fun evaluate(inputs: DeviceControlInputs): DeviceControlDecision {
    val now = nowMs()
    val decision = DeviceControlPolicy.evaluate(inputs, now)
    val live = decision.snapshotOrNull
    if (refreshTracker.state == PostInputRefreshState.AwaitingSnapshot) {
      // Hold the clicked snapshot on screen until something supersedes it (or the wait times out).
      val settled =
        if (live != null) refreshTracker.onSnapshot(live, now) else refreshTracker.onTick(now)
      // On settle, adopt whatever is live — INCLUDING null. A wait can time out with no live
      // snapshot at all (screenshots keep arriving but hierarchy updates stall, so nothing pairs),
      // and holding the pre-input frame in that case would pin the view to it indefinitely,
      // defeating the retention timeout. Releasing it lets the view fall back to current inspector
      // state and lets control re-evaluate from scratch.
      if (settled) renderSnapshot = live
    } else if (live != null) {
      renderSnapshot = live
    }
    return decision
  }

  /**
   * Enqueue a tap on [snapshot] at the mapped device coordinate [point], in click order.
   *
   * [snapshot] is the frame the user actually clicked, captured by the view atomically with
   * [point]; the dispatch targets `snapshot.deviceId`, never a device id resolved later. Returns
   * false when the tap was not dispatched: an out-of-bounds point (dropped per the
   * coordinate-mapping contract — a control client must never tap off-screen), or a full bounded
   * queue (a stalled daemon is holding up the consumer), in which case an overload error has
   * already been published.
   */
  fun tap(snapshot: DeviceFrameSnapshot, point: DevicePoint): Boolean {
    // Nothing reaches the device for an off-screen point, so this must be a no-op — not a
    // "success" that parks the client in AwaitingSnapshot for the full refresh timeout waiting for
    // a device change that was never requested.
    if (!point.inBounds) return false
    val token = errorToken.incrementAndGet()
    publishError(null)
    val accepted =
      dispatcher.enqueue(
        DeviceControlTapCommand(
          point = point,
          client = clientProvider(),
          platform = platform(),
          snapshot = snapshot,
          token = token,
        )
      )
    if (!accepted) publishError(TAP_OVERLOAD_ERROR)
    return accepted
  }

  /**
   * Coherently reset the control context. Call at every point that invalidates the rendered frame
   * identity — device change, transport/mode change, observation-stream disconnect, live layout
   * open/close.
   *
   * Drops the queued backlog (closing each captured client, so a stalled/aged action cannot fire in
   * the new context), advances the error token so a late failure from a pre-reset attempt is no
   * longer current, clears any shown banner, and drops a pending post-input refresh wait so an
   * action dispatched in the previous context cannot settle one in the new one.
   */
  fun reset() {
    dispatcher.reset()
    errorToken.incrementAndGet()
    refreshTracker.reset()
    renderSnapshot = null
    publishError(null)
  }

  private suspend fun execute(command: DeviceControlTapCommand) {
    var error: String? = null
    try {
      withContext(ioDispatcher) {
        forwarder.forward(
          point = command.point,
          client = command.client,
          platform = command.platform,
          deviceId = command.snapshot.deviceId,
          onError = { message -> error = message },
        )
      }
    } finally {
      command.client?.close()
    }
    val message = error
    withContext(uiContext) {
      if (message == null) {
        // Success: the device changed, so wait for the observation stream to supersede the snapshot
        // this input was dispatched through. No polling, no client-side re-observe.
        refreshTracker.onInputSucceeded(command.snapshot, nowMs())
      } else {
        // Failure: the device did not change, so nothing on screen is stale and nothing is cleared.
        refreshTracker.onInputFailed()
        // Serialize the claim check with the banner write on the UI context so a superseded
        // attempt's stale error cannot resurrect a banner a newer attempt already cleared.
        if (command.token == errorToken.get()) publishError(message)
      }
    }
  }

  companion object {
    /**
     * Shown when the bounded dispatch queue rejects a tap because the daemon is not draining it.
     */
    const val TAP_OVERLOAD_ERROR: String = "Tap dropped — device busy"
  }
}
