@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitTouchSlopOrCancellation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asSkiaBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.MONOTONIC_NOW_MS
import dev.jasonpearson.automobile.desktop.core.control.DeviceGestureStreamHandle
import dev.jasonpearson.automobile.desktop.core.control.DeviceKeyboardEventTranslator
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceGestureStreamCoalescer
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import dev.jasonpearson.automobile.desktop.domain.GestureStreamStep
import dev.jasonpearson.automobile.desktop.domain.TouchFeedbackModel
import dev.jasonpearson.automobile.desktop.domain.ViewportPoint
import org.jetbrains.skia.Image

private val IS_MAC = System.getProperty("os.name", "").contains("Mac", ignoreCase = true)

/**
 * Base radius, in frame pixels at zoom 1.0, of the transient control-tap feedback pulse
 * (issue #3352). Placed via `touchFeedbackCenter` (the canonical mapper through the marker's
 * captured bounds, #4546), and grown further as the pulse fades.
 */
private const val TOUCH_PULSE_BASE_RADIUS_PX = 12f

/**
 * Transform element bounds from the original (unrotated) hierarchy coordinate system to the rotated
 * display coordinate system.
 *
 * @param bounds Original bounds in hierarchy coordinates
 * @param rotation Device rotation (0=portrait, 1=landscape 270°CW, 2=reverse, 3=landscape 90°CW)
 * @param rootWidth Width of the root element in hierarchy coordinates (unrotated)
 * @param rootHeight Height of the root element in hierarchy coordinates (unrotated)
 * @return Transformed bounds as (left, top, width, height) in rotated coordinates
 */
private fun transformBoundsForRotation(
  bounds: ElementBounds,
  rotation: Int,
  rootWidth: Int,
  rootHeight: Int,
): FloatArray {
  // Returns [left, top, width, height] in the rotated coordinate space
  return when (rotation) {
    1 -> {
      // Landscape (home button on right): rotate 270° CW
      // Original (x, y) -> rotated (y, rootWidth - x - width)
      floatArrayOf(
        bounds.top.toFloat(),
        (rootWidth - bounds.right).toFloat(),
        bounds.height.toFloat(),
        bounds.width.toFloat(),
      )
    }
    2 -> {
      // Reverse portrait: rotate 180°
      floatArrayOf(
        (rootWidth - bounds.right).toFloat(),
        (rootHeight - bounds.bottom).toFloat(),
        bounds.width.toFloat(),
        bounds.height.toFloat(),
      )
    }
    3 -> {
      // Reverse landscape (home button on left): rotate 90° CW
      // Original (x, y) -> rotated (rootHeight - y - height, x)
      floatArrayOf(
        (rootHeight - bounds.bottom).toFloat(),
        bounds.left.toFloat(),
        bounds.height.toFloat(),
        bounds.width.toFloat(),
      )
    }
    else -> {
      // No rotation
      floatArrayOf(
        bounds.left.toFloat(),
        bounds.top.toFloat(),
        bounds.width.toFloat(),
        bounds.height.toFloat(),
      )
    }
  }
}

private fun PointerEvent.isZoomModifierPressed(): Boolean =
  if (IS_MAC) keyboardModifiers.isMetaPressed else keyboardModifiers.isCtrlPressed

/**
 * The one key-event handler for the device screen, which — like the drag gesture — means different
 * things per mode (issue #3351).
 *
 * - **Inspector** — Escape deselects, exactly as before. No daemon input is ever produced from this
 *   mode, which is what keeps the IDE plugin (inspector-only) unchanged.
 * - **Control** — the keystroke is translated to a Compose-free
 *   [dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke] and offered to the caller, which
 *   applies the pure `DeviceKeyboardInputPolicy` and answers whether it forwarded anything.
 *
 * Returning that answer as the handler's own result is the whole host-shortcut guarantee, and it is
 * stock Compose rather than hand-rolled interception: `onKeyEvent` consumes the event only when it
 * returns true, and an unconsumed event keeps bubbling to ancestor handlers and on to the host's
 * window shortcuts. So a chord the policy declines is *not* swallowed, by construction — there is
 * no separate "pass it on" path that could fall out of step with the policy.
 *
 * Only [KeyEventType.KeyDown] forwards. The matching KeyUp is left unconsumed so a host that tracks
 * key releases still sees them; forwarding both would send every keystroke to the device twice.
 *
 * @param controlFrame the pinned snapshot + geometry; null makes control-mode keyboard inert, the
 *   same fail-closed rule the tap and drag paths use.
 * @param onControlKey receives the snapshot the keystroke belongs to and the translated stroke, and
 *   returns whether the event was consumed. Null makes control-mode keyboard inert.
 */
private fun handleDeviceScreenKeyEvent(
  keyEvent: KeyEvent,
  controlMode: DeviceScreenControlMode,
  controlFrame: Pair<DeviceFrameSnapshot, DeviceScreenGeometry>?,
  onControlKey: ((DeviceFrameSnapshot, DeviceKeyStroke) -> Boolean)?,
  selectedElementId: String?,
  onElementSelected: (String?) -> Unit,
): Boolean {
  if (controlMode == DeviceScreenControlMode.Control) {
    if (keyEvent.type != KeyEventType.KeyDown) return false
    val snapshot = controlFrame?.first ?: return false
    val forward = onControlKey ?: return false
    return forward(snapshot, DeviceKeyboardEventTranslator.translate(keyEvent))
  }
  // Inspector mode: Escape deselects (unchanged behavior).
  if (keyEvent.key == Key.Escape && selectedElementId != null) {
    onElementSelected(null)
    return true
  }
  return false
}

/**
 * The one pointer-drag gesture for the device screen, which means different things per mode
 * (issue #3350).
 *
 * - **Inspector** — a drag pans the viewport, exactly as before. No daemon input is ever produced
 *   from this mode, which is what keeps the IDE plugin (inspector-only) unchanged.
 * - **Control** — a plain drag is a device swipe. Viewport pan stays available on the modifier that
 *   already gates zoom (Cmd on macOS, Ctrl elsewhere), so control mode loses no navigation
 *   affordance; the modifier is read once at pointer-down, so releasing it mid-drag cannot turn a
 *   pan into a swipe.
 *
 * Which frame the swipe maps through is decided **once**, at pointer-down, by reading
 * [controlFrame] a single time: both endpoints are mapped with that geometry, so a snapshot
 * arriving mid-drag cannot rescale the gesture or split it across two frames. This mirrors what the
 * tap path does with one read per click.
 *
 * A cancelled drag (`drag` returning false — pointer capture lost, window deactivated) emits
 * nothing. Threshold and out-of-bounds rules are deliberately **not** applied here; they belong to
 * the pure `DeviceDragGesturePolicy` the caller runs, so a non-Compose client shares them.
 *
 * @param controlFrame reads the current snapshot + its mapping geometry; null makes control-mode
 *   drag inert (the caller is rendering inspector mode anyway).
 * @param onPan receives each incremental pan delta, in viewport pixels — including the travel past
 *   touch slop on the move that crossed it, which `awaitTouchSlopOrCancellation` reports separately
 *   from the drag loop. The sum of the deltas therefore depends only on the pointer's total
 *   displacement, not on how many move events it arrived in.
 * @param onSwipe receives the pinned snapshot and the raw mapped start/end. Never called in
 *   inspector mode, on a pan, or on a cancelled drag.
 */
private suspend fun PointerInputScope.deviceScreenDragGestures(
  controlMode: DeviceScreenControlMode,
  controlFrame: () -> Pair<DeviceFrameSnapshot, DeviceScreenGeometry>?,
  onPan: (Offset) -> Unit,
  onSwipe: (DeviceFrameSnapshot, DevicePoint, DevicePoint, Int) -> Unit,
  /**
   * Streaming (real-time) drag seam (issue: streaming gesture input). Called once, at touch-slop,
   * in control mode with the pinned snapshot and the mapped down point; a non-null handle means the
   * drag streams live (incremental [DeviceGestureStreamHandle.move]s throttled to frame cadence,
   * then [DeviceGestureStreamHandle.end] on release/cancel) instead of firing the atomic [onSwipe].
   * Null — the default, or a null return — keeps the atomic path, so the flag-off and inspector
   * cases are exactly the previous behavior.
   */
  beginGestureStream: ((DeviceFrameSnapshot, DevicePoint) -> DeviceGestureStreamHandle?)? = null,
) {
  awaitEachGesture {
    val down = awaitFirstDown(requireUnconsumed = false)
    val panning =
      controlMode != DeviceScreenControlMode.Control || currentEvent.isZoomModifierPressed()
    // Pin the mapping authority for the WHOLE drag at pointer-down.
    val frame = if (panning) null else controlFrame() ?: return@awaitEachGesture
    // The move that CROSSES touch slop carries real travel past the slop threshold, and it is
    // reported here rather than in the drag loop below. Dropping it would make a
    // one-move-then-release pan move the viewport by exactly zero, and leave any longer pan
    // permanently lagging the pointer by that first delta. Applying `overSlop` is what the stock
    // `detectDragGestures` this replaced already did.
    var overSlop = Offset.Zero
    val change =
      awaitTouchSlopOrCancellation(down.id) { changed, crossed ->
        changed.consume()
        overSlop = crossed
      } ?: return@awaitEachGesture
    // Pan only: a swipe reports its endpoints from `down.position` and the last drag position, so
    // it neither needs nor is affected by this delta.
    if (panning) onPan(overSlop)
    var lastPosition = change.position
    // Track the pointer's own event timestamps so a swipe can be replayed at the speed the user
    // flicked (issue: fling strength). `uptimeMillis` is the toolkit's monotonic event clock, so
    // last-minus-down is the real gesture duration regardless of how many move events arrived.
    var lastUptimeMs = change.uptimeMillis

    // Decide stream vs atomic once, now that this is confirmed a control drag (past slop). The
    // handle, if any, owns this drag until release; the coalescer throttles host samples to the
    // wire cadence. Both stay null on a pan, in inspector mode, or when streaming is unavailable.
    val streaming =
      if (!panning && frame != null) {
        val (snapshot, geometry) = frame
        val downDevice =
          DeviceScreenCoordinateMapper.viewportToDevice(
            ViewportPoint(down.position.x, down.position.y),
            geometry,
          )
        beginGestureStream?.invoke(snapshot, downDevice)
      } else {
        null
      }
    val coalescer = if (streaming != null) DeviceGestureStreamCoalescer() else null

    val completed =
      drag(change.id) { dragged ->
        // Read the delta BEFORE consuming: `positionChange()` reports Offset.Zero once the change
        // is consumed, so consuming first silently zeroes every pan step.
        val delta = dragged.positionChange()
        dragged.consume()
        if (panning) onPan(delta)
        lastPosition = dragged.position
        lastUptimeMs = dragged.uptimeMillis
        if (streaming != null && coalescer != null && frame != null) {
          val geometry = frame.second
          val moved =
            DeviceScreenCoordinateMapper.viewportToDevice(
              ViewportPoint(dragged.position.x, dragged.position.y),
              geometry,
            )
          // Throttle to the frame cadence; a coalesced sample is superseded by a later move or the
          // exact release point sent below, so nothing visible is lost.
          if (coalescer.offer(moved.x, moved.y, dragged.uptimeMillis) is GestureStreamStep.Emit) {
            streaming.move(moved)
          }
        }
      }

    if (streaming != null && frame != null) {
      // A streamed drag ends on release with the exact final point; a cancelled drag (pointer
      // capture lost, window deactivated) lifts in place so a partial drag is abandoned cleanly.
      val geometry = frame.second
      val endDevice =
        DeviceScreenCoordinateMapper.viewportToDevice(
          ViewportPoint(lastPosition.x, lastPosition.y),
          geometry,
        )
      streaming.end(endDevice, cancel = !completed)
      return@awaitEachGesture
    }

    if (!completed || frame == null) return@awaitEachGesture
    val (snapshot, geometry) = frame
    val gestureDurationMs = (lastUptimeMs - down.uptimeMillis).coerceAtLeast(0L).toInt()
    onSwipe(
      snapshot,
      DeviceScreenCoordinateMapper.viewportToDevice(
        ViewportPoint(down.position.x, down.position.y),
        geometry,
      ),
      DeviceScreenCoordinateMapper.viewportToDevice(
        ViewportPoint(lastPosition.x, lastPosition.y),
        geometry,
      ),
      gestureDurationMs,
    )
  }
}

/**
 * Device screen view with screenshot display, zoom/pan controls, and element overlays. Supports:
 * - Zoom via scroll wheel (centered on cursor)
 * - Pan via mouse drag
 * - Click to select elements (finds deepest element at point)
 * - Hover highlighting
 * - Selected element overlay (blue border)
 * - Hovered element overlay (gray border)
 */
@Composable
fun DeviceScreenView(
  screenshotData: ByteArray?,
  /**
   * A decoded live-mirroring frame. When present it renders instead of [screenshotData], so the
   * caller can fall back to polled screenshots simply by passing null.
   */
  liveFrame: ImageBitmap? = null,
  screenWidth: Int,
  screenHeight: Int,
  rotation: Int = 0,
  hierarchy: UIElementInfo?,
  selectedElementId: String?,
  hoveredElementId: String?,
  flashElementId: String? = null,
  onFlashComplete: () -> Unit = {},
  onElementSelected: (String?) -> Unit,
  onElementHovered: (String?) -> Unit,
  showTapTargetIssues: Boolean = false,
  onToggleTapTargetIssues: () -> Unit = {},
  connectionStatus: ConnectionStatus = ConnectionStatus.Connected,
  socketExists: Boolean = true,
  onRestartDaemon: (() -> Unit)? = null,
  elementMap: Map<String, UIElementInfo>? = null,
  modifier: Modifier = Modifier,
  refitTrigger: Any? = null, // When this changes, refit the view to center
  /**
   * Interaction contract for the view. Defaults to [DeviceScreenControlMode.Inspector] so every
   * existing call site keeps today's behavior (click selects elements, hover highlights) with no
   * source change. Pass [DeviceScreenControlMode.Control] to opt into device-control mapping: a
   * click is converted to a device coordinate via [DeviceScreenCoordinateMapper] and reported to
   * [onControlTap] instead of selecting. This view never sends daemon input itself; forwarding the
   * coordinate to the typed daemon input helpers is the caller's job (issue #3347).
   */
  controlMode: DeviceScreenControlMode = DeviceScreenControlMode.Inspector,
  /**
   * The atomic frame snapshot control clicks are mapped through (issue #3348). Required for control
   * mode to do anything: the device-coordinate bounds come from
   * [DeviceFrameSnapshot.deviceWidth]/[DeviceFrameSnapshot.deviceHeight] rather than from this
   * view's own (independently updating) [hierarchy] and [screenWidth]/[screenHeight] params, so a
   * resolution change the hierarchy has not caught up to cannot mis-scale a tap — even when the old
   * and new resolutions share an aspect ratio, which no dimension comparison can detect.
   */
  controlSnapshot: DeviceFrameSnapshot? = null,
  /**
   * Called in [DeviceScreenControlMode.Control] with the snapshot a click was mapped through and
   * the resulting device coordinate. Both are read from a single value, so they are inherently the
   * same frame: a snapshot swap between the click and the caller's dispatch cannot change the
   * mapping this point was produced with. The point carries [DevicePoint.inBounds]; a null default
   * makes control mode inert until a caller wires it. No-op in inspector mode.
   *
   * Returns whether the tap was actually **forwarded** — dispatched to the device AND accepted by
   * the caller's input queue (false for an off-screen point or a full queue). The view uses that
   * answer to decide whether to show the transient touch pulse (issue #3352), so a tap that never
   * reached the device shows no success feedback. The inert null default counts as not forwarded.
   */
  onControlTap: ((DeviceFrameSnapshot, DevicePoint) -> Boolean)? = null,
  /**
   * Called in [DeviceScreenControlMode.Control] when a pointer drag completes, with the snapshot
   * the drag began on and the raw mapped start/end device coordinates (issue #3350). Both endpoints
   * are mapped through that ONE snapshot, pinned at pointer-down, so a snapshot arriving mid-drag
   * cannot rescale the gesture or map its two ends through different frames.
   *
   * The points are raw: whether the drag is long enough to be a swipe, and what to do with an
   * endpoint that left the screen, are decided by the caller through the Compose-free
   * [dev.jasonpearson.automobile.desktop.domain.DeviceDragGesturePolicy] — so a third-party daemon
   * client shares the policy rather than reimplementing it. A null default makes control-mode drag
   * inert until a caller wires it; in inspector mode a drag still pans the viewport and this is
   * never called.
   *
   * The trailing `Int` is the gesture's duration in milliseconds (host pointer-down to release),
   * which the caller feeds to the policy so the device swipe replays at the speed the user flicked
   * — that is what makes a fast flick produce a strong fling rather than a fixed, gentle glide.
   */
  onControlSwipe: ((DeviceFrameSnapshot, DevicePoint, DevicePoint, Int) -> Unit)? = null,
  /**
   * Streaming (real-time) drag seam (issue: streaming gesture input). In
   * [DeviceScreenControlMode.Control], called once at touch-slop with the pinned snapshot and the
   * mapped down point; a non-null [DeviceGestureStreamHandle] means this drag streams live — the
   * view feeds it throttled incremental moves and the release — instead of firing the atomic
   * [onControlSwipe]. A null return (or the null default) keeps the atomic path, so the streaming
   * flag being off, an unsupported daemon/runner, and inspector mode are all exactly today's
   * behavior. The caller (holding [DeviceControlSession]) applies the flag and capability gates.
   */
  onControlGestureStreamBegin: ((DeviceFrameSnapshot, DevicePoint) -> DeviceGestureStreamHandle?)? =
    null,
  /**
   * Called in [DeviceScreenControlMode.Control] for each key press this view receives **while it
   * holds keyboard focus**, with the snapshot the keystroke belongs to and the toolkit-free
   * [DeviceKeyStroke] it translated to (issue #3351). Returns whether the caller forwarded anything
   * to the device; the view uses that answer verbatim as its `onKeyEvent` result, so a keystroke
   * the caller declines stays **unconsumed** and continues to the host's own shortcut handling.
   *
   * The stroke is raw: which keys become a device button, which become a discrete key event, which
   * become typed text, and which are refused as host chords are decided by the caller through the
   * Compose-free [dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardInputPolicy] — so a
   * third-party daemon client shares the policy rather than reimplementing it. A null default makes
   * control-mode keyboard inert; in inspector mode Escape still deselects and this is never called.
   */
  onControlKey: ((DeviceFrameSnapshot, DeviceKeyStroke) -> Boolean)? = null,
  /**
   * Called whenever this view gains or loses keyboard focus (issue #3351).
   *
   * A host embedding control mode needs this to know when the device owns the keyboard — the
   * desktop shell uses it to stand its preview-level navigation shortcuts down, since those would
   * otherwise consume Tab, the arrows, Enter and Escape before the focused canvas ever saw them.
   * Reported in every mode; a host that only cares about control mode combines it with its own mode
   * state.
   */
  onControlFocusChanged: ((Boolean) -> Unit)? = null,
) {
  val colors = SharedTheme.globalColors

  // Keep the latest control-tap callback readable from the long-lived tap gesture coroutine, so a
  // callback that changes (e.g. null -> real once the daemon connection is ready) is honored
  // without
  // restarting the gesture. Matches the rememberUpdatedState pattern used by SplitPane's drag.
  val currentOnControlTap by rememberUpdatedState(onControlTap)
  // Same reasoning for the drag callback: the gesture coroutine is keyed on controlMode alone, so
  // it must read the LATEST callback rather than the one captured when the gesture started.
  val currentOnControlSwipe by rememberUpdatedState(onControlSwipe)
  // Same reasoning for the streaming-drag begin callback (issue: streaming gesture input).
  val currentOnControlGestureStreamBegin by rememberUpdatedState(onControlGestureStreamBegin)
  // Same reasoning again for the key callback (issue #3351).
  val currentOnControlKey by rememberUpdatedState(onControlKey)
  val currentOnControlFocusChanged by rememberUpdatedState(onControlFocusChanged)

  // Leaving inspector mode must drop the inspector affordances already drawn: the Move guard only
  // suppresses future hover updates, and the selection/hover overlays render unconditionally from
  // the incoming ids. Clearing both here honors the Control-mode contract ("Selecting and
  // hover-highlighting are suppressed") so control mode gets an unobstructed screen.
  LaunchedEffect(controlMode) {
    if (controlMode != DeviceScreenControlMode.Inspector) {
      onElementHovered(null)
      onElementSelected(null)
    }
  }

  // Transient touch-point feedback for a forwarded control-mode tap (issue #3352). A control-mode
  // tap otherwise produces no on-canvas confirmation until the device redraws, so a brief pulse at
  // the tapped device coordinate tells the user the click registered and was forwarded. The fade
  // math is the pure, unit-tested TouchFeedbackModel; this composable only owns the per-frame tick
  // that drives the fade. Inert in inspector mode, so the IDE plugin is unaffected.
  //
  // The model ages markers on MONOTONIC_NOW_MS (#3348's monotonic source), NOT the wall clock: a
  // wall-clock step backward would clamp elapsed to 0 and spin this recompose loop every frame
  // until real time caught up (a stuck pulse + sustained CPU). The tick below advances on the same
  // monotonic source so recompose time and aging time agree.
  val touchFeedback = remember { TouchFeedbackModel(nowMs = MONOTONIC_NOW_MS) }
  var touchFeedbackTick by remember { mutableStateOf(0L) }
  // Bumped on each recorded pulse so the tick effect (re)launches; the loop exits on its own once
  // nothing is left to fade, so it never spins while the screen is idle.
  var touchFeedbackGeneration by remember { mutableStateOf(0) }
  LaunchedEffect(controlMode) {
    if (controlMode != DeviceScreenControlMode.Control) touchFeedback.reset()
  }
  // Drop pulses when the device frame changes shape mid-fade (issues #3352, #4546): a marker is
  // placed by mapping its captured device point through its captured bounds, which only holds
  // while the frame keeps the aspect it was captured against. Both a portrait<->landscape flip AND
  // a same-orientation aspect change (1080x2340 -> 1080x1920) reshape the frame, so keying on the
  // snapshot dimensions fires the cleanup on any dimension change; the model's aspect-tolerance
  // rule then retains equal-aspect pulses (a plain resolution change keeps them) and drops the
  // reshaped ones.
  val controlSnapshotDims = controlSnapshot?.let { it.deviceWidth to it.deviceHeight }
  LaunchedEffect(controlSnapshotDims) {
    controlSnapshot?.let { touchFeedback.retainOnlyMatchingAspect(it.deviceWidth, it.deviceHeight) }
  }
  LaunchedEffect(touchFeedbackGeneration, controlMode) {
    if (controlMode != DeviceScreenControlMode.Control) return@LaunchedEffect
    while (touchFeedback.hasActive()) {
      withFrameMillis { touchFeedbackTick = MONOTONIC_NOW_MS() }
    }
  }
  // Resolved during composition (a pure read) so the draw closure never mutates state. Reading
  // touchFeedbackTick here subscribes the overlay to the per-frame tick so it re-composes while a
  // pulse is fading; the model resolves the fade against its own monotonic clock, not this value.
  val activeTouchFeedback =
    if (controlMode == DeviceScreenControlMode.Control) {
      touchFeedbackTick.let { touchFeedback.active() }
    } else {
      emptyList()
    }

  // Zoom and pan state
  var scale by remember { mutableFloatStateOf(1f) }
  var offsetX by remember { mutableFloatStateOf(0f) }
  var offsetY by remember { mutableFloatStateOf(0f) }
  var hasInitialFit by remember { mutableStateOf(false) }

  // Track refitTrigger to reset fit state when panels change
  var lastRefitTrigger by remember { mutableStateOf<Any?>(null) }

  // Track previous viewport dimensions for auto-centering on resize
  var prevViewportWidth by remember { mutableFloatStateOf(0f) }
  var prevViewportHeight by remember { mutableFloatStateOf(0f) }

  // Decode raw screenshot without rotation. A live frame is already decoded and already in
  // display orientation, so it short-circuits both this and the rotation correction below.
  val decodedScreenshot =
    remember(screenshotData) {
      screenshotData?.let {
        try {
          Image.makeFromEncoded(it).toComposeImageBitmap()
        } catch (e: Exception) {
          null
        }
      }
    }
  val rawBitmap = liveFrame ?: decodedScreenshot

  // Detect rotation needed to align the screenshot with the hierarchy coordinate system.
  // iOS screenshots arrive in native pixel orientation (portrait) even when the device
  // is landscape, while hierarchy bounds are in display orientation — so we must rotate
  // the screenshot to match. Some Android screenshots may also need rotation.
  // We auto-detect by comparing screenshot image dimensions to the hierarchy coordinate
  // space dimensions (root bounds, or screenWidth/screenHeight as fallback when the
  // root node has no explicit bounds — common for Android accessibility service).
  val screenshotRotation =
    remember(rawBitmap, hierarchy, screenWidth, screenHeight) {
      val imgW = rawBitmap?.width ?: 0
      val imgH = rawBitmap?.height ?: 0
      // Prefer root bounds; fall back to screenWidth/screenHeight when root has no bounds
      // (Android accessibility service root nodes typically have (0,0,0,0)).
      val rootW = hierarchy?.bounds?.width?.takeIf { it > 0 } ?: screenWidth
      val rootH = hierarchy?.bounds?.height?.takeIf { it > 0 } ?: screenHeight
      // Compose-free rotation detection lives in DeviceScreenCoordinateMapper so daemon clients
      // (and the coordinate-mapping tests) share exactly this rule.
      DeviceScreenCoordinateMapper.detectScreenshotRotation(imgW, imgH, rootW, rootH)
    }

  // Rotate the raw bitmap to align with the hierarchy coordinate system.
  // After this, overlays and hit testing use direct coordinate mapping.
  val imageBitmap =
    remember(rawBitmap, screenshotRotation) {
      val original = rawBitmap ?: return@remember null
      if (screenshotRotation == 0) return@remember original

      val angleDegrees =
        when (screenshotRotation) {
          1 -> 270f
          2 -> 180f
          3 -> 90f
          else -> return@remember original
        }

      try {
        val w = original.width
        val h = original.height
        val swapDims = screenshotRotation == 1 || screenshotRotation == 3
        val newW = if (swapDims) h else w
        val newH = if (swapDims) w else h

        // Reuse the bitmap decoded above rather than decoding the bytes a second time. This is
        // also what makes rotation work for live frames, which have no encoded bytes at all.
        val skiaImage = Image.makeFromBitmap(original.asSkiaBitmap())
        val surface = org.jetbrains.skia.Surface.makeRasterN32Premul(newW, newH)
        val canvas = surface.canvas
        canvas.translate(newW / 2f, newH / 2f)
        canvas.rotate(angleDegrees)
        canvas.translate(-w / 2f, -h / 2f)
        canvas.drawImage(skiaImage, 0f, 0f)
        surface.makeImageSnapshot().toComposeImageBitmap()
      } catch (e: Exception) {
        original
      }
    }

  // Screenshot has been rotated to match hierarchy, so no bounds rotation is needed.
  // All overlay and hit testing code uses identity transforms (boundsRotation=0).
  val boundsRotation = 0
  val isLandscape = false

  // Find selected and hovered elements — O(1) map lookups instead of DFS
  val selectedElement =
    remember(elementMap, selectedElementId) {
      selectedElementId?.let { elementMap?.get(it) }
    }

  val hoveredElement =
    remember(elementMap, hoveredElementId) {
      hoveredElementId?.let { elementMap?.get(it) }
    }

  // Flash element for highlight animation on double-click
  val flashElement =
    remember(elementMap, flashElementId) {
      flashElementId?.let { elementMap?.get(it) }
    }

  // Flash animation state
  var flashAlpha by remember { mutableFloatStateOf(0f) }
  LaunchedEffect(flashElementId) {
    if (flashElementId != null) {
      // Animate flash: bright -> fade out
      repeat(3) { // 3 flashes
        flashAlpha = 0.8f
        kotlinx.coroutines.delay(100)
        flashAlpha = 0.3f
        kotlinx.coroutines.delay(100)
      }
      flashAlpha = 0f
      onFlashComplete()
    }
  }

  // Find non-compliant tap targets (clickable elements smaller than 48x48dp)
  val nonCompliantElements =
    remember(hierarchy, screenWidth, screenHeight, showTapTargetIssues) {
      if (showTapTargetIssues && hierarchy != null && screenWidth > 0 && screenHeight > 0) {
        findNonCompliantTapTargets(hierarchy, screenWidth, screenHeight)
      } else {
        emptyList()
      }
    }

  Column(modifier = modifier) {
    // Tap target compliance toggle - top padding to clear the Layout/Navigation toggle overlay
    TapTargetComplianceToggle(
      enabled = showTapTargetIssues,
      issueCount = nonCompliantElements.size,
      onToggle = onToggleTapTargetIssues,
      modifier = Modifier.padding(top = 36.dp),
    )

    // Screenshot viewport
    BoxWithConstraints(
      modifier =
        Modifier.weight(1f).fillMaxWidth().background(colors.text.normal.copy(alpha = 0.03f))
    ) {
      val viewportWidth = constraints.maxWidth.toFloat()
      val viewportHeight = constraints.maxHeight.toFloat()

      // Use actual image dimensions if available, otherwise fall back to screen dimensions
      // This ensures frame sizing and hit testing match the actual screenshot
      val effectiveWidth = imageBitmap?.width ?: screenWidth
      val effectiveHeight = imageBitmap?.height ?: screenHeight

      // Calculate device frame size that fits viewport while maintaining aspect ratio.
      // The aspect-fit math lives in the Compose-free DeviceScreenCoordinateMapper so it is unit
      // tested and reusable by daemon clients.
      val padding = DeviceScreenCoordinateMapper.DEFAULT_PADDING
      val fittedFrame =
        DeviceScreenCoordinateMapper.fitToViewport(
          imageWidth = effectiveWidth,
          imageHeight = effectiveHeight,
          viewportWidth = viewportWidth,
          viewportHeight = viewportHeight,
          padding = padding,
        )
      val frameWidthPx: Float = fittedFrame.widthPx
      val frameHeightPx: Float = fittedFrame.heightPx

      // Scale factor from frame pixels to device pixels (for aspect ratio calculations only)
      val frameToDeviceScale = if (frameWidthPx > 0) effectiveWidth.toFloat() / frameWidthPx else 1f

      // The hierarchy coordinate space width/height, used for mapping overlays and hit testing.
      // Prefer root element bounds; fall back to screenWidth/screenHeight when the root
      // has no explicit bounds (common for Android), then to image dimensions.
      val rootBoundsWidth =
        hierarchy?.bounds?.width?.takeIf { it > 0 }
          ?: screenWidth.takeIf { it > 0 }
          ?: effectiveWidth
      val rootBoundsHeight =
        hierarchy?.bounds?.height?.takeIf { it > 0 }
          ?: screenHeight.takeIf { it > 0 }
          ?: effectiveHeight
      // The "rotated root width" is the root dimension that maps to the frame width
      val rotatedRootWidth = if (isLandscape) rootBoundsHeight else rootBoundsWidth

      // Reset fit state when refitTrigger changes (e.g., panels toggled)
      LaunchedEffect(refitTrigger) {
        if (refitTrigger != null && refitTrigger != lastRefitTrigger) {
          lastRefitTrigger = refitTrigger
          hasInitialFit = false // Allow refit to happen
        }
      }

      // Auto-center when viewport dimensions change (window resize)
      LaunchedEffect(viewportWidth, viewportHeight) {
        if (hasInitialFit && prevViewportWidth > 0 && prevViewportHeight > 0) {
          // Adjust offset to keep content centered when viewport resizes
          val deltaX = (viewportWidth - prevViewportWidth) / 2
          val deltaY = (viewportHeight - prevViewportHeight) / 2
          offsetX += deltaX
          offsetY += deltaY
        }
        prevViewportWidth = viewportWidth
        prevViewportHeight = viewportHeight
      }

      // Auto-fit on initial load or when refit is triggered
      LaunchedEffect(viewportWidth, viewportHeight, frameWidthPx, frameHeightPx, hasInitialFit) {
        if (!hasInitialFit && viewportWidth > 0 && viewportHeight > 0 && frameWidthPx > 0) {
          // Calculate scale needed to fit device in viewport (Compose-free, unit-tested).
          // The frame is already sized to fit, so scale 1.0 should fit; a very narrow viewport may
          // need to scale down further.
          val fitScale =
            DeviceScreenCoordinateMapper.fitScale(
              frameWidthPx = frameWidthPx,
              frameHeightPx = frameHeightPx,
              viewportWidth = viewportWidth,
              viewportHeight = viewportHeight,
              padding = padding,
            )

          // Only change scale if it would increase (don't auto-shrink on window resize)
          // This allows expanding when window grows but keeps current zoom when shrinking
          if (fitScale > scale || scale == 1f) {
            scale = fitScale
          }
          // Center the device frame in viewport
          offsetX = (viewportWidth - frameWidthPx * scale) / 2
          offsetY = (viewportHeight - frameHeightPx * scale) / 2
          hasInitialFit = true
          // Initialize previous viewport dimensions
          prevViewportWidth = viewportWidth
          prevViewportHeight = viewportHeight
        }
      }

      // Zoom helper
      fun zoomAroundPoint(newScale: Float, pivotX: Float, pivotY: Float) {
        val oldScale = scale
        val contentX = (pivotX - offsetX) / oldScale
        val contentY = (pivotY - offsetY) / oldScale
        scale = newScale
        offsetX = pivotX - contentX * newScale
        offsetY = pivotY - contentY * newScale
      }

      fun zoomAroundCenter(newScale: Float) {
        zoomAroundPoint(newScale, viewportWidth / 2, viewportHeight / 2)
      }

      // Current viewport<->device geometry. deviceWidth/deviceHeight are the hierarchy bounds
      // coordinate space (== element.bounds), so mapped points feed findElementAt directly.
      // The tap/hover pointer coroutines below are retained across recomposition (keyed only on
      // hierarchy/controlMode), so they must read the LATEST geometry rather than the frame size
      // captured when the gesture started — otherwise a viewport or screenshot resize would map
      // clicks through a stale frame and report wrong device coordinates. rememberUpdatedState
      // republishes the snapshot on every recomposition (scale/offset are mutableState and the
      // frame dims are plain vals that only change on recomposition), and the gesture reads .value
      // live. Matches the onControlTap fix.
      val currentGeometry by
        rememberUpdatedState(
          DeviceScreenGeometry(
            frameWidthPx = frameWidthPx,
            frameHeightPx = frameHeightPx,
            scale = scale,
            offsetX = offsetX,
            offsetY = offsetY,
            deviceWidth = rotatedRootWidth,
            deviceHeight = rootBoundsHeight,
          )
        )

      // Convert a viewport point to device (== hierarchy bounds) coordinates for hit testing and
      // control-mode tapping. The screenshot is pre-rotated to the hierarchy orientation
      // (boundsRotation is always 0 here), so this is a plain unscale + unpan with no rotation.
      // The math lives in the Compose-free DeviceScreenCoordinateMapper so daemon clients share it.
      fun screenToDevice(screenX: Float, screenY: Float): DevicePoint =
        DeviceScreenCoordinateMapper.viewportToDevice(
          ViewportPoint(screenX, screenY),
          currentGeometry,
        )

      // The control-mode mapping authority (issue #3348): the snapshot plus the geometry derived
      // from ITS device bounds, published as ONE value. The tap gesture reads it once, so the
      // point it produces and the snapshot it reports are always the same frame — there is no
      // window in which the snapshot could advance between the two reads. Null whenever no
      // snapshot is available, which makes control mode inert (the caller is already rendering
      // inspector mode in that case).
      val controlFrame by
        rememberUpdatedState(
          controlSnapshot?.let { snapshot ->
            snapshot to
              currentGeometry.copy(
                deviceWidth = snapshot.deviceWidth,
                deviceHeight = snapshot.deviceHeight,
              )
          }
        )

      // Focus requester for keyboard events
      val focusRequester = remember { FocusRequester() }

      // Request focus when an element is selected
      LaunchedEffect(selectedElementId) {
        if (selectedElementId != null) {
          focusRequester.requestFocus()
        }
      }

      // Entering control mode takes keyboard focus (issue #3351). Focus is the ONLY gate on
      // keyboard forwarding — Compose delivers a key event to `onKeyEvent` only when this node is
      // on the focus path — so without this the view would be in control mode and yet never see a
      // keystroke: control mode clears the selection, and the effect above is the only other thing
      // that ever asked for focus. Nothing is grabbed in inspector mode, so the IDE plugin's focus
      // behavior is untouched.
      LaunchedEffect(controlMode) {
        if (controlMode == DeviceScreenControlMode.Control) {
          focusRequester.requestFocus()
        }
      }

      Box(
        modifier =
          Modifier.fillMaxSize()
            .clipToBounds()
            .focusRequester(focusRequester)
            .onFocusChanged { state -> currentOnControlFocusChanged?.invoke(state.isFocused) }
            .focusTarget()
            .onKeyEvent { keyEvent ->
              handleDeviceScreenKeyEvent(
                keyEvent = keyEvent,
                controlMode = controlMode,
                controlFrame = controlFrame,
                onControlKey = currentOnControlKey,
                selectedElementId = selectedElementId,
                onElementSelected = onElementSelected,
              )
            }
            // Kept where the pan gesture always was, ahead of the tap detector. A drag consumes
            // every change once it passes touch slop, and the tap detector's Final-pass consume
            // check sees that regardless of which modifier is declared first — so one drag yields a
            // swipe and NO tap either way (`a control-mode drag reports one swipe and no tap`
            // pins it).
            .pointerInput(controlMode) {
              // One drag gesture, two meanings (issue #3350): pan in inspector mode, a device
              // swipe in control mode (pan moves onto the zoom modifier there). Keyed on
              // controlMode so a mode change restarts it with the right meaning.
              deviceScreenDragGestures(
                controlMode = controlMode,
                controlFrame = { controlFrame },
                onPan = { delta ->
                  offsetX += delta.x
                  offsetY += delta.y
                },
                onSwipe = { snapshot, start, end, durationMs ->
                  currentOnControlSwipe?.invoke(snapshot, start, end, durationMs)
                },
                beginGestureStream = { snapshot, downPoint ->
                  currentOnControlGestureStreamBegin?.invoke(snapshot, downPoint)
                },
              )
            }
            .pointerInput(hierarchy, controlMode) {
              detectTapGestures { offset ->
                when (controlMode) {
                  // Control mode: map through the clicked snapshot and report both, for a caller
                  // to forward to the daemon input helpers (issues #3347, #3348). This view never
                  // sends input itself. One read of controlFrame supplies both the mapping bounds
                  // and the reported snapshot, so they cannot disagree.
                  DeviceScreenControlMode.Control -> {
                    // Clicking the mirrored screen restores keyboard focus (issue #3351). The
                    // mode-entry effect only fires when controlMode CHANGES, so once anything else
                    // took focus — the shell's Tab handler moving panes, a side panel — clicking
                    // the device would otherwise leave every keystroke with the host, with no
                    // visible reason why. Clicking the thing you want to type into is the
                    // universal way to focus it.
                    focusRequester.requestFocus()
                    val frame = controlFrame
                    if (frame != null) {
                      val (snapshot, geometry) = frame
                      val point =
                        DeviceScreenCoordinateMapper.viewportToDevice(
                          ViewportPoint(offset.x, offset.y),
                          geometry,
                        )
                      // Pulse ONLY when the tap was actually forwarded and accepted (issue
                      // #3352): the callback answers dispatched-and-accepted, false for an
                      // off-screen point, a full queue, or an unwired (null) control view. Showing
                      // a
                      // marker for anything else would claim a success that never reached the
                      // device. The marker captures the snapshot's mapping bounds so it renders
                      // back
                      // through the same geometry the tap used and cannot drift mid-fade.
                      val forwarded = currentOnControlTap?.invoke(snapshot, point) ?: false
                      touchFeedback.recordIfForwarded(
                        forwarded = forwarded,
                        x = point.x,
                        y = point.y,
                        deviceWidth = snapshot.deviceWidth,
                        deviceHeight = snapshot.deviceHeight,
                      )
                      if (forwarded) {
                        touchFeedbackTick = MONOTONIC_NOW_MS()
                        touchFeedbackGeneration++
                      }
                    }
                  }
                  // Inspector mode: select the deepest element under the click (unchanged
                  // behavior).
                  DeviceScreenControlMode.Inspector ->
                    if (hierarchy != null) {
                      val point = screenToDevice(offset.x, offset.y)
                      val element =
                        LayoutInspectorMockData.findElementAt(hierarchy, point.x, point.y)
                      onElementSelected(element?.id)
                    }
                }
              }
            }
            .onPointerEvent(PointerEventType.Move) { event ->
              // Hover highlighting is an inspector-only affordance.
              if (controlMode == DeviceScreenControlMode.Inspector && hierarchy != null) {
                val pos = event.changes.firstOrNull()?.position
                if (pos != null) {
                  val point = screenToDevice(pos.x, pos.y)
                  val element = LayoutInspectorMockData.findElementAt(hierarchy, point.x, point.y)
                  onElementHovered(element?.id)
                }
              }
            }
            .onPointerEvent(PointerEventType.Exit) {
              onElementHovered(null)
            }
            .onPointerEvent(PointerEventType.Scroll) { event ->
              // Only allow zoom when Cmd (macOS) / Ctrl (other) is held
              if (!event.isZoomModifierPressed()) return@onPointerEvent
              val change = event.changes.firstOrNull() ?: return@onPointerEvent
              val scrollDelta = change.scrollDelta.y
              if (scrollDelta != 0f) {
                val zoomFactor = if (scrollDelta > 0) 0.95f else 1.05f
                val newScale = (scale * zoomFactor).coerceIn(0.1f, 5f)
                zoomAroundPoint(newScale, change.position.x, change.position.y)
              }
            }
      ) {
        // Device frame - sized to fit viewport with proper aspect ratio
        val localDensity = LocalDensity.current
        val frameWidthDp = with(localDensity) { frameWidthPx.toDp() }
        val frameHeightDp = with(localDensity) { frameHeightPx.toDp() }

        Box(
          modifier =
            Modifier.graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = offsetX
                translationY = offsetY
                transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0f)
              }
              .size(width = frameWidthDp, height = frameHeightDp)
        ) {
          // Screenshot or placeholder
          if (imageBitmap != null) {
            Image(
              bitmap = imageBitmap,
              contentDescription = "Device screenshot",
              modifier =
                Modifier.fillMaxSize().drawWithContent {
                  drawContent()

                  // Scale factor: drawing context is in frame pixels, bounds may be in:
                  // - iOS points (logical pixels, need scaling by screen scale factor)
                  // - Android pixels (device pixels, match screenshot directly)
                  //
                  // When rotated, the frame width corresponds to the rotated root dimension.
                  // We use rotatedRootWidth (computed above) so overlays align with the rotated
                  // screenshot.
                  val boundsToFrameScale =
                    if (rotatedRootWidth > 0) size.width / rotatedRootWidth.toFloat() else 1f

                  // Helper to get scaled overlay rect from element bounds,
                  // applying rotation transform before scaling.
                  fun overlayRect(bounds: ElementBounds): FloatArray {
                    val t =
                      transformBoundsForRotation(
                        bounds,
                        boundsRotation,
                        rootBoundsWidth,
                        rootBoundsHeight,
                      )
                    // t = [left, top, width, height] in rotated coords
                    return floatArrayOf(
                      t[0] * boundsToFrameScale,
                      t[1] * boundsToFrameScale,
                      t[2] * boundsToFrameScale,
                      t[3] * boundsToFrameScale,
                    )
                  }

                  // Draw element overlays
                  // Hovered element (gray)
                  if (hoveredElement != null && hoveredElement.id != selectedElementId) {
                    val r = overlayRect(hoveredElement.bounds)
                    drawRect(
                      color = Color.Gray.copy(alpha = 0.5f),
                      topLeft = Offset(r[0], r[1]),
                      size = Size(r[2], r[3]),
                      style = Stroke(width = 2f),
                    )
                  }

                  // Selected element (blue)
                  if (selectedElement != null) {
                    val r = overlayRect(selectedElement.bounds)
                    drawRect(
                      color = Color(0xFF2196F3),
                      topLeft = Offset(r[0], r[1]),
                      size = Size(r[2], r[3]),
                      style = Stroke(width = 3f),
                    )
                    // Fill with semi-transparent blue
                    drawRect(
                      color = Color(0xFF2196F3).copy(alpha = 0.1f),
                      topLeft = Offset(r[0], r[1]),
                      size = Size(r[2], r[3]),
                    )
                  }

                  // Flash element highlight (yellow/gold flash on double-click)
                  if (flashElement != null && flashAlpha > 0f) {
                    val r = overlayRect(flashElement.bounds)
                    // Draw bright yellow border
                    drawRect(
                      color = Color(0xFFFFD700).copy(alpha = flashAlpha),
                      topLeft = Offset(r[0], r[1]),
                      size = Size(r[2], r[3]),
                      style = Stroke(width = 4f),
                    )
                    // Fill with semi-transparent yellow
                    drawRect(
                      color = Color(0xFFFFD700).copy(alpha = flashAlpha * 0.3f),
                      topLeft = Offset(r[0], r[1]),
                      size = Size(r[2], r[3]),
                    )
                  }

                  // Non-compliant tap targets (orange/red)
                  if (showTapTargetIssues) {
                    for (element in nonCompliantElements) {
                      val r = overlayRect(element.bounds)
                      // Draw orange border
                      drawRect(
                        color = Color(0xFFFF6B00),
                        topLeft = Offset(r[0], r[1]),
                        size = Size(r[2], r[3]),
                        style = Stroke(width = 2f),
                      )
                      // Fill with semi-transparent orange
                      drawRect(
                        color = Color(0xFFFF6B00).copy(alpha = 0.15f),
                        topLeft = Offset(r[0], r[1]),
                        size = Size(r[2], r[3]),
                      )
                    }
                  }

                  // Transient touch-point feedback (issue #3352): a blue pulse at each forwarded
                  // control tap, fading and expanding over its lifetime. Each marker is placed by
                  // the canonical mapper through its OWN captured snapshot bounds
                  // (touchFeedbackCenter -> deviceToViewport, #4546), not the live
                  // boundsToFrameScale — so it lands where the tap mapped and does not drift if a
                  // resolution/rotation change arrives mid-fade. Empty in inspector mode.
                  for (feedback in activeTouchFeedback) {
                    val center =
                      touchFeedbackCenter(feedback.marker, size.width, size.height) ?: continue
                    val alpha = (1f - feedback.progress).coerceIn(0f, 1f)
                    val radius = TOUCH_PULSE_BASE_RADIUS_PX * (0.7f + 0.6f * feedback.progress)
                    val pulseColor = Color(0xFF2196F3)
                    drawCircle(
                      color = pulseColor.copy(alpha = alpha * 0.25f),
                      radius = radius,
                      center = Offset(center.x, center.y),
                    )
                    drawCircle(
                      color = pulseColor.copy(alpha = alpha),
                      radius = radius,
                      center = Offset(center.x, center.y),
                      style = Stroke(width = 2f),
                    )
                  }
                },
            )
          } else {
            // Placeholder device frame - context-aware based on connection status
            Box(
              modifier =
                Modifier.fillMaxSize()
                  .background(Color(0xFF1A1A1A))
                  .border(2.dp, Color(0xFF333333), RoundedCornerShape(8.dp)),
              contentAlignment = Alignment.Center,
            ) {
              when {
                connectionStatus == ConnectionStatus.Disconnected && !socketExists -> {
                  // Daemon is down - show restart button
                  Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                  ) {
                    Text(
                      "Device Disconnected",
                      color = colors.text.normal.copy(alpha = 0.5f),
                      fontSize = 12.sp,
                    )
                    if (onRestartDaemon != null) {
                      Box(
                        modifier =
                          Modifier.background(
                              colors.text.normal.copy(alpha = 0.1f),
                              RoundedCornerShape(4.dp),
                            )
                            .border(
                              1.dp,
                              colors.text.normal.copy(alpha = 0.2f),
                              RoundedCornerShape(4.dp),
                            )
                            .clickable(onClick = onRestartDaemon)
                            .pointerHoverIcon(PointerIcon.Hand)
                            .padding(horizontal = 12.dp, vertical = 6.dp)
                      ) {
                        Text(
                          "Restart MCP Daemon",
                          color = colors.text.normal.copy(alpha = 0.7f),
                          fontSize = 11.sp,
                        )
                      }
                    }
                  }
                }
                connectionStatus == ConnectionStatus.Disconnected -> {
                  // Socket exists but device gone
                  Text(
                    "Device Disconnected",
                    color = colors.text.normal.copy(alpha = 0.5f),
                    fontSize = 12.sp,
                  )
                }
                connectionStatus == ConnectionStatus.Connecting -> {
                  // Reconnecting state with spinner
                  Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                  ) {
                    Text(
                      "Device Disconnected",
                      color = colors.text.normal.copy(alpha = 0.5f),
                      fontSize = 12.sp,
                    )
                    ReconnectingSpinner()
                    Text(
                      "Reconnecting...",
                      color = colors.text.normal.copy(alpha = 0.25f),
                      fontSize = 10.sp,
                    )
                  }
                }
                else -> {
                  Text(
                    "Awaiting Observation",
                    color = colors.text.normal.copy(alpha = 0.5f),
                    fontSize = 12.sp,
                  )
                }
              }
            }
          }
        }

        // Zoom controls
        ZoomControls(
          scale = scale,
          onZoomIn = { zoomAroundCenter((scale * 1.2f).coerceAtMost(5f)) },
          onZoomOut = { zoomAroundCenter((scale / 1.2f).coerceAtLeast(0.1f)) },
          onFitToScreen = {
            // Calculate scale to fit and center the frame (shared Compose-free math).
            val fitScale =
              DeviceScreenCoordinateMapper.fitScale(
                frameWidthPx = frameWidthPx,
                frameHeightPx = frameHeightPx,
                viewportWidth = viewportWidth,
                viewportHeight = viewportHeight,
                padding = padding,
              )
            scale = fitScale
            offsetX = (viewportWidth - frameWidthPx * scale) / 2
            offsetY = (viewportHeight - frameHeightPx * scale) / 2
          },
          modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp),
        )
      }
    }
  }
}

@Composable
private fun ZoomControls(
  scale: Float,
  onZoomIn: () -> Unit,
  onZoomOut: () -> Unit,
  onFitToScreen: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors

  Column(
    modifier =
      modifier
        .background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(8.dp))
        .padding(4.dp),
    verticalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    ZoomButton("+", onClick = onZoomIn)
    ZoomButton("-", onClick = onZoomOut)
    ZoomButton("\u2922", onClick = onFitToScreen) // Fit icon

    Text(
      "${(scale * 100).toInt()}%",
      fontSize = 9.sp,
      maxLines = 1,
      softWrap = false,
      color = colors.text.normal.copy(alpha = 0.5f),
      modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 2.dp),
    )
  }
}

@Composable
private fun ZoomButton(label: String, onClick: () -> Unit) {
  val colors = SharedTheme.globalColors

  Box(
    modifier =
      Modifier.size(28.dp)
        .background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, fontSize = 14.sp)
  }
}

/**
 * Toggle for tap target compliance highlighting. Shows the number of non-compliant elements when
 * enabled. Uses finger emoji when width is too narrow.
 */
@Composable
private fun TapTargetComplianceToggle(
  enabled: Boolean,
  issueCount: Int,
  onToggle: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val backgroundColor =
    if (enabled) {
      Color(0xFFFF6B00).copy(alpha = 0.15f)
    } else {
      colors.text.normal.copy(alpha = 0.05f)
    }
  val borderColor =
    if (enabled) {
      Color(0xFFFF6B00).copy(alpha = 0.5f)
    } else {
      colors.text.normal.copy(alpha = 0.1f)
    }

  BoxWithConstraints(modifier = modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
    val isCompact = maxWidth < 150.dp

    Row(
      modifier =
        Modifier.background(backgroundColor, RoundedCornerShape(4.dp))
          .border(1.dp, borderColor, RoundedCornerShape(4.dp))
          .clickable(onClick = onToggle)
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(horizontal = 8.dp, vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      // Checkbox indicator
      Text(
        text = if (enabled) "\u2611" else "\u2610", // ☑ checked or ☐ unchecked
        fontSize = 12.sp,
        color = if (enabled) Color(0xFFFF6B00) else colors.text.normal.copy(alpha = 0.5f),
      )

      if (isCompact) {
        // Finger emoji for compact mode
        Text(
          text = "\uD83D\uDC46", // 👆
          fontSize = 12.sp,
        )
      } else {
        Text(
          text = "Tap Targets",
          fontSize = 11.sp,
          maxLines = 1,
          softWrap = false,
          color = if (enabled) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
        )
      }

      // Show issue count when enabled
      if (enabled) {
        Text(
          text = if (isCompact) "$issueCount" else "($issueCount)",
          fontSize = 11.sp,
          maxLines = 1,
          softWrap = false,
          color = if (issueCount > 0) Color(0xFFFF6B00) else colors.text.normal.copy(alpha = 0.5f),
        )
      }
    }
  }
}

/** Low-contrast reconnecting spinner with rotating dots. */
@Composable
private fun ReconnectingSpinner() {
  val infiniteTransition = rememberInfiniteTransition(label = "reconnecting")
  val angle by
    infiniteTransition.animateFloat(
      initialValue = 0f,
      targetValue = 360f,
      animationSpec =
        infiniteRepeatable(
          animation = tween(durationMillis = 1200, easing = LinearEasing),
          repeatMode = RepeatMode.Restart,
        ),
      label = "rotation",
    )

  val colors = SharedTheme.globalColors
  val dotColor = colors.text.normal.copy(alpha = 0.2f)

  Canvas(modifier = Modifier.size(24.dp)) {
    val centerX = size.width / 2
    val centerY = size.height / 2
    val radius = size.width / 2 - 4.dp.toPx()
    val dotRadius = 2.dp.toPx()
    val dotCount = 8

    for (i in 0 until dotCount) {
      val dotAngle = Math.toRadians((angle + i * 360.0 / dotCount).toDouble())
      val alpha = 0.15f + 0.15f * (i.toFloat() / dotCount)
      val x = centerX + radius * kotlin.math.cos(dotAngle).toFloat()
      val y = centerY + radius * kotlin.math.sin(dotAngle).toFloat()
      drawCircle(
        color = dotColor.copy(alpha = alpha),
        radius = dotRadius,
        center = androidx.compose.ui.geometry.Offset(x, y),
      )
    }
  }
}
