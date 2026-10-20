package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * A horizontal split pane with a draggable vertical divider between two content slots.
 *
 * @param first Content for the left pane.
 * @param second Content for the right pane.
 * @param firstPaneFraction Initial fraction of total width allocated to the first pane.
 * @param minFirstDp Minimum width of the first pane.
 * @param minSecondDp Minimum width of the second pane.
 * @param onFractionChanged Called when the user drags the divider, for persistence.
 * @param dividerWidth Width of the visible divider line.
 * @param dragHandleWidth Width of the invisible drag target area (centered on the divider).
 */
data class HorizontalSplitOptions(
  val firstPaneFraction: Float = 0.25f,
  val minFirstDp: Dp = 100.dp,
  val minSecondDp: Dp = 100.dp,
  val onFractionChanged: ((Float) -> Unit)? = null,
  val dividerWidth: Dp = 1.dp,
  val dragHandleWidth: Dp = 8.dp,
)

@Composable
fun HorizontalSplitPane(
  options: HorizontalSplitOptions = HorizontalSplitOptions(),
  first: @Composable () -> Unit,
  second: @Composable () -> Unit,
  modifier: Modifier = Modifier,
) {
  val firstPaneFraction = options.firstPaneFraction

  val onFractionChanged = options.onFractionChanged

  val currentOnFractionChanged by rememberUpdatedState(onFractionChanged)
  var fraction by remember { mutableStateOf(firstPaneFraction) }
  var totalWidthPx by remember { mutableStateOf(0) }
  var isDragging by remember { mutableStateOf(false) }
  val interactionSource = remember { MutableInteractionSource() }
  val isHovered by interactionSource.collectIsHoveredAsState()

  LaunchedEffect(firstPaneFraction) {
    fraction = firstPaneFraction
  }

  val colors = SharedTheme.globalColors
  val dividerColor =
    if (isHovered || isDragging) {
      colors.text.normal.copy(alpha = 0.3f)
    } else {
      colors.text.normal.copy(alpha = 0.15f)
    }

  Row(modifier = modifier.fillMaxSize().onSizeChanged { totalWidthPx = it.width }) {
    Box(modifier = Modifier.weight(fraction.coerceIn(0.01f, 0.99f)).fillMaxHeight()) {
      first()
    }

    HorizontalSplitDivider(
      options,
      SplitDividerState(
        totalWidthPx,
        fraction,
        isDragging,
        { isDragging = it },
        {
          fraction = it
          currentOnFractionChanged?.invoke(it)
        },
        interactionSource,
        dividerColor,
      ),
    )

    Box(modifier = Modifier.weight((1f - fraction).coerceIn(0.01f, 0.99f)).fillMaxHeight()) {
      second()
    }
  }
}

/**
 * A vertical split pane with a draggable horizontal divider between two content slots.
 *
 * @param first Content for the top pane.
 * @param second Content for the bottom pane.
 * @param showSecond Whether to show the divider and bottom pane. The first slot stays composed at
 *   full height when false, preserving content state while a facet opens or closes.
 * @param firstPaneFraction Initial fraction of total height allocated to the first pane.
 * @param minFirstDp Minimum height of the first pane.
 * @param minSecondDp Minimum height of the second pane.
 * @param onFractionChanged Called when the user drags the divider, for persistence.
 * @param dividerWidth Height of the visible divider line.
 * @param dragHandleWidth Height of the invisible drag target area (centered on the divider).
 */
data class VerticalSplitOptions(
  val showSecond: Boolean = true,
  val firstPaneFraction: Float = 0.25f,
  val minFirstDp: Dp = 100.dp,
  val minSecondDp: Dp = 100.dp,
  val onFractionChanged: ((Float) -> Unit)? = null,
  val dividerWidth: Dp = 1.dp,
  val dragHandleWidth: Dp = 8.dp,
)

@Composable
fun VerticalSplitPane(
  options: VerticalSplitOptions = VerticalSplitOptions(),
  first: @Composable () -> Unit,
  second: @Composable () -> Unit,
  modifier: Modifier = Modifier,
) {
  val showSecond = options.showSecond
  val firstPaneFraction = options.firstPaneFraction

  val onFractionChanged = options.onFractionChanged

  val currentOnFractionChanged by rememberUpdatedState(onFractionChanged)
  var fraction by remember { mutableStateOf(firstPaneFraction) }
  var totalHeightPx by remember { mutableStateOf(0) }
  var isDragging by remember { mutableStateOf(false) }
  val interactionSource = remember { MutableInteractionSource() }
  val isHovered by interactionSource.collectIsHoveredAsState()

  LaunchedEffect(firstPaneFraction) {
    fraction = firstPaneFraction
  }

  val colors = SharedTheme.globalColors
  val dividerColor =
    if (isHovered || isDragging) {
      colors.text.normal.copy(alpha = 0.3f)
    } else {
      colors.text.normal.copy(alpha = 0.15f)
    }

  Column(modifier = modifier.fillMaxSize().onSizeChanged { totalHeightPx = it.height }) {
    Box(
      modifier =
        Modifier.weight(if (showSecond) fraction.coerceIn(0.01f, 0.99f) else 1f).fillMaxWidth(),
    ) {
      first()
    }

    if (showSecond) {
      VerticalSplitDivider(
        options,
        SplitDividerState(
          totalHeightPx,
          fraction,
          isDragging,
          { isDragging = it },
          {
            fraction = it
            currentOnFractionChanged?.invoke(it)
          },
          interactionSource,
          dividerColor,
        ),
      )

      Box(modifier = Modifier.weight((1f - fraction).coerceIn(0.01f, 0.99f)).fillMaxWidth()) {
        second()
      }
    }
  }
}

private data class SplitDividerState(
  val totalPx: Int,
  val fraction: Float,
  val isDragging: Boolean,
  val onDragging: (Boolean) -> Unit,
  val onFractionChanged: (Float) -> Unit,
  val interactionSource: MutableInteractionSource,
  val dividerColor: androidx.compose.ui.graphics.Color,
)

@Composable
private fun HorizontalSplitDivider(options: HorizontalSplitOptions, state: SplitDividerState) {
  val currentDensity by rememberUpdatedState(LocalDensity.current)
  val currentOnFractionChanged by rememberUpdatedState(state.onFractionChanged)
  val minFirstDp = options.minFirstDp
  val minSecondDp = options.minSecondDp
  val dragHandleWidth = options.dragHandleWidth
  val dividerWidth = options.dividerWidth
  Box(
    modifier =
      Modifier.width(dragHandleWidth)
        .fillMaxHeight()
        .hoverable(state.interactionSource)
        .pointerHoverIcon(PointerIcon.Hand)
        .pointerInput(minFirstDp, minSecondDp, dragHandleWidth) {
          detectDragGestures(
            onDragStart = { state.onDragging(true) },
            onDragEnd = { state.onDragging(false) },
            onDragCancel = { state.onDragging(false) },
            onDrag = { change, dragAmount ->
              change.consume()
              if (state.totalPx > 0) {
                val minFirstPx = with(currentDensity) { minFirstDp.toPx() }
                val minSecondPx = with(currentDensity) { minSecondDp.toPx() }
                val handlePx = with(currentDensity) { dragHandleWidth.toPx() }
                val usable = (state.totalPx - handlePx).coerceAtLeast(minFirstPx + minSecondPx)
                if (usable <= 0f) return@detectDragGestures
                val newFirstPx =
                  (state.fraction * usable + dragAmount.x).coerceIn(
                    minFirstPx,
                    (usable - minSecondPx).coerceAtLeast(minFirstPx),
                  )
                val newFraction = (newFirstPx / usable).coerceIn(0.01f, 0.99f)
                currentOnFractionChanged(newFraction)
              }
            },
          )
        },
    contentAlignment = Alignment.Center,
  ) {
    Box(modifier = Modifier.width(dividerWidth).fillMaxHeight().background(state.dividerColor))
  }
}

@Composable
private fun VerticalSplitDivider(options: VerticalSplitOptions, state: SplitDividerState) {
  val currentDensity by rememberUpdatedState(LocalDensity.current)
  val currentOnFractionChanged by rememberUpdatedState(state.onFractionChanged)
  val minFirstDp = options.minFirstDp
  val minSecondDp = options.minSecondDp
  val dragHandleWidth = options.dragHandleWidth
  val dividerWidth = options.dividerWidth
  Box(
    modifier =
      Modifier.height(dragHandleWidth)
        .fillMaxWidth()
        .hoverable(state.interactionSource)
        .pointerHoverIcon(PointerIcon.Hand)
        .pointerInput(minFirstDp, minSecondDp, dragHandleWidth) {
          detectDragGestures(
            onDragStart = { state.onDragging(true) },
            onDragEnd = { state.onDragging(false) },
            onDragCancel = { state.onDragging(false) },
            onDrag = { change, dragAmount ->
              change.consume()
              if (state.totalPx > 0) {
                val minFirstPx = with(currentDensity) { minFirstDp.toPx() }
                val minSecondPx = with(currentDensity) { minSecondDp.toPx() }
                val handlePx = with(currentDensity) { dragHandleWidth.toPx() }
                val usable = (state.totalPx - handlePx).coerceAtLeast(minFirstPx + minSecondPx)
                if (usable <= 0f) return@detectDragGestures
                val newFirstPx =
                  (state.fraction * usable + dragAmount.y).coerceIn(
                    minFirstPx,
                    (usable - minSecondPx).coerceAtLeast(minFirstPx),
                  )
                val newFraction = (newFirstPx / usable).coerceIn(0.01f, 0.99f)
                currentOnFractionChanged(newFraction)
              }
            },
          )
        },
    contentAlignment = Alignment.Center,
  ) {
    Box(modifier = Modifier.height(dividerWidth).fillMaxWidth().background(state.dividerColor))
  }
}
