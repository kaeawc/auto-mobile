package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DeviceControlBlockReason
import dev.jasonpearson.automobile.desktop.domain.DeviceControlDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceControlInputs
import dev.jasonpearson.automobile.desktop.domain.DeviceControlPolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceDragDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceDragGesturePolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardInputPolicy
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
 * #3347 accumulated its safety machinery as separate pieces wired individually into the Compose
 * host: an error-ordering gate, a bounded ordered dispatch queue, a frame-generation guard and a
 * geometry check, each with its own lifecycle call site. Every new input action would have had to
 * re-wire all of it and re-derive its own gates. This type owns them instead, so the Compose layer
 * wires it **once** and later actions add a dispatch method here rather than a new gate up there.
 * Drag/swipe (#3350) did exactly that — [swipe] joins [tap] on the one queue, the one error claim
 * and the one refresh tracker — and keyboard/text/button (#3351) did the same: [key] is one more
 * dispatch method on the same three, not a fourth mechanism.
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
  private val forwarder: DeviceControlInputForwarder = DeviceControlInputForwarder(),
  private val refreshTracker: PostInputRefreshTracker = PostInputRefreshTracker(),
) {
  /**
   * Newest-attempt claim, folded in from the former `ControlTapErrorGate`. Actions are
   * asynchronous: a click claims a monotonically increasing token on the UI thread and, when it
   * completes on the IO dispatcher, publishes its error only while the token is still current — so
   * a late failure from a superseded attempt cannot resurrect a banner a newer attempt cleared.
   */
  private val errorToken = AtomicLong(0L)

  private val dispatcher = DeviceControlInputDispatcher(scope) { command -> execute(command) }

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
   * The snapshot a click must be mapped and dispatched through, or null when control is
   * unavailable.
   *
   * Usually this is the live decision's snapshot. While a post-input refresh is pending it is the
   * RETAINED one: an ordinary screenshot-only or hierarchy-only update makes the live decision
   * Blocked (nothing pairs yet) while [renderSnapshot] still holds and displays the coherent
   * pre-input frame. Deriving interaction from the live decision there would flip the frame the
   * user is looking at to inspector mode, so a rapid second click would select an element instead
   * of reaching the device — breaking the promise that the retained snapshot stays clickable until
   * a paired successor arrives.
   *
   * The retention is still bounded by everything that already bounds it: [reset] clears it, and a
   * wait that times out releases it (see [evaluate]), after which this falls back to the live
   * decision and drops to inspector mode.
   */
  var interactionSnapshot: DeviceFrameSnapshot? = null
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
    // While awaiting, the retained frame is what the user sees, so it is also what a click acts
    // through — but ONLY while it is still fresh. Retention must never outlive freshness: a frame
    // held for the refresh wait is still clickable, so it has to age out exactly as the live
    // decision ages it out. Without this, tapping a frame near the freshness bound would keep the
    // view in Control for the rest of the 3s wait, and each successful tap restarts that wait, so
    // stale content could stay actionable indefinitely.
    interactionSnapshot =
      if (refreshTracker.state == PostInputRefreshState.AwaitingSnapshot) {
        retainedIfStillFresh(decision, now)
      } else {
        live
      }
    return decision
  }

  /**
   * The retained frame, or null once it is no longer fresh enough to act on.
   *
   * Two independent signals retire it, because either alone can be the first to notice: the live
   * decision reporting [DeviceControlBlockReason.StaleFrame] (the sources stopped producing), and
   * the retained frame's own age (nothing new has arrived to make the live decision say anything).
   */
  private fun retainedIfStillFresh(
    decision: DeviceControlDecision,
    nowMs: Long,
  ): DeviceFrameSnapshot? {
    val retained = renderSnapshot ?: return null
    val blockedForStaleness =
      (decision as? DeviceControlDecision.Blocked)?.reason == DeviceControlBlockReason.StaleFrame
    if (blockedForStaleness) return null
    return retained.takeIf { DeviceControlPolicy.isSnapshotFresh(it, nowMs) }
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
    return enqueue { client, platformName, token ->
      DeviceControlInputCommand.Tap(
        point = point,
        client = client,
        platform = platformName,
        snapshot = snapshot,
        token = token,
      )
    }
  }

  /**
   * Enqueue a drag on [snapshot] as one `input/swipe`, in gesture order on the SAME queue as [tap]
   * — so a tap-then-swipe sequence executes in the order the user made it.
   *
   * [start] and [end] must both have been mapped through [snapshot]; the view captures the frame
   * once when the drag begins and maps both endpoints through it, so a snapshot swap mid-drag
   * cannot change the mapping (issue #3350).
   *
   * Whether the drag is a swipe at all is decided by the pure [DeviceDragGesturePolicy]: a movement
   * below its threshold, or one that began off-screen, is **not dispatched** and returns false with
   * no daemon request, no error banner, and no post-input refresh wait — an ignored drag changed
   * nothing on the device, so parking the client in AwaitingSnapshot would be a lie. An end that
   * ran off the frame is clamped by that policy rather than dropped. False is also returned when
   * the bounded queue is full, in which case an overload error has already been published.
   */
  fun swipe(snapshot: DeviceFrameSnapshot, start: DevicePoint, end: DevicePoint): Boolean {
    val decision =
      DeviceDragGesturePolicy.evaluate(
        start = start,
        end = end,
        deviceWidth = snapshot.deviceWidth,
        deviceHeight = snapshot.deviceHeight,
      )
    // Ignored is not a failure: it means the gesture was never a swipe. Nothing is sent, nothing is
    // surfaced, and the refresh tracker is left alone.
    if (decision !is DeviceDragDecision.Swipe) return false
    return enqueue { client, platformName, token ->
      DeviceControlInputCommand.Swipe(
        start = decision.start,
        end = decision.end,
        durationMs = decision.durationMs,
        client = client,
        platform = platformName,
        snapshot = snapshot,
        token = token,
      )
    }
  }

  /**
   * Enqueue whatever [stroke] should send, on the SAME queue as [tap] and [swipe] — so a
   * tap-then-type sequence executes in the order the user made it (issue #3351).
   *
   * What a keystroke means is decided by the pure [DeviceKeyboardInputPolicy]: a device-meaningful
   * key becomes one `input/pressButton` or one `input/key`, a printable character becomes one
   * `input/typeText`, and anything else — notably a modifier-bearing host chord — sends nothing.
   *
   * Returns whether the caller should **consume** the key event, which is not the same question as
   * "was it dispatched":
   * - An ignored keystroke returns false so the event reaches the host. That is the whole
   *   host-shortcut guarantee: the client must not swallow a chord it declined to forward.
   * - A forwarded keystroke returns true even when the bounded queue rejected it. The overload
   *   error has already been published, and letting the key fall through to the host afterwards
   *   would type into the host's own UI as a consolation prize for a dropped device input.
   *
   * Focus and mode gating are the caller's: this is only ever consulted for a keystroke the device
   * view received while focused and in control mode.
   */
  fun key(snapshot: DeviceFrameSnapshot, stroke: DeviceKeyStroke): Boolean {
    when (val decision = decide(stroke)) {
      is DeviceKeyboardDecision.PressButton ->
        enqueue { client, platformName, token ->
          DeviceControlInputCommand.PressButton(
            button = decision.button,
            client = client,
            platform = platformName,
            snapshot = snapshot,
            token = token,
          )
        }
      is DeviceKeyboardDecision.SendKey ->
        enqueue { client, platformName, token ->
          DeviceControlInputCommand.SendKey(
            key = decision.key,
            client = client,
            platform = platformName,
            snapshot = snapshot,
            token = token,
          )
        }
      is DeviceKeyboardDecision.TypeText ->
        enqueue { client, enqueuePlatform, token ->
          DeviceControlInputCommand.TypeText(
            text = decision.text,
            client = client,
            platform = enqueuePlatform,
            snapshot = snapshot,
            token = token,
          )
        }
      // Not ours: send nothing, surface nothing, and leave the event for the host.
      is DeviceKeyboardDecision.Ignored -> return false
    }
    return true
  }

  /**
   * Whether [key] would forward [stroke] to the device, WITHOUT dispatching anything.
   *
   * Exists for the host's preview-phase handlers (issue #3351): Compose runs preview handlers
   * top-down before the focused canvas sees the event and does **not** rerun them while an
   * unconsumed event bubbles back up. A shell that stands its own bindings down for every
   * un-chorded key therefore creates a dead zone for keystrokes this session then declines — the
   * key reaches neither the device nor the shell. The shell instead asks this predicate per event
   * and stands down only for keystrokes the session will actually claim.
   *
   * Delegates to the same [decide] the dispatch path uses, so the prediction and the dispatch
   * cannot disagree.
   */
  fun wouldForwardKey(stroke: DeviceKeyStroke): Boolean =
    decide(stroke) !is DeviceKeyboardDecision.Ignored

  /**
   * The one policy consultation both [key] and [wouldForwardKey] share.
   *
   * Text forwarding needs a daemon helper that APPENDS. Only Android has one (`mode: "append"`,
   * real key events); iOS text input can only replace the focused field, which typing one character
   * at a time would wipe on every keystroke. Buttons and discrete keys are unaffected.
   */
  private fun decide(stroke: DeviceKeyStroke): DeviceKeyboardDecision =
    DeviceKeyboardInputPolicy.evaluate(
      stroke = stroke,
      textSupported = platform() == ANDROID_PLATFORM,
    )

  /**
   * Claim the newest-attempt error token, clear the banner, and enqueue the command [build] makes
   * from the routing facts read at this instant. Shared by every dispatch method so all actions run
   * through the one error claim and the one bounded queue rather than each re-deriving them.
   */
  private inline fun enqueue(
    build: (client: AutoMobileClient?, platform: String, token: Long) -> DeviceControlInputCommand
  ): Boolean {
    val token = errorToken.incrementAndGet()
    publishError(null)
    val accepted = dispatcher.enqueue(build(clientProvider(), platform(), token))
    if (!accepted) publishError(INPUT_OVERLOAD_ERROR)
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
    interactionSnapshot = null
    publishError(null)
  }

  private suspend fun execute(command: DeviceControlInputCommand) {
    var error: String? = null
    try {
      withContext(ioDispatcher) { forward(command) { message -> error = message } }
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

  /**
   * Hand one command to the matching typed forwarder. The device id comes from the command's own
   * snapshot in EVERY branch, never from a selection resolved at dispatch time.
   */
  private fun forward(command: DeviceControlInputCommand, onError: (String) -> Unit) {
    when (command) {
      is DeviceControlInputCommand.Tap ->
        forwarder.forwardTap(
          point = command.point,
          client = command.client,
          platform = command.platform,
          deviceId = command.snapshot.deviceId,
          onError = onError,
        )
      is DeviceControlInputCommand.Swipe ->
        forwarder.forwardSwipe(
          start = command.start,
          end = command.end,
          durationMs = command.durationMs,
          client = command.client,
          platform = command.platform,
          deviceId = command.snapshot.deviceId,
          onError = onError,
        )
      is DeviceControlInputCommand.PressButton ->
        forwarder.forwardPressButton(
          button = command.button,
          client = command.client,
          platform = command.platform,
          deviceId = command.snapshot.deviceId,
          onError = onError,
        )
      is DeviceControlInputCommand.TypeText ->
        forwarder.forwardTypeText(
          text = command.text,
          client = command.client,
          platform = command.platform,
          deviceId = command.snapshot.deviceId,
          onError = onError,
        )
      is DeviceControlInputCommand.SendKey ->
        forwarder.forwardKey(
          key = command.key,
          client = command.client,
          platform = command.platform,
          deviceId = command.snapshot.deviceId,
          onError = onError,
        )
    }
  }

  companion object {
    /**
     * Shown when the bounded dispatch queue rejects an input because the daemon is not draining it.
     */
    const val INPUT_OVERLOAD_ERROR: String = "Input dropped — device busy"

    /** The daemon platform string whose text helper supports non-destructive append. */
    const val ANDROID_PLATFORM: String = "android"
  }
}
