package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.DeviceControlBlockReason
import dev.jasonpearson.automobile.desktop.domain.DeviceControlDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceControlInputs
import dev.jasonpearson.automobile.desktop.domain.DeviceControlPolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot

/**
 * The retained frame, or null once it is no longer safe to act through.
 *
 * Four independent signals retire it, because any one can be the first to notice:
 * - the live decision reporting [DeviceControlBlockReason.StaleFrame] (the sources stopped
 *   producing),
 * - the live decision reporting [DeviceControlBlockReason.RotationMismatch] (the displayed bounds
 *   are no longer safe to map through) — issue #4502,
 * - a valid incoming source rotation differing from the retained snapshot, since a partial rotation
 *   update can otherwise be unpaired (issue #4502), and
 * - the retained frame's own age (nothing new has arrived to make the live decision say anything).
 *
 * A **coordinate-space transition** (issue #4550) is deliberately NOT one of them: it is a change
 * of control *context* rather than a property of this one frame, so it is handled one layer up by
 * [resetOnCoordinateSpaceTransition] / [onObservationSpaceDeclared], which also drain the queued
 * backlog. Rotation and coordinate space are complementary gates — a frame is actionable only when
 * both are current — and neither subsumes the other.
 */
internal fun DeviceControlSession.retainedIfStillActionable(
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
 * point early enough to beat the debounce. This check earns its place because not every fact update
 * comes from a stream message:
 * [dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorState] is also written by
 * programmatic paths (an initial hierarchy fetch, a manual refresh) that carry their own
 * declaration and never reach the collectors. A frame installed that way could otherwise
 * re-establish a space the stream had already moved off, with no reset.
 *
 * Both paths funnel into the same reset, so this is one mechanism observed at two points, not two
 * mechanisms. Each source is tracked independently because either can be the first to change, and a
 * source not seen yet is a baseline rather than a transition.
 *
 * Scope note: receipt-time detection plus this backstop close the windows the client can observe.
 * The residual sub-dispatch race — metadata flipping after a command has already left the queue —
 * cannot be closed from the client at all; it needs the input endpoints to accept a caller-declared
 * space, which is a wire change and deliberately out of scope here.
 */
internal fun DeviceControlSession.resetOnCoordinateSpaceTransition(inputs: DeviceControlInputs) {
  val screenshotFlipped = inputs.screenshot?.let { screenshotFactSpace.observe(it.coordinateSpace) }
  val hierarchyFlipped = inputs.hierarchy?.let { hierarchyFactSpace.observe(it.coordinateSpace) }
  val screenshotScaleChanged =
    inputs.screenshot?.let { screenshotFactNativeScale.observe(it.nativeScale) }
  val hierarchyScaleChanged =
    inputs.hierarchy?.let { hierarchyFactNativeScale.observe(it.nativeScale) }
  // The trackers already hold the new space, so this reset must NOT forget them — otherwise the
  // very next evaluate would re-establish a baseline and could see the same flip twice.
  val coordinateChanged = screenshotFlipped == true || hierarchyFlipped == true
  val scaleChanged = screenshotScaleChanged == true || hierarchyScaleChanged == true
  if (coordinateChanged || scaleChanged) {
    resetPreservingSpaceBaseline()
  }
}

/**
 * Whether [snapshot]'s coordinates can still be sent to the device: its declared [CoordinateSpace]
 * AND its capture rotation are both the ones the device is currently reporting
 * (issues #4550, #4502).
 *
 * Defence in depth, at the last possible moment. [onObservationSpaceDeclared] retires the
 * interaction snapshot as soon as the flip is observed, and that state is Compose-observable so the
 * view drops it promptly. Neither closes the gap for a click ALREADY in flight: a pointer event
 * captured the snapshot before the flip and reaches dispatch after it, and the view cannot
 * un-capture it. This is where that click stops.
 *
 * Only the coordinate-bearing actions consult it. [key] and its siblings carry no coordinate — they
 * use the snapshot solely for its device id, which a space change does not invalidate — so
 * rejecting them here would drop keystrokes for a reason that does not apply to them.
 *
 * Both properties are checked because both can invalidate a coordinate independently: a space flip
 * changes the UNIT the numbers are in, a rotation changes the AXES they are measured on, and a
 * frame is dispatchable only when both are current. Each reuses the value its own fix already
 * records — the stream space tracker and the proven source rotations — rather than introducing a
 * third notion of "current". A session that has observed neither accepts everything: there is
 * nothing to contradict.
 */
internal fun DeviceControlSession.coordinatesAreStillDispatchable(
  snapshot: DeviceFrameSnapshot,
): Boolean =
  staleContextRejectedFrameContext == null &&
    streamSpace.matches(snapshot.coordinateSpace) &&
    streamNativeScale.matches(snapshot.nativeScale) &&
    streamFrameContext.matches(snapshot.frameContext) &&
    rotationIsStillDispatchable(snapshot)

internal fun DeviceControlSession.rotationIsStillDispatchable(
  snapshot: DeviceFrameSnapshot,
): Boolean = lastProvenRotations.let { rotations ->
  rotations == null || (rotations.size == 1 && snapshot.rotation in rotations)
}

/**
 * A source can arrive before it pairs with its counterpart during a rotation. That unpaired source
 * still proves the device no longer has [retainedRotation], so retain display pixels if useful but
 * never retain their old coordinate mapping for a second input.
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
 * Keep a proven disagreement until every currently reported source can prove an agreeing rotation.
 * A missing or malformed value cannot prove the device returned to the prior rotation.
 */
internal fun DeviceControlSession.updateProvenRotations(inputs: DeviceControlInputs) {
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
