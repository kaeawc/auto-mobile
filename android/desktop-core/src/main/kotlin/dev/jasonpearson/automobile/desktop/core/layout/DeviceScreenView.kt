@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.control.DeviceGestureStreamHandle
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode

private val IS_MAC = System.getProperty("os.name", "").contains("Mac", ignoreCase = true)

internal fun PointerEvent.isZoomModifierPressed(): Boolean =
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
  liveFrame: ImageBitmap? = null,
  modifier: Modifier = Modifier,
  options: DeviceScreenOptions,
) {

  val memory = rememberDeviceScreenMemory()
  with(options) {
    val colors = SharedTheme.globalColors
    val callbacks = rememberDeviceScreenCallbacks()
    LaunchedEffect(controlMode) {
      if (controlMode != DeviceScreenControlMode.Inspector) {
        onElementHovered(null)
        onElementSelected(null)
      }
    }
    LaunchedEffect(controlMode) {
      if (controlMode != DeviceScreenControlMode.Control) memory.touchFeedback.reset()
    }
    val activeTouchFeedback = observeTouchFeedback(memory)
    val imageBitmap = rememberDeviceScreenBitmap(screenshotData, liveFrame)
    val highlights = rememberDeviceHighlights(memory)
    Column(modifier = modifier) {
      TapTargetComplianceToggle(
        enabled = showTapTargetIssues,
        issueCount = highlights.nonCompliantElements.size,
        onToggle = onToggleTapTargetIssues,
        modifier = Modifier.padding(top = 36.dp),
      )
      DeviceScreenViewport(
        memory,
        DeviceScreenScene(imageBitmap, highlights, activeTouchFeedback),
        callbacks,
        Modifier.weight(1f).fillMaxWidth().background(colors.text.normal.copy(alpha = 0.03f)),
      )
    }
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

data class DeviceScreenOptions(
  val screenWidth: Int,
  val screenHeight: Int,
  val rotation: Int = 0,
  val hierarchy: UIElementInfo?,
  val selectedElementId: String?,
  val hoveredElementId: String?,
  val flashElementId: String? = null,
  val onFlashComplete: () -> Unit = {},
  val onElementSelected: (String?) -> Unit,
  val onElementHovered: (String?) -> Unit,
  val showTapTargetIssues: Boolean = false,
  val onToggleTapTargetIssues: () -> Unit = {},
  val connectionStatus: ConnectionStatus = ConnectionStatus.Connected,
  val hierarchyUnavailableReason: String? = null,
  val socketExists: Boolean = true,
  val onRestartDaemon: (() -> Unit)? = null,
  val elementMap: Map<String, UIElementInfo>? = null,
  val refitTrigger: Any? = null,
  val controlMode: DeviceScreenControlMode = DeviceScreenControlMode.Inspector,
  val controlSnapshot: DeviceFrameSnapshot? = null,
  val onControlTap: ((DeviceFrameSnapshot, DevicePoint) -> Boolean)? = null,
  val onControlSwipe: ((DeviceFrameSnapshot, DevicePoint, DevicePoint, Int) -> Unit)? = null,
  val onControlGestureStreamBegin:
    ((DeviceFrameSnapshot, DevicePoint) -> DeviceGestureStreamHandle?)? =
    null,
  val onControlKey: ((DeviceFrameSnapshot, DeviceKeyStroke) -> Boolean)? = null,
  val onControlFocusChanged: ((Boolean) -> Unit)? = null,
)

internal val DEVICE_SCREEN_LOG = LoggerFactory.getLogger("DeviceScreenView")
