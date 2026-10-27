@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

private val IS_MAC = System.getProperty("os.name", "").contains("Mac", ignoreCase = true)

internal fun PointerEvent.isZoomModifierPressed(): Boolean =
  if (IS_MAC) keyboardModifiers.isMetaPressed else keyboardModifiers.isCtrlPressed

// Layout constants
internal val NODE_WIDTH = 80.dp
internal val NODE_HEIGHT = 140.dp

// Computed node positions based on a simple layered layout
internal data class NodePosition(
  val screenId: String,
  val x: Float,
  val y: Float,
)

@Composable
fun NavigationCanvasView(options: NavigationCanvasOptions) {
  val interaction = remember { NavigationCanvasInteraction() }
  val highlights = rememberCanvasHighlights(options, interaction)
  val layout = rememberCanvasLayout(options)
  val context =
    NavigationCanvasContext(
      options,
      interaction,
      layout,
      highlights,
      rememberCoroutineScope(),
      SharedTheme.globalColors,
    )
  CanvasHoverEffect(context)
  CanvasObservedFocusEffect(context)
  BoxWithConstraints(modifier = Modifier.fillMaxSize().clipToBounds()) {
    val viewportWidth = constraints.maxWidth.toFloat()
    val viewportHeight = constraints.maxHeight.toFloat()
    CanvasInitialFitEffect(context, viewportWidth, viewportHeight)
    CanvasFitTriggerEffect(context, viewportWidth, viewportHeight)
    CanvasHighlightPanEffect(context, viewportWidth, viewportHeight)
    CanvasFogFocusEffect(context, viewportWidth, viewportHeight)
    CanvasAnimationSyncEffect(context)
    Box(modifier = canvasInputModifier(context)) {
      CanvasNodes(context)
      CanvasFogOverlay(context)
      CanvasFogToggle(context)
      CanvasZoomControls(context, viewportWidth, viewportHeight)
    }
  }
}

@Composable
internal fun ZoomControls(
  scale: Float,
  onZoomIn: () -> Unit,
  onZoomOut: () -> Unit,
  onReset: () -> Unit,
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
    ZoomButton("−", onClick = onZoomOut)
    ZoomButton("⟲", onClick = onReset)

    Text(
      "${(scale * 100).toInt()}%",
      fontSize = 9.sp,
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

@Composable
internal fun ToggleSwitch(
  checked: Boolean,
  onCheckedChange: (Boolean) -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val trackColor = if (checked) Color(0xFF4CAF50) else colors.text.normal.copy(alpha = 0.3f)
  val thumbColor = Color.White

  Box(
    modifier =
      modifier
        .width(32.dp)
        .height(18.dp)
        .clip(RoundedCornerShape(9.dp))
        .background(trackColor)
        .clickable { onCheckedChange(!checked) }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(2.dp),
  ) {
    Box(
      modifier =
        Modifier.size(14.dp)
          .offset(x = if (checked) 14.dp else 0.dp)
          .clip(CircleShape)
          .background(thumbColor),
    )
  }
}

/**
 * D3-style disjoint force-directed layout algorithm. Uses four forces (matching D3 defaults):
 * 1. Link force: attraction between connected nodes
 * 2. Charge force: repulsion between ALL nodes (many-body)
 * 3. forceX: pull toward center X (keeps disjoint components from escaping)
 * 4. forceY: pull toward center Y (keeps disjoint components from escaping)
 *
 * Based on: https://observablehq.com/@d3/disjoint-force-directed-graph/2
 */
internal fun computeNodePositions(
  screens: List<ScreenNode>,
  transitions: List<ScreenTransition>,
  density: androidx.compose.ui.unit.Density,
): List<NodePosition> {
  if (screens.isEmpty()) return emptyList()
  val nodeWidth = with(density) { NODE_WIDTH.toPx() }
  val nodeHeight = with(density) { NODE_HEIGHT.toPx() }
  return NavigationForceSimulation(screens, transitions, nodeWidth, nodeHeight).simulate()
}
