@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import org.jetbrains.skia.Image

@Composable
internal fun DeviceScreenOptions.DeviceScreenViewport(
  memory: DeviceScreenMemory,
  scene: DeviceScreenScene,
  callbacks: DeviceScreenCallbacks,
  modifier: Modifier,
) {

  BoxWithConstraints(modifier = modifier) {
    val layout =
      deviceScreenLayout(
        scene.imageBitmap,
        constraints.maxWidth.toFloat(),
        constraints.maxHeight.toFloat(),
      )
    ObserveViewportFit(memory, layout)
    val interaction = rememberDeviceScreenInteraction(memory, layout, callbacks)
    Box(modifier = Modifier.fillMaxSize().deviceScreenInput(interaction)) {
      DeviceScreenFrame(memory, layout, scene)
      DeviceScreenZoomControls(memory, layout, Modifier.align(Alignment.BottomEnd).padding(8.dp))
    }
  }
}

internal fun DeviceScreenOptions.deviceScreenLayout(
  imageBitmap: ImageBitmap?,
  viewportWidth: Float,
  viewportHeight: Float,
): DeviceScreenLayout {
  val effectiveWidth = imageBitmap?.width ?: screenWidth
  val effectiveHeight = imageBitmap?.height ?: screenHeight
  return DeviceScreenLayout(
    viewportWidth,
    viewportHeight,
    effectiveWidth,
    effectiveHeight,
    hierarchy?.bounds?.width?.takeIf { it > 0 } ?: screenWidth.takeIf { it > 0 } ?: effectiveWidth,
    hierarchy?.bounds?.height?.takeIf { it > 0 }
      ?: screenHeight.takeIf { it > 0 }
      ?: effectiveHeight,
  )
}

@Composable
internal fun DeviceScreenOptions.ObserveViewportFit(
  memory: DeviceScreenMemory,
  layout: DeviceScreenLayout,
) {
  with(memory) {
    with(layout) {
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
      ObserveInitialDeviceFit(memory, layout)
    }
  }
}

@Composable
internal fun ObserveInitialDeviceFit(memory: DeviceScreenMemory, layout: DeviceScreenLayout) {
  with(memory) {
    with(layout) {
      LaunchedEffect(viewportWidth, viewportHeight, frameWidthPx, frameHeightPx, hasInitialFit) {
        val canFitFrame = viewportWidth > 0 && viewportHeight > 0 && frameWidthPx > 0
        if (!hasInitialFit && canFitFrame) {
          // Calculate scale needed to fit device in viewport (Compose-free, unit-tested).
          // The frame is already sized to fit, so scale 1.0 should fit; a very narrow viewport
          // may
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
    }
  }
}

@Composable
internal fun ObserveDeviceScreenFocus(interaction: DeviceScreenInteraction) {
  with(interaction) {
    with(options) {
      // Request focus when an element is selected
      LaunchedEffect(selectedElementId) {
        if (selectedElementId != null) {
          focusRequester.requestFocus()
        }
      }

      // Entering control mode takes keyboard focus (issue #3351). Focus is the ONLY gate on
      // keyboard forwarding — Compose delivers a key event to `onKeyEvent` only when this node is
      // on the focus path — so without this the view would be in control mode and yet never see a
      // keystroke: control mode clears the selection, and the effect above is the only other
      // thing
      // that ever asked for focus. Nothing is grabbed in inspector mode, so the IDE plugin's
      // focus
      // behavior is untouched.
      LaunchedEffect(controlMode) {
        if (controlMode == DeviceScreenControlMode.Control) {
          focusRequester.requestFocus()
        }
      }
    }
  }
}

@Composable
internal fun DeviceScreenOptions.DeviceScreenFrame(
  memory: DeviceScreenMemory,
  layout: DeviceScreenLayout,
  scene: DeviceScreenScene,
) {
  val colors = SharedTheme.globalColors
  val localDensity = LocalDensity.current
  val frameWidthDp = with(localDensity) { layout.frameWidthPx.toDp() }
  val frameHeightDp = with(localDensity) { layout.frameHeightPx.toDp() }
  val imageBitmap = scene.imageBitmap
  with(memory) {
    // Device frame - sized to fit viewport with proper aspect ratio
    Box(
      modifier =
        Modifier.graphicsLayer {
            scaleX = scale
            scaleY = scale
            translationX = offsetX
            translationY = offsetY
            transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0f)
          }
          .size(width = frameWidthDp, height = frameHeightDp),
    ) {
      if (imageBitmap != null) {
        Image(
          bitmap = imageBitmap,
          contentDescription = "Device screenshot",
          modifier =
            Modifier.fillMaxSize().drawWithContent {
              drawDeviceScreenOverlays(
                this@DeviceScreenFrame,
                scene,
                layout,
                flashAlpha,
              )
            },
        )
      } else {
        DeviceScreenPlaceholder()
      }
      if (imageBitmap != null && hierarchyUnavailableReason != null) {
        Text(
          "Hierarchy unavailable - $hierarchyUnavailableReason. Try getApple / reprovision.",
          modifier =
            Modifier.align(Alignment.TopCenter).background(Color(0xDD1A1A1A)).padding(8.dp),
          color = colors.text.normal,
          fontSize = 12.sp,
        )
      }
    }
  }
}

@Composable
internal fun DeviceScreenOptions.rememberDeviceScreenInteraction(
  memory: DeviceScreenMemory,
  layout: DeviceScreenLayout,
  callbacks: DeviceScreenCallbacks,
): DeviceScreenInteraction {
  with(memory) {
    with(layout) {
      val currentGeometryState =
        rememberUpdatedState(
          DeviceScreenGeometry(
            frameWidthPx = frameWidthPx,
            frameHeightPx = frameHeightPx,
            scale = scale,
            offsetX = offsetX,
            offsetY = offsetY,
            deviceWidth = rotatedRootWidth,
            deviceHeight = rootBoundsHeight,
          ),
        )

      // The control-mode mapping authority (issue #3348): the snapshot plus the geometry derived
      // from ITS device bounds, published as ONE value. The tap gesture reads it once, so the
      // point it produces and the snapshot it reports are always the same frame — there is no
      // window in which the snapshot could advance between the two reads. Null whenever no
      // snapshot is available, which makes control mode inert (the caller is already rendering
      // inspector mode in that case).
      val controlFrameState =
        rememberUpdatedState(
          controlSnapshot?.let { snapshot ->
            snapshot to
              currentGeometryState.value.copy(
                deviceWidth = snapshot.deviceWidth,
                deviceHeight = snapshot.deviceHeight,
              )
          },
        )

      // Focus requester for keyboard events
      val focusRequester = remember { FocusRequester() }

      val interaction =
        DeviceScreenInteraction(
          this@rememberDeviceScreenInteraction,
          memory,
          callbacks,
          currentGeometryState,
          controlFrameState,
          focusRequester,
        )
      ObserveDeviceScreenFocus(interaction)
      return interaction
    }
  }
}

internal data class DeviceScreenLayout(
  val viewportWidth: Float,
  val viewportHeight: Float,
  val effectiveWidth: Int,
  val effectiveHeight: Int,
  val rootBoundsWidth: Int,
  val rootBoundsHeight: Int,
) {
  val padding = DeviceScreenCoordinateMapper.DEFAULT_PADDING
  private val fittedFrame =
    DeviceScreenCoordinateMapper.fitToViewport(
      effectiveWidth,
      effectiveHeight,
      viewportWidth,
      viewportHeight,
      padding,
    )
  val frameWidthPx = fittedFrame.widthPx
  val frameHeightPx = fittedFrame.heightPx
  val frameToDeviceScale = if (frameWidthPx > 0) effectiveWidth.toFloat() / frameWidthPx else 1f
  val rotatedRootWidth = rootBoundsWidth
  val boundsRotation = 0
}
