package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
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
 * Unit-testable: the daemon client, the clock, the UI context and the IO dispatcher are all
 * injected, so tests drive it with fakes and no real device, socket or timer. The decision LOGIC is
 * Compose-free — it lives in [DeviceControlPolicy] in `desktop-domain` — but the two snapshot
 * properties below are deliberately Compose-observable state, because an invalidation that the view
 * cannot see is not an invalidation (issue #4550; see [interactionSnapshot]). Snapshot state reads
 * and writes work outside a composition, so tests are unaffected.
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

  /**
   * Remembers the last [CoordinateSpace] observed at one point in the pipeline and reports whether
   * a new observation differs from it (issue #4550).
   *
   * [seen] distinguishes "declared nothing" from "not observed yet": both are a null space, but
   * only the former can be flipped AWAY from, so the first observation must be a baseline rather
   * than a transition. [forget] restores that state for a new control context.
   */
  private class SpaceTracker {
    private var seen: Boolean = false
    private var last: CoordinateSpace? = null

    /** Records [space] and returns whether it DIFFERS from the previously recorded one. */
    fun observe(space: CoordinateSpace?): Boolean {
      val flipped = seen && space != last
      seen = true
      last = space
      return flipped
    }

    /**
     * Whether [space] still agrees with what was last recorded. Nothing observed yet agrees with
     * everything — there is no declaration to contradict, so this must not reject.
     */
    fun matches(space: CoordinateSpace?): Boolean = !seen || space == last

    fun forget() {
      seen = false
      last = null
    }
  }

  /** Same transition and dispatch-time agreement rules as [SpaceTracker], for native scale. */
  private class NativeScaleTracker {
    private var seen: Boolean = false
    private var last: Double? = null

    fun observe(nativeScale: Double?): Boolean {
      val changed = seen && nativeScale != last
      seen = true
      last = nativeScale
      return changed
    }

    fun matches(nativeScale: Double?): Boolean = !seen || nativeScale == last

    fun forget() {
      seen = false
      last = null
    }
  }

  /** Records the newest frame context observed from the stream. */
  private class FrameContextTracker {
    private var seen: Boolean = false
    private var last: String? = null

    fun observe(frameContext: String?): Boolean {
      val changed = seen && frameContext != last
      seen = true
      last = frameContext
      return changed
    }

    fun matches(frameContext: String): Boolean = !seen || frameContext == last

    fun forget() {
      seen = false
      last = null
    }
  }

  // The declaration seen at STREAM RECEIPT — the earliest point in the pipeline, ahead of hierarchy
  // parsing and the layout state's debounce. This is the one that matters (see
  // [onObservationSpaceDeclared]).
  private val streamSpace = SpaceTracker()
  private val streamNativeScale = NativeScaleTracker()

  // Like [streamSpace], but carries the device-authored identity that makes input actionable.
  private val streamFrameContext = FrameContextTracker()

  // Newest capture identity whose coordinate space has been observed at receipt, so a late frame
  // carrying an older binding cannot roll the tracked space backward (see
  // [onObservationSpaceDeclared]).
  private var lastObservedSpaceCapture: Long? = null

  // A delayed screenshot may carry the context it had when capture began, so receipt-time context
  // observations must use the same capture ordering as coordinate-space observations.
  private var lastObservedFrameContextCapture: Long? = null

  // The latest proven device rotations, for the dispatch-time gate. Null until one is observed,
  // one value when every proving source agrees, and multiple values latched during a disagreement
  // until currently reported sources prove they agree again.
  @Volatile private var lastProvenRotations: Set<Int>? = null

  // Backstop trackers on the frame FACTS, for updates that never came through the stream collectors
  // (see [resetOnCoordinateSpaceTransition]).
  private val screenshotFactSpace = SpaceTracker()
  private val hierarchyFactSpace = SpaceTracker()
  private val screenshotFactNativeScale = NativeScaleTracker()
  private val hierarchyFactNativeScale = NativeScaleTracker()

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
   *
   * Compose-OBSERVABLE (issue #4550). See [interactionSnapshot] for why that matters.
   */
  var renderSnapshot by mutableStateOf<DeviceFrameSnapshot?>(null)
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
   *
   * **Compose-observable, deliberately** (issue #4550). Most writes here happen during a
   * composition pass that some other state change already triggered, so a plain field would look
   * like it worked. [onObservationSpaceDeclared] is the exception that proves it does not: it fires
   * from a stream collector with no other state change to ride on, and a plain field would leave
   * the view holding the retired frame — and happily mapping clicks through it — until the next
   * recomposition, which for the hierarchy path is the ~100 ms debounce. That is precisely the
   * window the receipt-time hook exists to close, so the invalidation has to be visible to Compose
   * or the early detection buys nothing.
   */
  var interactionSnapshot by mutableStateOf<DeviceFrameSnapshot?>(null)
    private set

  /**
   * Frame context of a snapshot the daemon rejected as stale. The rendered snapshot remains useful
   * for inspection, but its coordinates are no longer actionable until the device reports a
   * different context.
   */
  private var staleContextRejectedFrameContext: String? = null

  /**
   * Evaluate control availability for [inputs] and, on the way, offer the resulting snapshot to the
   * refresh tracker so a pending post-input wait settles on the first superseding snapshot.
   *
   * Call once per composition pass. The returned [DeviceControlDecision.Available.snapshot] is what
   * must be handed to the view: the view maps clicks through it and hands it back with each tap.
   */
  fun evaluate(inputs: DeviceControlInputs): DeviceControlDecision {
    val now = nowMs()
    resetOnCoordinateSpaceTransition(inputs)
    updateProvenRotations(inputs)
    val decision = DeviceControlPolicy.evaluate(inputs, now)
    val live = decision.snapshotOrNull
    staleContextRejectedFrameContext?.let { rejectedContext ->
      if (live != null && live.frameContext != rejectedContext) {
        staleContextRejectedFrameContext = null
      }
    }
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
      if (staleContextRejectedFrameContext != null) {
        null
      } else if (refreshTracker.state == PostInputRefreshState.AwaitingSnapshot) {
        retainedIfStillActionable(decision, inputs, now)?.takeIf {
          streamFrameContext.matches(it.frameContext)
        }
      } else {
        live?.takeIf { streamFrameContext.matches(it.frameContext) }
      }
    return decision
  }

  /**
   * The retained frame, or null once it is no longer safe to act through.
   *
   * Four independent signals retire it, because any one can be the first to notice:
   * - the live decision reporting [DeviceControlBlockReason.StaleFrame] (the sources stopped
   *   producing),
   * - the live decision reporting [DeviceControlBlockReason.RotationMismatch] (the displayed bounds
   *   are no longer safe to map through) — issue #4502,
   * - a valid incoming source rotation differing from the retained snapshot, since a partial
   *   rotation update can otherwise be unpaired (issue #4502), and
   * - the retained frame's own age (nothing new has arrived to make the live decision say
   *   anything).
   *
   * A **coordinate-space transition** (issue #4550) is deliberately NOT one of them: it is a change
   * of control *context* rather than a property of this one frame, so it is handled one layer up by
   * [resetOnCoordinateSpaceTransition] / [onObservationSpaceDeclared], which also drain the queued
   * backlog. Rotation and coordinate space are complementary gates — a frame is actionable only
   * when both are current — and neither subsumes the other.
   */
  private fun retainedIfStillActionable(
    decision: DeviceControlDecision,
    inputs: DeviceControlInputs,
    nowMs: Long,
  ): DeviceFrameSnapshot? {
    val retained = renderSnapshot ?: return null
    when ((decision as? DeviceControlDecision.Blocked)?.reason) {
      DeviceControlBlockReason.StaleFrame,
      DeviceControlBlockReason.RotationMismatch -> return null
      else -> Unit
    }
    if (inputs.hasProvenRotationDifferentFrom(retained.rotation)) return null
    return retained.takeIf { DeviceControlPolicy.isSnapshotFresh(it, nowMs) }
  }

  /**
   * BACKSTOP for a [CoordinateSpace] change that reaches the frame facts without having passed
   * through [onObservationSpaceDeclared] (issue #4550).
   *
   * The primary detection is at stream receipt, which is strictly earlier than this and is the only
   * point early enough to beat the debounce. This check earns its place because not every fact
   * update comes from a stream message:
   * [dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorState] is also written by
   * programmatic paths (an initial hierarchy fetch, a manual refresh) that carry their own
   * declaration and never reach the collectors. A frame installed that way could otherwise
   * re-establish a space the stream had already moved off, with no reset.
   *
   * Both paths funnel into the same reset, so this is one mechanism observed at two points, not two
   * mechanisms. Each source is tracked independently because either can be the first to change, and
   * a source not seen yet is a baseline rather than a transition.
   *
   * Scope note: receipt-time detection plus this backstop close the windows the client can observe.
   * The residual sub-dispatch race — metadata flipping after a command has already left the queue —
   * cannot be closed from the client at all; it needs the input endpoints to accept a
   * caller-declared space, which is a wire change and deliberately out of scope here.
   */
  private fun resetOnCoordinateSpaceTransition(inputs: DeviceControlInputs) {
    val screenshotFlipped =
      inputs.screenshot?.let { screenshotFactSpace.observe(it.coordinateSpace) }
    val hierarchyFlipped = inputs.hierarchy?.let { hierarchyFactSpace.observe(it.coordinateSpace) }
    val screenshotScaleChanged =
      inputs.screenshot?.let { screenshotFactNativeScale.observe(it.nativeScale) }
    val hierarchyScaleChanged =
      inputs.hierarchy?.let { hierarchyFactNativeScale.observe(it.nativeScale) }
    // The trackers already hold the new space, so this reset must NOT forget them — otherwise the
    // very next evaluate would re-establish a baseline and could see the same flip twice.
    if (
      screenshotFlipped == true ||
        hierarchyFlipped == true ||
        screenshotScaleChanged == true ||
        hierarchyScaleChanged == true
    ) {
      resetPreservingSpaceBaseline()
    }
  }

  /**
   * Note the [CoordinateSpace] a stream message declared, AT RECEIPT, and invalidate the control
   * context if it changed (issue #4550).
   *
   * Call this the moment a `hierarchy_update` or `screenshot_update` is observed — before the
   * hierarchy is parsed and before the layout state's debounce. That timing is the whole point. The
   * daemon starts converting input coordinates under the new scale metadata as soon as it publishes
   * the new declaration, while the client's frame facts do not catch up until the debounce fires
   * (~100 ms later, and the parse before it is off-thread). A tap in that window would be mapped in
   * the OLD unit and converted as the new one — landing in the wrong physical place, silently.
   * Detecting the change downstream, from the facts, is by construction too late for exactly that
   * window.
   *
   * Routes through the same [reset] every other control-context change uses, so a flip drains the
   * queued backlog and drops the retention rather than only stopping future clicks.
   *
   * **The tracker only ever advances**, ordered by [captureSequence]. A screenshot deliberately
   * keeps the coordinate space bound when its capture was REQUESTED (issue #4549's
   * bind-at-initiation, so a mid-flight metadata change cannot relabel the frame), which means a
   * screenshot can arrive AFTER a newer hierarchy while still carrying the older declaration.
   * Observing that unconditionally would roll the session's notion of "current" backward to a space
   * the device has already left — this hook fighting the very binding that makes the frame
   * trustworthy — and, before the debounce, would leave the dispatch gate accepting old-space
   * snapshots and rejecting new-space ones. So an observation that is PROVABLY older than one
   * already seen is ignored outright: it neither records nor resets.
   *
   * `captureSequence` is the ordering signal because it is already bound to each frame and is
   * monotonic per device (issue #3348) — no new clock, no third notion of "current". A session that
   * has never received one still observes unsequenced legacy frames as before. Once a sequenced
   * observation establishes the current space, an unsequenced frame cannot prove it is newer and is
   * ignored. The hierarchy path is unaffected: the daemon assigns the id on every hierarchy push,
   * so a hierarchy's id is always the newest at the time it is sent and can never be rejected here.
   */
  fun onObservationSpaceDeclared(
    coordinateSpace: CoordinateSpace?,
    captureSequence: Long?,
    nativeScale: Double? = null,
  ) {
    val lastSeen = lastObservedSpaceCapture
    if (captureSequence == null && lastSeen != null) return
    if (captureSequence != null && lastSeen != null && captureSequence <= lastSeen) return
    if (captureSequence != null) lastObservedSpaceCapture = captureSequence
    val spaceChanged = streamSpace.observe(coordinateSpace)
    val nativeScaleChanged = streamNativeScale.observe(nativeScale)
    if (spaceChanged || nativeScaleChanged) {
      resetPreservingSpaceBaseline()
    }
  }

  /**
   * Note the frame context declared by an observation message at stream receipt.
   *
   * Frame application can be delayed by hierarchy parsing and debounce, but the runner begins
   * rejecting the previous context as soon as it publishes the new one. Retiring control here keeps
   * the old pixels and queued inputs from remaining actionable in that window.
   */
  fun onObservationFrameContextDeclared(frameContext: String?, captureSequence: Long?) {
    val lastSeen = lastObservedFrameContextCapture
    if (captureSequence != null && lastSeen != null && captureSequence <= lastSeen) return
    if (captureSequence != null) lastObservedFrameContextCapture = captureSequence
    if (streamFrameContext.observe(frameContext)) resetPreservingSpaceBaseline()
  }

  /**
   * Whether [snapshot]'s coordinates can still be sent to the device: its declared
   * [CoordinateSpace] AND its capture rotation are both the ones the device is currently reporting
   * (issues #4550, #4502).
   *
   * Defence in depth, at the last possible moment. [onObservationSpaceDeclared] retires the
   * interaction snapshot as soon as the flip is observed, and that state is Compose-observable so
   * the view drops it promptly. Neither closes the gap for a click ALREADY in flight: a pointer
   * event captured the snapshot before the flip and reaches dispatch after it, and the view cannot
   * un-capture it. This is where that click stops.
   *
   * Only the coordinate-bearing actions consult it. [key] and its siblings carry no coordinate —
   * they use the snapshot solely for its device id, which a space change does not invalidate — so
   * rejecting them here would drop keystrokes for a reason that does not apply to them.
   *
   * Both properties are checked because both can invalidate a coordinate independently: a space
   * flip changes the UNIT the numbers are in, a rotation changes the AXES they are measured on, and
   * a frame is dispatchable only when both are current. Each reuses the value its own fix already
   * records — the stream space tracker and the proven source rotations — rather than introducing a
   * third notion of "current". A session that has observed neither accepts everything: there is
   * nothing to contradict.
   */
  private fun coordinatesAreStillDispatchable(snapshot: DeviceFrameSnapshot): Boolean =
    staleContextRejectedFrameContext == null &&
      streamSpace.matches(snapshot.coordinateSpace) &&
      streamNativeScale.matches(snapshot.nativeScale) &&
      streamFrameContext.matches(snapshot.frameContext) &&
      rotationIsStillDispatchable(snapshot)

  private fun rotationIsStillDispatchable(snapshot: DeviceFrameSnapshot): Boolean =
    lastProvenRotations.let { rotations ->
      rotations == null || (rotations.size == 1 && snapshot.rotation in rotations)
    }

  /**
   * A source can arrive before it pairs with its counterpart during a rotation. That unpaired
   * source still proves the device no longer has [retainedRotation], so retain display pixels if
   * useful but never retain their old coordinate mapping for a second input.
   */
  private fun DeviceControlInputs.hasProvenRotationDifferentFrom(retainedRotation: Int): Boolean =
    listOfNotNull(screenshot?.rotation, hierarchy?.rotation, liveFrame?.rotation).any {
      it in 0..3 && it != retainedRotation
    }

  /** All rotations any source has PROVEN (values in `0..3`), independent of source order. */
  private fun DeviceControlInputs.provenRotations(): Set<Int> =
    listOfNotNull(screenshot?.rotation, hierarchy?.rotation, liveFrame?.rotation)
      .filter { it in 0..3 }
      .toSet()

  /**
   * Keep a proven disagreement until every currently reported source can prove an agreeing
   * rotation. A missing or malformed value cannot prove the device returned to the prior rotation.
   */
  private fun updateProvenRotations(inputs: DeviceControlInputs) {
    val rotations = inputs.provenRotations()
    if (rotations.isEmpty()) return
    if ((lastProvenRotations?.size ?: 0) > 1 && inputs.hasUnprovenReportedRotation()) return
    lastProvenRotations = rotations
  }

  private fun DeviceControlInputs.hasUnprovenReportedRotation(): Boolean =
    screenshot?.let { !it.rotation.isProvenRotation() } == true ||
      hierarchy?.let { !it.rotation.isProvenRotation() } == true ||
      liveFrame?.let { !it.rotation.isProvenRotation() } == true

  private fun Int?.isProvenRotation(): Boolean = this != null && this in 0..3

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
    if (!coordinatesAreStillDispatchable(snapshot)) return false
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
  fun swipe(
    snapshot: DeviceFrameSnapshot,
    start: DevicePoint,
    end: DevicePoint,
    gestureDurationMs: Int? = null,
  ): Boolean {
    if (!coordinatesAreStillDispatchable(snapshot)) return false
    val decision =
      DeviceDragGesturePolicy.evaluate(
        start = start,
        end = end,
        deviceWidth = snapshot.deviceWidth,
        deviceHeight = snapshot.deviceHeight,
        // The threshold is a PHYSICAL distance, so its numeric value depends on the unit these
        // endpoints are in. Read from the clicked snapshot, never from current stream state.
        coordinateSpace = snapshot.coordinateSpace,
        nativeScale = snapshot.nativeScale,
        // Replay the swipe at the speed the user flicked, so an inspector swipe flings like a real
        // one; null (an older caller) keeps the fixed fallback duration.
        gestureDurationMs = gestureDurationMs,
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
    if (!coordinatesAreStillDispatchable(snapshot)) return false
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
   * Text forwarding always uses the daemon's append contract. Android realizes it with real key
   * events; iOS realizes it through CtrlProxy's focused-field insert primitive.
   */
  private fun decide(stroke: DeviceKeyStroke): DeviceKeyboardDecision =
    DeviceKeyboardInputPolicy.evaluate(stroke = stroke)

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
   * open/close, and a coordinate-space transition ([resetOnCoordinateSpaceTransition], which calls
   * this itself).
   *
   * Drops the queued backlog (closing each captured client, so a stalled/aged action cannot fire in
   * the new context), advances the error token so a late failure from a pre-reset attempt is no
   * longer current, clears any shown banner, drops a pending post-input refresh wait so an action
   * dispatched in the previous context cannot settle one in the new one, and forgets the observed
   * coordinate spaces so the next frame is a baseline rather than a transition.
   */
  fun reset() {
    resetPreservingSpaceBaseline()
    streamSpace.forget()
    streamNativeScale.forget()
    screenshotFactSpace.forget()
    hierarchyFactSpace.forget()
    screenshotFactNativeScale.forget()
    hierarchyFactNativeScale.forget()
    lastObservedSpaceCapture = null
    streamFrameContext.forget()
    lastObservedFrameContextCapture = null
    lastProvenRotations = null
  }

  /**
   * Everything [reset] does except forgetting the observed coordinate spaces.
   *
   * Used by the space-transition paths, which have already recorded the NEW space as their
   * baseline: forgetting it there would make the next observation re-establish a baseline and could
   * report the same flip twice. Every other caller wants the full [reset] — a new device or a
   * reconnected stream must not be compared against the previous context's space.
   */
  private fun resetPreservingSpaceBaseline() {
    dispatcher.reset()
    errorToken.incrementAndGet()
    refreshTracker.reset()
    staleContextRejectedFrameContext = null
    renderSnapshot = null
    interactionSnapshot = null
    publishError(null)
  }

  private suspend fun execute(command: DeviceControlInputCommand) {
    // A command can wait behind another input while the sources rotate. Recheck at the FIFO
    // consumer boundary so a coordinate captured before disagreement cannot reach the daemon.
    if (
      (command is DeviceControlInputCommand.Tap || command is DeviceControlInputCommand.Swipe) &&
        !coordinatesAreStillDispatchable(command.snapshot)
    ) {
      command.client?.close()
      return
    }
    var error: String? = null
    val forwarded =
      try {
        withContext(ioDispatcher) {
          // The main-to-IO dispatcher hop admits another observation before the daemon call.
          // This volatile read is the final rotation gate before coordinates leave the process.
          if (
            (command is DeviceControlInputCommand.Tap ||
              command is DeviceControlInputCommand.Swipe) &&
              !rotationIsStillDispatchable(command.snapshot)
          ) {
            false
          } else {
            forward(command) { message -> error = message }
            true
          }
        }
      } finally {
        command.client?.close()
      }
    if (!forwarded) return
    val message = error
    withContext(uiContext) {
      if (message == null) {
        // Success: the device changed, so wait for the observation stream to supersede the snapshot
        // this input was dispatched through. No polling, no client-side re-observe.
        refreshTracker.onInputSucceeded(command.snapshot, nowMs())
      } else {
        // Failure: the device did not change, so nothing on screen is stale and nothing is cleared.
        refreshTracker.onInputFailed()
        if (isStaleFrameContextError(message)) {
          // Inputs already queued against the rejected snapshot must not become implicit retries,
          // but a user can receive a newer paired frame and enqueue a valid command while this
          // one is in flight. Reject only this context so that newer command stays in gesture
          // order and can still reach the device.
          val newestDiscardedToken = dispatcher.discardFrameContext(command.snapshot.frameContext)
          if (newestDiscardedToken == errorToken.get()) {
            // A discarded retry owned the current claim. Its removal must not also suppress the
            // stale rejection that explains why control is unavailable.
            errorToken.set(command.token)
          }
          if (!hasDifferentInteractionFrameContextThan(command.snapshot)) {
            staleContextRejectedFrameContext = command.snapshot.frameContext
            interactionSnapshot = null
          }
        }
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
          frameContext = command.snapshot.frameContext,
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
          frameContext = command.snapshot.frameContext,
          onError = onError,
        )
      is DeviceControlInputCommand.PressButton ->
        forwarder.forwardPressButton(
          button = command.button,
          client = command.client,
          platform = command.platform,
          deviceId = command.snapshot.deviceId,
          frameContext = command.snapshot.frameContext,
          onError = onError,
        )
      is DeviceControlInputCommand.TypeText ->
        forwarder.forwardTypeText(
          text = command.text,
          client = command.client,
          platform = command.platform,
          deviceId = command.snapshot.deviceId,
          frameContext = command.snapshot.frameContext,
          onError = onError,
        )
      is DeviceControlInputCommand.SendKey ->
        forwarder.forwardKey(
          key = command.key,
          client = command.client,
          platform = command.platform,
          deviceId = command.snapshot.deviceId,
          frameContext = command.snapshot.frameContext,
          onError = onError,
        )
    }
  }

  private fun hasDifferentInteractionFrameContextThan(snapshot: DeviceFrameSnapshot): Boolean =
    interactionSnapshot?.frameContext?.let { it != snapshot.frameContext } == true

  companion object {
    private fun isStaleFrameContextError(message: String): Boolean =
      message.contains("stale frame context", ignoreCase = true) ||
        (message.contains("frameContext", ignoreCase = true) &&
          message.contains("stale or unavailable", ignoreCase = true))

    /**
     * Shown when the bounded dispatch queue rejects an input because the daemon is not draining it.
     */
    const val INPUT_OVERLOAD_ERROR: String = "Input dropped — device busy"

    /** The daemon platform string whose text helper supports non-destructive append. */
    const val ANDROID_PLATFORM: String = "android"
  }
}
