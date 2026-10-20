@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.graphics.ImageBitmap
import dev.jasonpearson.automobile.desktop.core.MONOTONIC_NOW_MS
import dev.jasonpearson.automobile.desktop.core.control.DeviceGestureStreamHandle
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.TouchFeedbackModel

@Composable
internal fun rememberDeviceScreenMemory(): DeviceScreenMemory {
  val touchFeedbackTickState = remember { mutableStateOf(0L) }
  val touchFeedbackGenerationState = remember { mutableStateOf(0) }
  val scaleState = remember { mutableFloatStateOf(1f) }
  val offsetXState = remember { mutableFloatStateOf(0f) }
  val offsetYState = remember { mutableFloatStateOf(0f) }
  val hasInitialFitState = remember { mutableStateOf(false) }
  val lastRefitTriggerState = remember { mutableStateOf<Any?>(null) }
  val prevViewportWidthState = remember { mutableFloatStateOf(0f) }
  val prevViewportHeightState = remember { mutableFloatStateOf(0f) }
  val flashAlphaState = remember { mutableFloatStateOf(0f) }
  return DeviceScreenMemory(
    remember { TouchFeedbackModel(nowMs = MONOTONIC_NOW_MS) },
    touchFeedbackTickState,
    touchFeedbackGenerationState,
    scaleState,
    offsetXState,
    offsetYState,
    hasInitialFitState,
    lastRefitTriggerState,
    prevViewportWidthState,
    prevViewportHeightState,
    flashAlphaState,
  )
}

@Composable
internal fun DeviceScreenOptions.rememberDeviceScreenCallbacks(): DeviceScreenCallbacks =
  DeviceScreenCallbacks(
    rememberUpdatedState(onControlTap),
    rememberUpdatedState(onControlSwipe),
    rememberUpdatedState(onControlGestureStreamBegin),
    rememberUpdatedState(onControlKey),
    rememberUpdatedState(onControlFocusChanged),
  )

@Composable
internal fun DeviceScreenOptions.observeTouchFeedback(
  memory: DeviceScreenMemory,
): List<dev.jasonpearson.automobile.desktop.domain.ActiveTouchFeedback> {
  with(memory) {
    val controlSnapshotDims = controlSnapshot?.let { it.deviceWidth to it.deviceHeight }
    LaunchedEffect(controlSnapshotDims) {
      controlSnapshot?.let {
        touchFeedback.retainOnlyMatchingAspect(it.deviceWidth, it.deviceHeight)
      }
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

    return activeTouchFeedback
  }
}

@Composable
internal fun DeviceScreenOptions.rememberDeviceHighlights(
  memory: DeviceScreenMemory,
): DeviceScreenHighlights {
  with(memory) {
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
        val hasScreenBounds = screenWidth > 0 && screenHeight > 0
        if (showTapTargetIssues && hierarchy != null && hasScreenBounds) {
          findNonCompliantTapTargets(hierarchy, screenWidth, screenHeight)
        } else {
          emptyList()
        }
      }

    return DeviceScreenHighlights(
      selectedElement,
      hoveredElement,
      flashElement,
      nonCompliantElements,
    )
  }
}

internal data class DeviceScreenMemory(
  val touchFeedback: TouchFeedbackModel,
  private val touchFeedbackTickState: androidx.compose.runtime.MutableState<Long>,
  private val touchFeedbackGenerationState: androidx.compose.runtime.MutableState<Int>,
  private val scaleState: androidx.compose.runtime.MutableState<Float>,
  private val offsetXState: androidx.compose.runtime.MutableState<Float>,
  private val offsetYState: androidx.compose.runtime.MutableState<Float>,
  private val hasInitialFitState: androidx.compose.runtime.MutableState<Boolean>,
  private val lastRefitTriggerState: androidx.compose.runtime.MutableState<Any?>,
  private val prevViewportWidthState: androidx.compose.runtime.MutableState<Float>,
  private val prevViewportHeightState: androidx.compose.runtime.MutableState<Float>,
  private val flashAlphaState: androidx.compose.runtime.MutableState<Float>,
) {
  var touchFeedbackTick by touchFeedbackTickState
  var touchFeedbackGeneration by touchFeedbackGenerationState
  var scale by scaleState
  var offsetX by offsetXState
  var offsetY by offsetYState
  var hasInitialFit by hasInitialFitState
  var lastRefitTrigger by lastRefitTriggerState
  var prevViewportWidth by prevViewportWidthState
  var prevViewportHeight by prevViewportHeightState
  var flashAlpha by flashAlphaState
}

internal data class DeviceScreenCallbacks(
  private val currentOnControlTapState:
    androidx.compose.runtime.State<((DeviceFrameSnapshot, DevicePoint) -> Boolean)?>,
  private val currentOnControlSwipeState:
    androidx.compose.runtime.State<((DeviceFrameSnapshot, DevicePoint, DevicePoint, Int) -> Unit)?>,
  private val currentOnControlGestureStreamBeginState:
    androidx.compose.runtime.State<
      ((DeviceFrameSnapshot, DevicePoint) -> DeviceGestureStreamHandle?)?,
    >,
  private val currentOnControlKeyState:
    androidx.compose.runtime.State<((DeviceFrameSnapshot, DeviceKeyStroke) -> Boolean)?>,
  private val currentOnControlFocusChangedState:
    androidx.compose.runtime.State<((Boolean) -> Unit)?>,
) {
  val currentOnControlTap by currentOnControlTapState
  val currentOnControlSwipe by currentOnControlSwipeState
  val currentOnControlGestureStreamBegin by currentOnControlGestureStreamBeginState
  val currentOnControlKey by currentOnControlKeyState
  val currentOnControlFocusChanged by currentOnControlFocusChangedState
}

internal data class DeviceScreenHighlights(
  val selectedElement: UIElementInfo?,
  val hoveredElement: UIElementInfo?,
  val flashElement: UIElementInfo?,
  val nonCompliantElements: List<UIElementInfo>,
)

internal data class DeviceScreenScene(
  val imageBitmap: ImageBitmap?,
  val highlights: DeviceScreenHighlights,
  val activeTouchFeedback: List<dev.jasonpearson.automobile.desktop.domain.ActiveTouchFeedback>,
)
