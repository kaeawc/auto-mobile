package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeListItemNode
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeRowNode
import dev.jasonpearson.automobile.protocol.PrototypeSwipeAction
import dev.jasonpearson.automobile.protocol.PrototypeSwipeActions
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

internal fun prototypeSwipeActions(node: PrototypeNode?): PrototypeSwipeActions? =
  when (node) {
    is PrototypeRowNode -> node.swipeActions
    is PrototypeListItemNode -> node.swipeActions
    else -> null
  }

/** The same node without swipe actions, so the foreground content renders as an ordinary row. */
internal fun prototypeWithoutSwipe(node: PrototypeNode?): PrototypeNode? =
  when (node) {
    is PrototypeRowNode -> node.copy(swipeActions = null)
    is PrototypeListItemNode -> node.copy(swipeActions = null)
    else -> node
  }

/** Every entry in test-tag and accessibility-action order: `start` first, then `end`. */
internal fun PrototypeSwipeActions.entries(): List<Pair<SwipeSide, PrototypeSwipeAction>> =
  start.orEmpty().map { SwipeSide.START to it } + end.orEmpty().map { SwipeSide.END to it }

/**
 * A row whose foreground drags over action buttons. Closed, no button is composed; open or
 * dragging, the revealed buttons carry `<rowTag>.swipe.<index>` and every entry is also a custom
 * accessibility action on the row, so TalkBack can run it without a drag.
 */
@Composable
internal fun PrototypeSwipeRow(
  node: PrototypeRenderNode,
  swipe: PrototypeSwipeActions,
  interact: (PrototypeInteraction) -> Unit,
  modifier: Modifier,
  content: @Composable () -> Unit,
) {
  val coordinator = LocalPrototypeSwipeCoordinator.current ?: remember { SwipeCoordinator() }
  val density = LocalDensity.current.density
  val id = node.identity
  val button = PrototypeSwipeTuning.BUTTON_WIDTH_DP * density
  var rowWidth by remember { mutableFloatStateOf(0f) }
  val geometry =
    SwipeGeometry(
      startWidth = swipe.start.orEmpty().size * button,
      endWidth = swipe.end.orEmpty().size * button,
      rowWidth = rowWidth,
      fullSwipe = swipe.fullSwipe == true,
      density = density,
    )
  val animate = LocalPrototypeMotion.current
  val scope = rememberCoroutineScope()
  val initial =
    if (coordinator.isOpen(id)) swipeRestOffset(SwipeSettle.Open(coordinator.openSide), geometry)
    else 0f
  val offset = remember(id) { Animatable(initial) }
  var raw by remember(id) { mutableFloatStateOf(initial) }
  ReportPrototypeMotion { offset.isRunning }
  val entries = remember(swipe) { swipe.entries() }

  suspend fun moveTo(target: Float) {
    if (animate) offset.animateTo(target, tween(durationMillis = 200)) else offset.snapTo(target)
    raw = target
  }

  fun settle(result: SwipeSettle) {
    when (result) {
      SwipeSettle.Closed -> coordinator.closed(id)
      is SwipeSettle.Open -> coordinator.opened(id, result.side)
      is SwipeSettle.Full -> {
        coordinator.closed(id)
        val list = if (result.side == SwipeSide.START) swipe.start else swipe.end
        list?.firstOrNull()?.let { interact(PrototypeInteraction.Tap(it.onTap)) }
      }
    }
    scope.launch {
      moveTo(if (result is SwipeSettle.Full) 0f else swipeRestOffset(result, geometry))
    }
  }

  // Another row opening closes this one.
  LaunchedEffect(coordinator.openRow) {
    if (coordinator.openRow != id && offset.value != 0f && !offset.isRunning) moveTo(0f)
  }
  val tag = node.testTag
  Box(
    modifier
      .clipToBounds()
      .onSizeChanged { rowWidth = it.width.toFloat() }
      .semantics {
        customActions = entries.map { (_, entry) ->
          CustomAccessibilityAction(entry.label) {
            interact(PrototypeInteraction.Tap(entry.onTap))
            true
          }
        }
      },
  ) {
    val shown = offset.value
    if (shown != 0f) {
      val side = if (shown > 0f) SwipeSide.START else SwipeSide.END
      PrototypeSwipeButtons(side, abs(shown), swipe, tag, density) { action ->
        interact(PrototypeInteraction.Tap(action.onTap))
        coordinator.closed(id)
        scope.launch { moveTo(0f) }
      }
    }
    Box(
      Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }
        .draggable(
          orientation = Orientation.Horizontal,
          state =
            rememberDraggableState { delta ->
              raw += delta
              scope.launch { offset.snapTo(swipeRubberBand(raw, geometry)) }
            },
          onDragStarted = { raw = offset.value },
          onDragStopped = { velocity -> settle(swipeSettle(offset.value, velocity, geometry)) },
        ),
    ) {
      content()
      if (shown != 0f) {
        // An open row swallows taps: the first tap closes it instead of running the row's action.
        Box(
          Modifier.matchParentSize()
            .clearAndSetSemantics {}
            .clickable(
              interactionSource = null,
              indication = null,
            ) {
              coordinator.closed(id)
              scope.launch { moveTo(0f) }
            },
        )
      }
    }
  }
}

@Composable
private fun androidx.compose.foundation.layout.BoxScope.PrototypeSwipeButtons(
  side: SwipeSide,
  reveal: Float,
  swipe: PrototypeSwipeActions,
  tag: String?,
  density: Float,
  onAction: (PrototypeSwipeAction) -> Unit,
) {
  val actions = (if (side == SwipeSide.START) swipe.start else swipe.end).orEmpty()
  if (actions.isEmpty()) return
  val offsetBase = if (side == SwipeSide.START) 0 else swipe.start.orEmpty().size
  val widths =
    swipeButtonWidths(actions.size, reveal, PrototypeSwipeTuning.BUTTON_WIDTH_DP * density)
  // The first entry sits at the screen edge; the end side lays out from the right.
  val ordered = actions.indices.toList().let { if (side == SwipeSide.END) it.reversed() else it }
  Box(
    Modifier.align(if (side == SwipeSide.START) Alignment.CenterStart else Alignment.CenterEnd)
      .fillMaxHeight()
      .width((reveal / density).dp)
      .clipToBounds(),
  ) {
    Row(
      Modifier.align(if (side == SwipeSide.START) Alignment.CenterStart else Alignment.CenterEnd)
        .fillMaxHeight()
        .requiredWidth((widths.sum() / density).dp),
      horizontalArrangement = Arrangement.Start,
    ) {
      ordered.forEach { index ->
        val action = actions[index]
        PrototypeSwipeButton(
          action,
          (widths[index] / density).dp.value,
          tag?.let { "$it.swipe.${offsetBase + index}" },
          onAction,
        )
      }
    }
  }
}

@Composable
private fun PrototypeSwipeButton(
  action: PrototypeSwipeAction,
  widthDp: Float,
  testTag: String?,
  onAction: (PrototypeSwipeAction) -> Unit,
) {
  val scheme = MaterialTheme.colorScheme
  val destructive = action.role == "destructive"
  val background =
    action.color?.let { prototypeSwipeColor(scheme, it) }
      ?: if (destructive) scheme.error else scheme.primary
  val content =
    if (destructive && action.color == null) scheme.onError
    else prototypeContrast(background, scheme)
  Column(
    Modifier.width(widthDp.dp)
      .fillMaxHeight()
      .background(background)
      .clickable(role = Role.Button) { onAction(action) }
      .semantics {
        contentDescription = action.label
        testTag?.let { this.testTag = it }
      },
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    prototypeIcon(action.icon)?.let { Icon(it, contentDescription = null, tint = content) }
    Text(action.label, color = content, maxLines = 1)
  }
}

/** A swipe action colour: a `#RRGGBB[AA]` hex or a theme role name. */
internal fun prototypeSwipeColor(
  scheme: androidx.compose.material3.ColorScheme,
  value: String,
): Color? =
  if (value.startsWith("#")) runCatching { prototypeColor(value) }.getOrNull()
  else prototypeColorRole(scheme, value)

/** Black or white text, whichever contrasts with a custom button background. */
private fun prototypeContrast(
  background: Color,
  scheme: androidx.compose.material3.ColorScheme,
): Color =
  if (background == scheme.primary) scheme.onPrimary
  else if (background.luminanceValue() > 0.5f) Color.Black else Color.White

private fun Color.luminanceValue(): Float = 0.299f * red + 0.587f * green + 0.114f * blue
