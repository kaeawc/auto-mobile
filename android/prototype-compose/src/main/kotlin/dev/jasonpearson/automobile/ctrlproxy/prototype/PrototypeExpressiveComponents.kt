package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ElevatedButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeFabNode
import dev.jasonpearson.automobile.protocol.PrototypeLoadingIndicatorNode
import dev.jasonpearson.automobile.protocol.PrototypeMenuDivider
import dev.jasonpearson.automobile.protocol.PrototypeMenuEntry
import dev.jasonpearson.automobile.protocol.PrototypeProgressNode
import dev.jasonpearson.automobile.protocol.PrototypeSegmentedButtonNode
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/*
 * Material 3 Expressive components (#15258). The pinned Compose BOM's material3 (1.4.0) ships the
 * Expressive tokens but none of these components, so each is drawn from stable primitives. Shape
 * and expansion follow the expressive spatial spring and colour the effects spring from the
 * contract's motion tokens ([prototypeExpressiveSpec]); everything snaps when motion is off.
 * Menus expand inline rather than in a popup, as the renderer never opens popup windows.
 */

/** Inner corner of a connected segment: small at rest, a full pill once selected. */
internal val PROTOTYPE_CONNECTED_INNER_CORNER = 8.dp
internal val PROTOTYPE_CONNECTED_FULL_CORNER = 20.dp
private val CONNECTED_HEIGHT = 40.dp

/** The animated inner corner of one connected segment; outer ends stay fully rounded. */
@Composable
internal fun animatePrototypeConnectedCorner(selected: Boolean): State<Dp> =
  animateDpAsState(
    if (selected) PROTOTYPE_CONNECTED_FULL_CORNER else PROTOTYPE_CONNECTED_INNER_CORNER,
    prototypeExpressiveSpec(),
    label = "connectedCorner",
  )

private fun connectedShape(index: Int, count: Int, inner: Dp): Shape {
  val full = PROTOTYPE_CONNECTED_FULL_CORNER
  val start = if (index == 0) full else inner
  val end = if (index == count - 1) full else inner
  return RoundedCornerShape(
    topStart = start,
    bottomStart = start,
    topEnd = end,
    bottomEnd = end,
  )
}

/**
 * A connected button group bound to a string key (`segmentedButton` `variant: "connected"`). Each
 * segment is a selectable node tagged `<testTag>.<value>` like a radio option; the selected one
 * morphs its inner corners into a pill and fills with the secondary container colour.
 */
@Composable
internal fun RenderPrototypeConnectedSegments(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeSegmentedButtonNode ?: return
  val actions = source.onTap.orEmpty()
  Row(modifier, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
    source.options.forEachIndexed { index, option ->
      val selected = option.value == node.selectedValue
      val inner by animatePrototypeConnectedCorner(selected)
      val colors = MaterialTheme.colorScheme
      val container by
        animateColorAsState(
          if (selected) colors.secondary else colors.secondaryContainer,
          prototypeExpressiveSpec(effects = true),
          label = "connectedContainer",
        )
      val content = if (selected) colors.onSecondary else colors.onSecondaryContainer
      Surface(
        shape = connectedShape(index, source.options.size, inner),
        color = container,
        contentColor = content,
        modifier =
          Modifier.weight(1f)
            .heightIn(min = CONNECTED_HEIGHT)
            .selectable(selected, role = Role.RadioButton) {
              interact(PrototypeInteraction.Choose(source.stateKey, option.value, actions))
            }
            .semantics {
              contentDescription = option.label
              prototypeRadioOptionTag(node.testTag, option.value)?.let { testTag = it }
            },
      ) {
        Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), Alignment.Center) {
          Text(option.label, Modifier.clearAndSetSemantics {})
        }
      }
    }
  }
}

/** Expansion of a FAB or split-button menu: 0 closed, 1 open, on the expressive spatial spring. */
@Composable
internal fun animatePrototypeMenuExpansion(open: Boolean): State<Float> =
  animateFloatAsState(if (open) 1f else 0f, prototypeExpressiveSpec(), label = "menuExpansion")

private fun Modifier.expansion(fraction: Float): Modifier = graphicsLayer {
  alpha = fraction.coerceIn(0f, 1f)
  scaleX = 0.6f + 0.4f * fraction
  scaleY = 0.6f + 0.4f * fraction
}

/**
 * A FAB whose tap opens a menu of 2-6 items stacked above it (`fab.menu`). The FAB runs its own
 * `onTap` (if any) and toggles the menu; an item tap closes the menu, then runs the item's `onTap`.
 * Items are tagged `<testTag>.items.<index>`. While open the FAB shows a close icon.
 */
@Composable
internal fun RenderPrototypeFabMenu(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeFabNode ?: return
  val menu = source.menu ?: return
  var open by remember(node.identity) { mutableStateOf(false) }
  val expansion by animatePrototypeMenuExpansion(open)
  Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(8.dp)) {
    if (open || expansion > 0f) {
      menu.items.forEachIndexed { index, item ->
        Surface(
          shape = CircleShape,
          color = MaterialTheme.colorScheme.primaryContainer,
          contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
          modifier =
            Modifier.expansion(expansion)
              .heightIn(min = 56.dp)
              .clickable(enabled = open, role = Role.Button) {
                open = false
                interact(PrototypeInteraction.Tap(item.onTap))
              }
              .semantics(mergeDescendants = true) {
                contentDescription = item.label
                prototypePartTag(node.testTag, "items.$index")?.let { testTag = it }
              },
        ) {
          Row(
            Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            prototypeIcon(item.icon)?.let { Icon(it, contentDescription = null) }
            Text(item.label, Modifier.clearAndSetSemantics {})
          }
        }
      }
    }
    val onClick = {
      source.onTap?.takeIf { it.isNotEmpty() }?.let { interact(PrototypeInteraction.Tap(it)) }
      open = !open
    }
    val icon: @Composable () -> Unit = {
      prototypeIcon(if (open) "close" else source.icon)?.let {
        Icon(it, contentDescription = null)
      }
    }
    when {
      !node.enabled -> RenderPrototypeFab(node, modifier, interact)
      source.size == "small" ->
        SmallFloatingActionButton(onClick, modifier, shape = CircleShape, content = icon)
      else ->
        FloatingActionButton(
          onClick,
          modifier,
          shape = if (open) CircleShape else MaterialTheme.shapes.large,
          content = icon,
        )
    }
  }
}

/**
 * A split button (`button.split`): the leading half runs the node's `onTap`, the trailing half
 * (tagged `<testTag>.menu`) opens the menu entries below it and morphs into a circle while open. An
 * entry tap closes the menu, then runs its `onTap`; entries are tagged `<testTag>.menu.<index>`.
 */
@Composable
internal fun RenderPrototypeSplitButton(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeButtonNode ?: return
  val split = source.split ?: return
  var open by remember(node.identity) { mutableStateOf(false) }
  val expansion by animatePrototypeMenuExpansion(open)
  val trailingCorner by
    animateDpAsState(
      if (open) PROTOTYPE_CONNECTED_FULL_CORNER else 4.dp,
      prototypeExpressiveSpec(),
      label = "splitCorner",
    )
  val actions = source.onTap.orEmpty()
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
      PrototypeVariantButton(
        source.variant,
        { if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions)) },
        Modifier,
        RoundedCornerShape(
          topStart = PROTOTYPE_CONNECTED_FULL_CORNER,
          bottomStart = PROTOTYPE_CONNECTED_FULL_CORNER,
          topEnd = 4.dp,
          bottomEnd = 4.dp,
        ),
        node.enabled,
      ) {
        prototypeIcon(source.icon)?.let {
          Icon(it, contentDescription = null, Modifier.size(ButtonDefaults.IconSize))
          Box(Modifier.size(ButtonDefaults.IconSpacing))
        }
        PrototypeComponentLabel(node)
      }
      PrototypeVariantButton(
        source.variant,
        { open = !open },
        Modifier.semantics {
          contentDescription = if (open) "Close menu" else "Open menu"
          prototypePartTag(node.testTag, "menu")?.let { testTag = it }
        },
        RoundedCornerShape(
          topStart = trailingCorner,
          bottomStart = trailingCorner,
          topEnd = PROTOTYPE_CONNECTED_FULL_CORNER,
          bottomEnd = PROTOTYPE_CONNECTED_FULL_CORNER,
        ),
        node.enabled,
        padding = PaddingValues(12.dp),
      ) {
        prototypeIcon("arrow_drop_down")?.let {
          Icon(it, contentDescription = null, Modifier.rotate(180f * expansion))
        }
      }
    }
    if (open || expansion > 0f) {
      Surface(
        Modifier.expansion(expansion).widthIn(min = 112.dp, max = 320.dp),
        shape = MaterialTheme.shapes.medium,
        tonalElevation = 3.dp,
        shadowElevation = 3.dp,
      ) {
        Column(Modifier.padding(vertical = 8.dp)) {
          split.menu.forEachIndexed { index, item ->
            when (item) {
              PrototypeMenuDivider -> HorizontalDivider()
              is PrototypeMenuEntry -> {
                val enabled = item.enabled != false
                Row(
                  Modifier.clickable(enabled = open && enabled, role = Role.Button) {
                      open = false
                      interact(PrototypeInteraction.Tap(item.onTap.orEmpty()))
                    }
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .alpha(if (enabled) 1f else 0.38f)
                    .semantics(mergeDescendants = true) {
                      contentDescription = item.label
                      prototypePartTag(node.testTag, "menu.$index")?.let { testTag = it }
                      if (!enabled) disabled()
                    }
                    .padding(horizontal = 16.dp),
                  horizontalArrangement = Arrangement.spacedBy(12.dp),
                  verticalAlignment = Alignment.CenterVertically,
                ) {
                  prototypeIcon(item.icon)?.let { Icon(it, contentDescription = null) }
                  Text(item.label, Modifier.weight(1f).clearAndSetSemantics {})
                  item.trailingText?.let { Text(it) }
                }
              }
            }
          }
        }
      }
    }
  }
}

@Composable
private fun PrototypeVariantButton(
  variant: String,
  onClick: () -> Unit,
  modifier: Modifier,
  shape: Shape,
  enabled: Boolean,
  padding: PaddingValues = ButtonDefaults.ContentPadding,
  content: @Composable RowScope.() -> Unit,
) {
  when (variant) {
    "tonal" ->
      FilledTonalButton(
        onClick,
        modifier,
        enabled,
        shape,
        contentPadding = padding,
        content = content,
      )
    "elevated" ->
      ElevatedButton(onClick, modifier, enabled, shape, contentPadding = padding, content = content)
    "outlined" ->
      OutlinedButton(onClick, modifier, enabled, shape, contentPadding = padding, content = content)
    "text" ->
      TextButton(onClick, modifier, enabled, shape, contentPadding = padding, content = content)
    else -> Button(onClick, modifier, enabled, shape, contentPadding = padding, content = content)
  }
}

private const val WAVY_REST = 0.3f
private val WAVY_HEIGHT = 10.dp
private val WAVY_AMPLITUDE = 3.dp
private val WAVY_WAVELENGTH = 40.dp
private val WAVY_STROKE = 4.dp
private val WAVY_GAP = 4.dp

/**
 * A wavy linear progress (`progress` `variant: "wavy"`): the active track is a sine stroke, the
 * remaining track a flat line. Bound to a number it is determinate; unbound it is indeterminate,
 * sliding a wavy segment while motion is on and resting at a fixed fraction while it is off.
 */
@Composable
internal fun RenderPrototypeWavyProgress(node: PrototypeRenderNode, modifier: Modifier) {
  val source = node.source as? PrototypeProgressNode ?: return
  val indeterminate = source.stateKey == null
  val fraction = prototypeProgressFraction(node.sliderValue, source.max)
  val moving = indeterminate && LocalPrototypeMotion.current
  val phase = if (moving) prototypeLoopFraction(1200) else 0f
  val active = MaterialTheme.colorScheme.primary
  val track = MaterialTheme.colorScheme.secondaryContainer
  Canvas(
    modifier.fillMaxWidth().height(WAVY_HEIGHT).semantics {
      progressBarRangeInfo =
        if (indeterminate) ProgressBarRangeInfo.Indeterminate
        else ProgressBarRangeInfo(fraction, 0f..1f)
    },
  ) {
    val stroke = WAVY_STROKE.toPx()
    val (start, end) =
      when {
        !indeterminate -> 0f to fraction
        moving -> (phase * 1.3f - 0.3f).coerceIn(0f, 1f) to (phase * 1.3f).coerceIn(0f, 1f)
        else -> 0f to WAVY_REST
      }
    val mid = size.height / 2
    val gap = WAVY_GAP.toPx()
    val startX = start * size.width
    val endX = end * size.width
    val trackStart = if (endX > 0f) endX + gap else 0f
    if (trackStart < size.width) {
      drawLine(track, Offset(trackStart, mid), Offset(size.width, mid), stroke, StrokeCap.Round)
    }
    if (endX - startX > stroke) {
      drawPath(
        prototypeWavePath(startX, endX, mid, WAVY_AMPLITUDE.toPx(), WAVY_WAVELENGTH.toPx(), phase),
        active,
        style = Stroke(stroke, cap = StrokeCap.Round),
      )
    }
  }
}

/** A sine path from [startX] to [endX] around [mid]; [phase] (0..1) shifts it by one wavelength. */
internal fun prototypeWavePath(
  startX: Float,
  endX: Float,
  mid: Float,
  amplitude: Float,
  wavelength: Float,
  phase: Float,
): Path {
  val path = Path()
  val step = 2f
  var x = startX
  while (x <= endX) {
    val y = mid + amplitude * sin(2 * PI * (x / wavelength - phase)).toFloat()
    if (x == startX) path.moveTo(x, y) else path.lineTo(x, y)
    x += step
  }
  return path
}

@Composable
private fun prototypeLoopFraction(durationMs: Int): Float {
  val transition = rememberInfiniteTransition(label = "expressiveLoop")
  val value by
    transition.animateFloat(
      0f,
      1f,
      infiniteRepeatable(tween(durationMs, easing = LinearEasing), RepeatMode.Restart),
      label = "expressiveLoopFraction",
    )
  return value
}

private val LOADING_SIZE = 48.dp
private val LOADING_ACTIVE = 38.dp

/**
 * The shape-morphing loading indicator (`loadingIndicator`): a rotating rounded polygon whose lobes
 * swell and settle. `contained: true` draws it on a primary-container circle. It is always
 * indeterminate; with motion off it rests as a still seven-lobed shape.
 */
@Composable
internal fun RenderPrototypeLoadingIndicator(node: PrototypeRenderNode, modifier: Modifier) {
  val source = node.source as? PrototypeLoadingIndicatorNode ?: return
  val contained = source.contained == true
  val moving = LocalPrototypeMotion.current
  val loop = if (moving) prototypeLoopFraction(2600) else 0f
  val colors = MaterialTheme.colorScheme
  val color = if (contained) colors.onPrimaryContainer else colors.primary
  val background =
    if (contained) Modifier.background(colors.primaryContainer, CircleShape) else Modifier
  Box(
    modifier.size(LOADING_SIZE).then(background).semantics {
      progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
    },
    Alignment.Center,
  ) {
    Canvas(Modifier.size(LOADING_ACTIVE)) {
      // Lobe depth breathes twice per loop; the shape turns a full circle per loop.
      val depth = 0.08f + 0.06f * cos(4 * PI * loop).toFloat()
      rotate(360f * loop) {
        drawPath(prototypeLobedPath(size.minDimension / 2, 7, depth, center), color)
      }
    }
  }
}

/** A closed shape of [lobes] rounded lobes: radius modulated by a cosine of relative [depth]. */
internal fun prototypeLobedPath(radius: Float, lobes: Int, depth: Float, center: Offset): Path {
  val path = Path()
  val steps = 96
  val base = radius * (1 - depth)
  for (i in 0..steps) {
    val theta = 2 * PI * i / steps
    val r = base + radius * depth * cos(lobes * theta).toFloat()
    val x = center.x + r * cos(theta).toFloat()
    val y = center.y + r * sin(theta).toFloat()
    if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
  }
  path.close()
  return path
}
