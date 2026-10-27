package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.layout.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*

@Composable
internal fun RenderPrototypeTooltip(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeTooltipNode ?: return
  if (!node.sheetOpen) return
  val layers = LocalPrototypeMenuLayers.current
  val identity = LocalPrototypeTooltipTargets.current[source.anchorTo]
  val target = tooltipTarget(source, identity, layers) ?: return
  val requester = remember(node.identity) { FocusRequester() }
  val restore = LocalPrototypeTargetFocus.current[identity]
  if (source.spotlight != null) {
    LaunchedEffect(node.identity) { requester.requestFocus() }
    DisposableEffect(node.identity) { onDispose { restore?.requestFocus() } }
  }
  val dismiss = {
    interact(PrototypeInteraction.CloseModal(source.openWhen, source.onDismiss.orEmpty()))
  }
  Box(Modifier.fillMaxSize()) {
    source.spotlight?.let { PrototypeSpotlight(node, target, it, dismiss) }
    TooltipBubble(
      TooltipBubbleContent(node, source, target),
      modifier.focusRequester(requester).focusable(),
      interact,
      dismiss,
    )
  }
}

@Composable
private fun tooltipTarget(
  source: PrototypeTooltipNode,
  identity: String?,
  layers: PrototypeMenuLayers,
): Rect? {
  if (source.anchorTo != null) return identity?.let { layers.bounds[it] }
  val anchor = source.anchor as? PrototypeBoundsAnchor ?: return null
  val density = LocalDensity.current.density
  val origin = currentPrototypeWindowGeometry().originOnScreen()
  val bounds = anchor.bounds
  return Rect(
    (bounds.x + (anchor.offset?.x ?: 0.0)).toFloat() * density - origin.x,
    (bounds.y + (anchor.offset?.y ?: 0.0)).toFloat() * density - origin.y,
    (bounds.x + bounds.width + (anchor.offset?.x ?: 0.0)).toFloat() * density - origin.x,
    (bounds.y + bounds.height + (anchor.offset?.y ?: 0.0)).toFloat() * density - origin.y,
  )
}

@Composable
private fun PrototypeSpotlight(
  node: PrototypeRenderNode,
  target: Rect,
  spotlight: PrototypeTooltipSpotlight,
  dismiss: () -> Unit,
) {
  val density = LocalDensity.current.density
  val color = prototypeSheetScrimFallback(prototypePalette())
  val window = LocalPrototypeMenuLayers.current.windowBounds
  val hole = target.translate(-window.topLeft).inflate((spotlight.padding ?: 8) * density)
  Canvas(
    Modifier.fillMaxSize().clickable(onClick = dismiss).semantics {
      prototypePartTag(node.testTag, "close")?.let { testTag = it }
    },
  ) {
    val path =
      Path().apply {
        fillType = PathFillType.EvenOdd
        addRect(Rect(Offset.Zero, size))
        addRoundRect(RoundRect(hole, CornerRadius((spotlight.cornerRadius ?: 12) * density)))
      }
    drawPath(path, color)
  }
}

private data class TooltipBubbleContent(
  val node: PrototypeRenderNode,
  val source: PrototypeTooltipNode,
  val target: Rect,
)

@Composable
private fun TooltipBubble(
  content: TooltipBubbleContent,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
  dismiss: () -> Unit,
) {
  val (node, source, target) = content
  val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
  val density = LocalDensity.current.density
  val layers = LocalPrototypeMenuLayers.current
  val color = MaterialTheme.colorScheme.inverseSurface
  Layout(
    content = {
      Surface(
        modifier
          .clickable {
            if (source.onTap != null) interact(PrototypeInteraction.Tap(source.onTap.orEmpty()))
            else dismiss()
          }
          .semantics(mergeDescendants = true) { paneTitle = "Tooltip" },
        color = color,
        contentColor = MaterialTheme.colorScheme.inverseOnSurface,
        shape = MaterialTheme.shapes.small,
        shadowElevation = 3.dp,
      ) {
        Text(node.text, Modifier.padding(12.dp).clearAndSetSemantics {})
      }
      Canvas(Modifier.size(12.dp)) {
        val path =
          Path().apply {
            moveTo(0f, 0f)
            lineTo(size.width, 0f)
            lineTo(size.width / 2, size.height)
            close()
          }
        drawPath(path, color)
      }
    },
    modifier = Modifier.fillMaxSize(),
  ) { measurables, constraints ->
    measureTooltip(
      measurables,
      constraints,
      TooltipLayout(target, layers.windowBounds, rtl, source.caret, density),
    )
  }
}

private data class TooltipLayout(
  val target: Rect,
  val window: Rect,
  val rtl: Boolean,
  val caret: String,
  val density: Float,
)

private fun MeasureScope.measureTooltip(
  measurables: List<Measurable>,
  constraints: Constraints,
  options: TooltipLayout,
): MeasureResult {
  val target = options.target
  val density = options.density
  val rtl = options.rtl

  val bubble =
    measurables[0].measure(
      constraints.copy(
        minWidth = 0,
        minHeight = 0,
        maxWidth =
          minOf(
            (constraints.maxWidth - 16 * density).toInt().coerceAtLeast(0),
            (320 * density).toInt(),
          ),
        maxHeight = (constraints.maxHeight - 16 * density).toInt().coerceAtLeast(0),
      ),
    )
  val caret = measurables[1].measure(constraints.copy(minWidth = 0, minHeight = 0))
  val window = options.window
  val placement =
    placePrototypeBubble(
      PrototypeTargetRect(target.left, target.top, target.right, target.bottom),
      PrototypeBubbleSize(bubble.width.toFloat(), bubble.height.toFloat()),
      PrototypeTargetRect(window.left, window.top, window.right, window.bottom),
      PrototypeBubbleOptions(options.rtl, options.caret, 8 * density, 8 * density, 12 * density),
    )
  return layout(constraints.maxWidth, constraints.maxHeight) {
    bubble.place((placement.x - window.left).toInt(), (placement.y - window.top).toInt())
    val vertical = placement.caret in setOf("top", "bottom")
    val x =
      if (vertical) placement.x + placement.caretOffset - caret.width / 2
      else if ((placement.caret == "start") != rtl) placement.x - 8 * density
      else placement.x + bubble.width - 4 * density
    val y =
      if (!vertical) placement.y + placement.caretOffset - caret.height / 2
      else if (placement.caret == "top") placement.y - 8 * density
      else placement.y + bubble.height - 4 * density
    caret.placeWithLayer((x - window.left).toInt(), (y - window.top).toInt()) {
      rotationZ =
        when (placement.caret) {
          "top" -> 180f
          "bottom" -> 0f
          "start" -> if (rtl) 270f else 90f
          else -> if (rtl) 90f else 270f
        }
    }
  }
}

internal fun prototypeTooltipHasTarget(
  node: PrototypeRenderNode,
  layers: PrototypeMenuLayers,
  targets: Map<String, String>,
): Boolean {
  val source = node.source as? PrototypeTooltipNode ?: return false
  return if (source.anchorTo != null) targets[source.anchorTo]?.let { layers.bounds[it] } != null
  else source.anchor is PrototypeBoundsAnchor
}
