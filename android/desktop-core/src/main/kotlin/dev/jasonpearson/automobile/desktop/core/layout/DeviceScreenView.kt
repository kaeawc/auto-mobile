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
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asSkiaBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import dev.jasonpearson.automobile.desktop.domain.ViewportPoint
import org.jetbrains.skia.Image

private val IS_MAC = System.getProperty("os.name", "").contains("Mac", ignoreCase = true)

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
   * Called in [DeviceScreenControlMode.Control] with the device coordinate a click maps to. The
   * point carries [DevicePoint.inBounds]; a null default makes control mode inert until a caller
   * wires it. No-op in inspector mode.
   */
  onControlTap: ((DevicePoint) -> Unit)? = null,
) {
  val colors = SharedTheme.globalColors

  // Keep the latest control-tap callback readable from the long-lived tap gesture coroutine, so a
  // callback that changes (e.g. null -> real once the daemon connection is ready) is honored
  // without
  // restarting the gesture. Matches the rememberUpdatedState pattern used by SplitPane's drag.
  val currentOnControlTap by rememberUpdatedState(onControlTap)

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

      // Focus requester for keyboard events
      val focusRequester = remember { FocusRequester() }

      // Request focus when an element is selected
      LaunchedEffect(selectedElementId) {
        if (selectedElementId != null) {
          focusRequester.requestFocus()
        }
      }

      Box(
        modifier =
          Modifier.fillMaxSize()
            .clipToBounds()
            .focusRequester(focusRequester)
            .focusTarget()
            .onKeyEvent { keyEvent ->
              // Handle Escape to deselect
              if (keyEvent.key == Key.Escape && selectedElementId != null) {
                onElementSelected(null)
                true
              } else {
                false
              }
            }
            .pointerInput(Unit) {
              // Allow pan/drag to move the viewport
              detectDragGestures { change, dragAmount ->
                change.consume()
                offsetX += dragAmount.x
                offsetY += dragAmount.y
              }
            }
            .pointerInput(hierarchy, controlMode) {
              detectTapGestures { offset ->
                val point = screenToDevice(offset.x, offset.y)
                when (controlMode) {
                  // Control mode: report the mapped device coordinate for a caller to forward to
                  // the daemon input helpers (issue #3347). This view never sends input itself.
                  DeviceScreenControlMode.Control -> currentOnControlTap?.invoke(point)
                  // Inspector mode: select the deepest element under the click (unchanged
                  // behavior).
                  DeviceScreenControlMode.Inspector ->
                    if (hierarchy != null) {
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
