@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerInput
import dev.jasonpearson.automobile.desktop.core.MONOTONIC_NOW_MS
import dev.jasonpearson.automobile.desktop.core.control.DeviceKeyboardEventTranslator
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import dev.jasonpearson.automobile.desktop.domain.ViewportPoint

internal fun Modifier.deviceScreenInput(interaction: DeviceScreenInteraction): Modifier {

  return clipToBounds()
    .deviceScreenKeys(interaction)
    .deviceScreenDrag(interaction)
    .deviceScreenTaps(interaction)
    .deviceScreenHover(interaction)
    .deviceScreenZoom(interaction)
}

internal fun Modifier.deviceScreenKeys(interaction: DeviceScreenInteraction): Modifier {
  with(interaction) {
    with(options) {
      with(memory) {
        with(callbacks) {
          return this@deviceScreenKeys.focusRequester(focusRequester)
            .onFocusChanged { state -> currentOnControlFocusChanged?.invoke(state.isFocused) }
            .focusTarget()
            .onKeyEvent { keyEvent ->
              handleDeviceScreenKeyEvent(
                keyEvent = keyEvent,
                options =
                  DeviceScreenKeyContext(
                    controlMode = controlMode,
                    controlFrame = controlFrame,
                    onControlKey = currentOnControlKey,
                    selectedElementId = selectedElementId,
                    onElementSelected = onElementSelected,
                  ),
              )
            }
        }
      }
    }
  }
}

internal fun Modifier.deviceScreenDrag(interaction: DeviceScreenInteraction): Modifier {
  with(interaction) {
    with(options) {
      with(memory) {
        with(callbacks) {
          return this@deviceScreenDrag.pointerInput(controlMode) {
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
        }
      }
    }
  }
}

internal fun Modifier.deviceScreenTaps(interaction: DeviceScreenInteraction): Modifier {
  with(interaction) {
    with(options) {
      with(memory) {
        with(callbacks) {
          return this@deviceScreenTaps.pointerInput(hierarchy, controlMode) {
            detectTapGestures { offset ->
              when (controlMode) {
                // Control mode: map through the clicked snapshot and report both, for a caller
                // to forward to the daemon input helpers (issues #3347, #3348). This view never
                // sends input itself. One read of controlFrame supplies both the mapping bounds
                // and the reported snapshot, so they cannot disagree.
                DeviceScreenControlMode.Control -> {
                  // Clicking the mirrored screen restores keyboard focus (issue #3351). The
                  // mode-entry effect only fires when controlMode CHANGES, so once anything
                  // else
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
                    // off-screen point, a full queue, or an unwired (null) control view.
                    // Showing
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
                    val element = LayoutInspectorMockData.findElementAt(hierarchy, point.x, point.y)
                    onElementSelected(element?.id)
                  }
              }
            }
          }
        }
      }
    }
  }
}

internal fun Modifier.deviceScreenHover(interaction: DeviceScreenInteraction): Modifier {
  with(interaction) {
    with(options) {
      with(memory) {
        with(callbacks) {
          return this@deviceScreenHover.onPointerEvent(PointerEventType.Move) { event ->
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
        }
      }
    }
  }
}

internal fun Modifier.deviceScreenZoom(interaction: DeviceScreenInteraction): Modifier {
  with(interaction) {
    with(options) {
      with(memory) {
        with(callbacks) {
          return this@deviceScreenZoom.onPointerEvent(PointerEventType.Scroll) { event ->
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
        }
      }
    }
  }
}

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
internal fun handleDeviceScreenKeyEvent(
  keyEvent: KeyEvent,
  options: DeviceScreenKeyContext,
): Boolean {
  with(options) {
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
}

internal data class DeviceScreenInteraction(
  val options: DeviceScreenOptions,
  val memory: DeviceScreenMemory,
  val callbacks: DeviceScreenCallbacks,
  private val currentGeometryState: androidx.compose.runtime.State<DeviceScreenGeometry>,
  private val controlFrameState:
    androidx.compose.runtime.State<Pair<DeviceFrameSnapshot, DeviceScreenGeometry>?>,
  val focusRequester: FocusRequester,
) {
  val currentGeometry by currentGeometryState
  val controlFrame by controlFrameState

  fun screenToDevice(screenX: Float, screenY: Float): DevicePoint =
    DeviceScreenCoordinateMapper.viewportToDevice(ViewportPoint(screenX, screenY), currentGeometry)
}

internal data class DeviceScreenKeyContext(
  val controlMode: DeviceScreenControlMode,
  val controlFrame: Pair<DeviceFrameSnapshot, DeviceScreenGeometry>?,
  val onControlKey: ((DeviceFrameSnapshot, DeviceKeyStroke) -> Boolean)?,
  val selectedElementId: String?,
  val onElementSelected: (String?) -> Unit,
)
