package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import dev.jasonpearson.automobile.protocol.*
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/** Immutable, device-free inputs for the Compose adapter. All numeric sizes remain dp. */
data class OverlayRenderStyle(
  val source: OverlayStyle,
  val background: Color?,
  val borderColor: Color?,
  val color: Color,
  val alignment: Alignment,
  val horizontalAlignment: Alignment.Horizontal,
  val verticalAlignment: Alignment.Vertical,
  val fontWeight: FontWeight,
  val fontFamily: FontFamily,
  /** Font asset id when `fontFamily` is `{asset}`; [fontFamily] is then only the fallback. */
  val fontAsset: String? = null,
  val textAlign: TextAlign,
  /** Hex `shadowColor`; a role name resolves against the theme during composition. */
  val shadowColor: Color? = null,
  val fontStyle: FontStyle = FontStyle.Normal,
  val textDecoration: TextDecoration = TextDecoration.None,
  val overflow: TextOverflow = TextOverflow.Clip,
)

data class OverlayRenderNode(
  val role: String,
  val text: String,
  val testTag: String?,
  val visible: Boolean,
  val style: OverlayRenderStyle,
  val safeArea: OverlaySafeAreaPadding?,
  val iconName: String? = null,
  val children: List<OverlayRenderNode> = emptyList(),
  val source: OverlayNode? = null,
  val identity: String = "root",
  val page: Int = 0,
  val selection: Int = 0,
  /** Whether a `bottomSheet`, `dialog` or `snackbar` is open (its `openWhen` holds). */
  val sheetOpen: Boolean = false,
  /** The bound boolean of a `switch` or `checkbox`; false for every other role. */
  val checked: Boolean = false,
  /**
   * The bound string of a `radioGroup` or `segmentedButton` (the option marked selected) or of a
   * `datePicker` (its `YYYY-MM-DD` date); null for every other role.
   */
  val selectedValue: String? = null,
  /** The bound number of a `slider` or a determinate `progress`; 0 for every other role. */
  val sliderValue: Double = 0.0,
  /** A `dialog`'s body text, state placeholders resolved; null for every other role. */
  val supportingText: String? = null,
  /** A `timePicker`'s bound hour (0..23) and minute (0..59); 0 for every other role. */
  val hour: Int = 0,
  val minute: Int = 0,
  /** The authored `contentDescription`, state placeholders resolved; null when not authored. */
  val contentDescription: String? = null,
)

data class OverlayRenderModel(
  val placement: OverlayPlacement,
  val opacityPercent: Int,
  val root: OverlayRenderNode,
  val hasTextField: Boolean = false,
  val theme: OverlaySpecTheme? = null,
  val layer: OverlayWindowLayer = OverlayWindowLayer.SYSTEM,
  val persistent: Boolean = false,
  val motion: String? = null,
) {
  fun request() =
    InteractiveOverlayRequest(
      placement = placement,
      opacityPercent = opacityPercent,
      hasTextField = hasTextField,
      layer = layer,
      persistent = persistent,
    ) {
      OverlaySpecContent(root, theme = theme)
    }
}

/**
 * Path spelling and traversal order match the protocol validator, including unsupported nodes.
 * `repeat` templates count once per instance, so an expanded list cannot exceed the node limit.
 */
fun guardOverlayTree(root: OverlayNode) {
  var count = 0
  fun visit(node: OverlayNode, path: String, depth: Int) {
    require(++count <= OverlaySpecValidator.MAX_OVERLAY_NODES) { "$path: Node limit exceeded" }
    require(depth <= OverlaySpecValidator.MAX_OVERLAY_DEPTH) { "$path: Tree depth limit exceeded" }
    overlayChildEntries(node, path, bind = false).forEach { visit(it.node, it.path, depth + 1) }
  }
  visit(root, "root", 1)
}

fun mapOverlaySpec(spec: OverlaySpec, pages: Map<String, Int> = emptyMap()): OverlayRenderModel {
  guardOverlayTree(spec.root)
  val mapped = mapOverlayNode(spec.root, spec.state.orEmpty(), pages, "root")
  return OverlayRenderModel(
    mapOverlayPlacement(spec.window.placement),
    spec.window.opacity,
    mapped,
    hasVisibleTextField(mapped),
    spec.theme,
    OverlayWindowLayer.fromWire(spec.window.layer),
    isDevicePersistent(spec),
    spec.motion,
  )
}

private fun mapOverlayNode(
  node: OverlayNode,
  state: Map<String, OverlayScalar>,
  pages: Map<String, Int>,
  path: String,
  pagerContext: Pair<Int, Int>? = null,
): OverlayRenderNode {
  val context =
    if (node is OverlayPagerNode) (pages[node.id] ?: 0) to node.children.size else pagerContext
  val localState =
    if (context == null) state
    else
      state +
        mapOf(
          "page" to OverlayScalar.Numeric((context.first + 1).toDouble()),
          "pageCount" to OverlayScalar.Numeric(context.second.toDouble()),
        )
  requireOverlayRenderSizes(node.style, path)
  node.styleWhen?.forEachIndexed { index, entry ->
    requireOverlayRenderSizes(entry.style, "$path.styleWhen[$index]")
  }
  val role =
    when (node) {
      is OverlayBoxNode -> "box"
      is OverlayRowNode -> "row"
      is OverlayColumnNode -> "column"
      is OverlayTextNode -> "text"
      is OverlayImageNode -> "image"
      is OverlayIconNode -> "icon"
      is OverlaySpacerNode -> "spacer"
      is OverlayTextFieldNode -> "textField"
      is OverlaySwitchNode -> "switch"
      is OverlayCheckboxNode -> "checkbox"
      is OverlayButtonNode -> "button"
      is OverlayRadioGroupNode -> "radioGroup"
      is OverlayListItemNode -> "listItem"
      is OverlaySliderNode -> "slider"
      is OverlayChipNode -> "chip"
      is OverlayCardNode -> "card"
      is OverlayIconButtonNode -> "iconButton"
      is OverlayFabNode -> "fab"
      is OverlaySegmentedButtonNode -> "segmentedButton"
      is OverlayTopAppBarNode -> "topAppBar"
      is OverlayDividerNode -> "divider"
      is OverlayBadgeNode -> "badge"
      is OverlayProgressNode -> "progress"
      is OverlayDialogNode -> "dialog"
      is OverlaySnackbarNode -> "snackbar"
      is OverlayTimePickerNode -> "timePicker"
      is OverlayDatePickerNode -> "datePicker"
      is OverlayScrollNode -> "scroll"
      is OverlayPagerNode -> "pager"
      is OverlayTabBarNode -> "tabBar"
      is OverlayBottomNavNode -> "bottomNav"
      is OverlayBottomSheetNode -> "bottomSheet"
    }
  val text =
    when (node) {
      is OverlayTextNode -> interpolateOverlayText(node.text, localState, context != null)
      is OverlayTextFieldNode -> (state[node.stateKey] as? OverlayScalar.Text)?.value.orEmpty()
      is OverlaySwitchNode -> node.label.orEmpty()
      is OverlayCheckboxNode -> node.label.orEmpty()
      is OverlayButtonNode -> node.label
      is OverlayListItemNode -> node.headline
      is OverlaySliderNode -> node.label.orEmpty()
      is OverlayChipNode -> node.label
      is OverlayIconNode -> node.name
      is OverlayFabNode -> node.label.orEmpty()
      is OverlayTopAppBarNode -> interpolateOverlayText(node.title, localState, context != null)
      is OverlayBadgeNode ->
        node.text?.let { interpolateOverlayText(it, localState, context != null) }.orEmpty()
      is OverlayDialogNode ->
        node.title?.let { interpolateOverlayText(it, localState, context != null) }.orEmpty()
      is OverlaySnackbarNode -> interpolateOverlayText(node.text, localState, context != null)
      else -> ""
    }
  val children =
    overlayChildEntries(node, path).map { (child, childPath) ->
      mapOverlayNode(child, state, pages, childPath, context)
    }
  val pager =
    when (node) {
      is OverlayTabBarNode -> node.pager
      is OverlayBottomNavNode -> node.pager
      else -> null
    }
  val stateKey =
    when (node) {
      is OverlayTabBarNode -> node.stateKey
      is OverlayBottomNavNode -> node.stateKey
      else -> null
    }
  val items =
    when (node) {
      is OverlayTabBarNode -> node.items
      is OverlayBottomNavNode -> node.items
      else -> emptyList()
    }
  val selected =
    pager?.let { pages[it] } ?: (state[stateKey] as? OverlayScalar.Numeric)?.value?.toInt() ?: 0
  return OverlayRenderNode(
    role,
    text,
    node.testTag,
    node.visibleWhen?.holds(localState) ?: true,
    mapOverlayStyle(resolveOverlayStyle(node.style, node.styleWhen, localState)),
    node.safeAreaPadding,
    overlayNodeIconName(node),
    children,
    node,
    path,
    (node as? OverlayPagerNode)?.let { pages[it.id] } ?: 0,
    selected.coerceIn(0, (items.size - 1).coerceAtLeast(0)),
    overlayOpenWhen(node)?.let { state[it.key] == OverlayScalar.BooleanValue(it.equals) } ?: false,
    checked =
      (overlayToggleKey(node) ?: overlayListItemToggleKey(node))?.let {
        state[it] == OverlayScalar.BooleanValue(true)
      } ?: false,
    selectedValue = overlaySelectionKey(node)?.let { (state[it] as? OverlayScalar.Text)?.value },
    sliderValue =
      overlayNumberKey(node)?.let { (state[it] as? OverlayScalar.Numeric)?.value } ?: 0.0,
    supportingText =
      (node as? OverlayDialogNode)?.text?.let {
        interpolateOverlayText(it, localState, context != null)
      },
    hour = overlayStateInt(state, (node as? OverlayTimePickerNode)?.hourKey),
    minute = overlayStateInt(state, (node as? OverlayTimePickerNode)?.minuteKey),
    contentDescription =
      node.contentDescription?.let { interpolateOverlayText(it, localState, context != null) },
  )
}

/** The icon a node draws as its whole content, which labels it when nothing else does. */
private fun overlayNodeIconName(node: OverlayNode): String? =
  when (node) {
    is OverlayIconNode -> node.name
    is OverlayIconButtonNode -> node.icon
    is OverlayFabNode -> node.icon
    else -> null
  }

/** The boolean condition that opens a `bottomSheet`, `dialog` or `snackbar`; null otherwise. */
internal fun overlayOpenWhen(node: OverlayNode?): OverlaySheetCondition? =
  when (node) {
    is OverlayBottomSheetNode -> node.openWhen
    is OverlayDialogNode -> node.openWhen
    is OverlaySnackbarNode -> node.openWhen
    else -> null
  }

/** The string key a `radioGroup`, `segmentedButton` or `datePicker` is bound to. */
private fun overlaySelectionKey(node: OverlayNode): String? =
  when (node) {
    is OverlayRadioGroupNode -> node.stateKey
    is OverlaySegmentedButtonNode -> node.stateKey
    is OverlayDatePickerNode -> node.stateKey
    else -> null
  }

/** The number key a `slider` or a determinate `progress` is bound to. */
private fun overlayNumberKey(node: OverlayNode): String? =
  when (node) {
    is OverlaySliderNode -> node.stateKey
    is OverlayProgressNode -> node.stateKey
    else -> null
  }

private fun overlayStateInt(state: Map<String, OverlayScalar>, key: String?): Int =
  key?.let { (state[it] as? OverlayScalar.Numeric)?.value?.toInt() } ?: 0

/**
 * Pager placeholders use one-based page labels in the nearest pager; outside it they stay literal.
 *
 * Tokens (`{key}` with an ASCII identifier key) are found by a plain string scan rather than a
 * regex: Android's ICU regex engine rejects a lone `}` that the desktop JVM accepts, which broke
 * every overlay `show` on a device (#9947) while the JVM unit tests stayed green.
 */
fun interpolateOverlayText(
  text: String,
  state: Map<String, OverlayScalar>,
  inPager: Boolean = false,
): String {
  val out = StringBuilder(text.length)
  var index = 0
  while (index < text.length) {
    val end = interpolationTokenEnd(text, index)
    if (end < 0) {
      out.append(text[index])
      index++
    } else {
      out.append(resolveInterpolation(text.substring(index, end), state, inPager))
      index = end
    }
  }
  return out.toString()
}

/**
 * Returns the index just past the `{key}` token starting at [start], or -1 if none starts there.
 */
private fun interpolationTokenEnd(text: String, start: Int): Int {
  var index = start + 1
  val opensToken = text[start] == '{' && index < text.length && isInterpolationKeyStart(text[index])
  if (opensToken) {
    index++
    while (index < text.length && isInterpolationKeyPart(text[index])) index++
  }
  return if (opensToken && index < text.length && text[index] == '}') index + 1 else -1
}

private fun isInterpolationKeyStart(c: Char): Boolean = c in 'A'..'Z' || c in 'a'..'z' || c == '_'

private fun isInterpolationKeyPart(c: Char): Boolean = isInterpolationKeyStart(c) || c in '0'..'9'

private fun resolveInterpolation(
  token: String,
  state: Map<String, OverlayScalar>,
  inPager: Boolean,
): String {
  val key = token.substring(1, token.length - 1)
  if (!inPager && (key == "page" || key == "pageCount")) return token
  return when (val value = state[key]) {
    is OverlayScalar.Text -> value.value
    is OverlayScalar.BooleanValue -> value.value.toString()
    is OverlayScalar.Numeric -> value.value.toString().removeSuffix(".0")
    null -> token
  }
}

/** The settled design specifies AARRGGBB (alpha first), not CSS RRGGBBAA. */
fun overlayColor(value: String): Color {
  require(value.matches(Regex("#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?"))) { "Invalid color: $value" }
  val argb = value.drop(1).toLong(16)
  return Color(if (value.length == 7) argb or 0xff000000L else argb)
}

/** The colour of a hex value, or null for a Material ColorScheme role name (resolved in render). */
private fun overlayHexColor(value: String?): Color? =
  value?.takeIf { it.startsWith("#") }?.let(::overlayColor)

fun mapOverlayStyle(style: OverlayStyle): OverlayRenderStyle =
  OverlayRenderStyle(
    style,
    overlayHexColor(style.background),
    overlayHexColor(style.border?.color),
    // Unspecified: an unstyled node takes the theme's content colour, not a fixed black.
    overlayHexColor(style.color) ?: Color.Unspecified,
    overlayAlignment(style.alignment),
    overlayHorizontalAlignment(style.alignment),
    overlayVerticalAlignment(style.alignment),
    FontWeight(style.fontWeight ?: 400),
    builtInFontFamily(style.fontFamily),
    (style.fontFamily as? OverlayFontFamily.Asset)?.id,
    when (style.textAlign) {
      "center" -> TextAlign.Center
      "end" -> TextAlign.End
      "justify" -> TextAlign.Justify
      else -> TextAlign.Start
    },
    overlayHexColor(style.shadowColor),
    if (style.fontStyle == "italic") FontStyle.Italic else FontStyle.Normal,
    overlayTextDecoration(style.textDecoration),
    when (style.overflow) {
      "ellipsis" -> TextOverflow.Ellipsis
      "visible" -> TextOverflow.Visible
      else -> TextOverflow.Clip
    },
  )

private fun overlayTextDecoration(value: String?): TextDecoration =
  when (value) {
    "underline" -> TextDecoration.Underline
    "lineThrough" -> TextDecoration.LineThrough
    "underlineLineThrough" ->
      TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
    else -> TextDecoration.None
  }

private fun builtInFontFamily(family: OverlayFontFamily?): FontFamily =
  when ((family as? OverlayFontFamily.Named)?.name) {
    "sansSerif" -> FontFamily.SansSerif
    "serif" -> FontFamily.Serif
    "monospace" -> FontFamily.Monospace
    else -> FontFamily.Default
  }

private fun overlayAlignment(value: String?): Alignment =
  when (value) {
    "topCenter" -> Alignment.TopCenter
    "topEnd" -> Alignment.TopEnd
    "centerStart" -> Alignment.CenterStart
    "center" -> Alignment.Center
    "centerEnd" -> Alignment.CenterEnd
    "bottomStart" -> Alignment.BottomStart
    "bottomCenter" -> Alignment.BottomCenter
    "bottomEnd" -> Alignment.BottomEnd
    else -> Alignment.TopStart
  }

private fun overlayHorizontalAlignment(value: String?): Alignment.Horizontal =
  when (value) {
    "topCenter",
    "center",
    "bottomCenter" -> Alignment.CenterHorizontally
    "topEnd",
    "centerEnd",
    "bottomEnd" -> Alignment.End
    else -> Alignment.Start
  }

private fun overlayVerticalAlignment(value: String?): Alignment.Vertical =
  when (value) {
    "centerStart",
    "center",
    "centerEnd" -> Alignment.CenterVertically
    "bottomStart",
    "bottomCenter",
    "bottomEnd" -> Alignment.Bottom
    else -> Alignment.Top
  }

/**
 * Start and end points of a linear gradient line for a [width] x [height] px box. Angle is degrees
 * clockwise from "toward the end edge": 0 runs left to right, 90 top to bottom. The line passes
 * through the center and is long enough that the corners take the first and last stop colors.
 */
fun overlayLinearGradientLine(angle: Double, width: Float, height: Float): Pair<Offset, Offset> {
  val radians = Math.toRadians(angle)
  val dx = cos(radians).toFloat()
  val dy = sin(radians).toFloat()
  val half = (abs(width * dx) + abs(height * dy)) / 2f
  val center = Offset(width / 2f, height / 2f)
  return Offset(center.x - dx * half, center.y - dy * half) to
    Offset(center.x + dx * half, center.y + dy * half)
}

/**
 * Stop colors and, only when every stop authors a position, their explicit positions. Positions are
 * made non-decreasing (a stop never starts before the previous one), which is what Skia does to a
 * descending list anyway, so the rendered result is deterministic and documented.
 */
fun overlayGradientStops(stops: List<OverlayGradientStop>): Pair<List<Color>, List<Float>?> {
  val colors = stops.map { overlayColor(it.color) }
  val positions = stops.map { it.position?.toFloat() }
  if (!positions.all { it != null }) return colors to null
  var floor = 0f
  return colors to
    positions.map {
      floor = maxOf(floor, checkNotNull(it))
      floor
    }
}

/** Compose uses Float dp; reject unrepresentable values before installing a content lambda. */
private fun requireOverlayRenderSizes(style: OverlayStyle?, path: String) {
  if (style == null) return
  val sizes =
    mapOf(
      "width.dp" to (style.width as? OverlayDimension.Dp)?.dp,
      "height.dp" to (style.height as? OverlayDimension.Dp)?.dp,
      "weight" to style.weight,
      "elevation" to style.elevation,
      "aspectRatio" to style.aspectRatio,
      "gradient.angle" to (style.gradient as? OverlayLinearGradient)?.angle,
      "minWidth" to style.minWidth,
      "maxWidth" to style.maxWidth,
      "minHeight" to style.minHeight,
      "maxHeight" to style.maxHeight,
      "padding.top" to style.padding?.top,
      "padding.bottom" to style.padding?.bottom,
      "padding.start" to style.padding?.start,
      "padding.end" to style.padding?.end,
      "cornerRadius" to (style.cornerRadius as? OverlayCornerRadius.Dp)?.dp,
      "cornerRadius.topStart" to (style.cornerRadius as? OverlayCornerRadius.Corners)?.topStart,
      "cornerRadius.topEnd" to (style.cornerRadius as? OverlayCornerRadius.Corners)?.topEnd,
      "cornerRadius.bottomEnd" to (style.cornerRadius as? OverlayCornerRadius.Corners)?.bottomEnd,
      "cornerRadius.bottomStart" to
        (style.cornerRadius as? OverlayCornerRadius.Corners)?.bottomStart,
      "offset.x" to style.offset?.x,
      "offset.y" to style.offset?.y,
      "border.width" to style.border?.width,
      "spacing" to style.spacing,
      "textSize" to style.textSize,
      "lineHeight" to style.lineHeight,
      "letterSpacing" to style.letterSpacing,
    )
  for ((key, value) in sizes) {
    require(value == null || value.toFloat().isFinite()) {
      "$path.style.$key: Size cannot be represented in Compose dp"
    }
  }
}

/**
 * True only while an editable field is actually on screen: not hidden by `visibleWhen`, not on a
 * pager page other than the settled one, and not inside a closed bottom sheet. Open sheets are
 * hoisted and rendered by [modalOverlaySheets], so their fields count and their closed twins do
 * not. The window may take input focus only while this holds.
 */
fun hasVisibleTextField(root: OverlayRenderNode): Boolean =
  inlineTextFieldVisible(root) ||
    modalOverlaySheets(root).any { sheet -> sheet.children.any(::inlineTextFieldVisible) }

private fun inlineTextFieldVisible(node: OverlayRenderNode): Boolean =
  when {
    !node.visible -> false
    node.role == "textField" -> true
    node.role in OVERLAY_MODAL_ROLES -> false // Hoisted: only modalOverlaySheets renders it.
    node.role == "pager" ->
      node.children.getOrNull(node.page)?.let(::inlineTextFieldVisible) == true
    else -> node.children.any(::inlineTextFieldVisible)
  }

/** Roles drawn above the whole author tree while their `openWhen` holds, never inline. */
internal val OVERLAY_MODAL_ROLES = setOf("bottomSheet", "dialog", "snackbar")

/**
 * Open sheets, dialogs and snackbars are rendered last, in tree order, so a modal scrim covers the
 * entire overlay window.
 */
fun modalOverlaySheets(node: OverlayRenderNode): List<OverlayRenderNode> {
  if (!node.visible) return emptyList()
  val modal = node.role in OVERLAY_MODAL_ROLES
  if (modal && !node.sheetOpen) return emptyList()
  val children =
    if (node.role == "pager") listOfNotNull(node.children.getOrNull(node.page)) else node.children
  return (if (modal) listOf(node) else emptyList()) + children.flatMap(::modalOverlaySheets)
}

/** Roles that compose their children inline through the node renderer; others never draw them. */
private val OVERLAY_INLINE_CONTAINER_ROLES =
  setOf("box", "row", "column", "scroll", "card", "pager")

/** A non-root anchored node: drawn in the window-level anchor layer, never in its parent. */
internal fun isLayeredOverlayAnchor(node: OverlayRenderNode): Boolean =
  node.source?.anchor is OverlayBoundsAnchor

/**
 * The anchored nodes under [node] that the renderer draws in a window-level layer above the author
 * tree (#10803), in tree order. Drawn inside their parent they were clipped to its slot (a
 * wrap-content parent animating its size clips) and took a slot there. A node is listed when every
 * ancestor below [node] is shown: visible, on the settled pager page, and not inside a modal
 * (modals list their own through [layeredOverlayAnchorsIn]). The anchored node's own visibility is
 * left to the renderer, so its `visibleWhen` transition still runs. [node] itself is never listed:
 * a window root keeps its own anchored placement.
 */
fun layeredOverlayAnchors(node: OverlayRenderNode): List<OverlayRenderNode> {
  if (!node.visible || node.role !in OVERLAY_INLINE_CONTAINER_ROLES) return emptyList()
  val children =
    if (node.role == "pager") listOfNotNull(node.children.getOrNull(node.page)) else node.children
  return layeredOverlayAnchorsIn(children)
}

/** [layeredOverlayAnchors] for content drawn as [children], such as a modal's body. */
fun layeredOverlayAnchorsIn(children: List<OverlayRenderNode>): List<OverlayRenderNode> =
  children.flatMap { child ->
    (if (isLayeredOverlayAnchor(child)) listOf(child) else emptyList()) +
      layeredOverlayAnchors(child)
  }
