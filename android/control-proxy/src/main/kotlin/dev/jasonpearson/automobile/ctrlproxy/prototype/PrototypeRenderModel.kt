package dev.jasonpearson.automobile.ctrlproxy.prototype

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
data class PrototypeRenderStyle(
  val source: PrototypeStyle,
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

data class PrototypeRenderNode(
  val role: String,
  val text: String,
  val testTag: String?,
  val visible: Boolean,
  val style: PrototypeRenderStyle,
  val safeArea: PrototypeSafeAreaPadding?,
  val iconName: String? = null,
  val children: List<PrototypeRenderNode> = emptyList(),
  val source: PrototypeNode? = null,
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

data class PrototypeRenderModel(
  val placement: PrototypePlacement,
  val opacityPercent: Int,
  val root: PrototypeRenderNode,
  val hasTextField: Boolean = false,
  val theme: PrototypeSpecTheme? = null,
  val layer: PrototypeWindowLayer = PrototypeWindowLayer.SYSTEM,
  val persistent: Boolean = false,
  val motion: String? = null,
) {
  fun request() =
    PrototypeRequest(
      placement = placement,
      opacityPercent = opacityPercent,
      hasTextField = hasTextField,
      layer = layer,
      persistent = persistent,
    ) {
      PrototypeSpecContent(root, theme = theme)
    }
}

/**
 * Path spelling and traversal order match the protocol validator, including unsupported nodes.
 * `repeat` templates count once per instance, so an expanded list cannot exceed the node limit.
 */
fun guardPrototypeTree(root: PrototypeNode) {
  var count = 0
  fun visit(node: PrototypeNode, path: String, depth: Int) {
    require(++count <= PrototypeSpecValidator.MAX_PROTOTYPE_NODES) { "$path: Node limit exceeded" }
    require(depth <= PrototypeSpecValidator.MAX_PROTOTYPE_DEPTH) {
      "$path: Tree depth limit exceeded"
    }
    prototypeChildEntries(node, path, bind = false).forEach { visit(it.node, it.path, depth + 1) }
  }
  visit(root, "root", 1)
}

fun mapPrototypeSpec(
  spec: PrototypeSpec,
  pages: Map<String, Int> = emptyMap(),
): PrototypeRenderModel {
  guardPrototypeTree(spec.root)
  val mapped = mapPrototypeNode(spec.root, spec.state.orEmpty(), pages, "root")
  return PrototypeRenderModel(
    mapPrototypePlacement(spec.window.placement),
    spec.window.opacity,
    mapped,
    hasVisibleTextField(mapped),
    spec.theme,
    PrototypeWindowLayer.fromWire(spec.window.layer),
    isDevicePersistent(spec),
    spec.motion,
  )
}

private fun mapPrototypeNode(
  node: PrototypeNode,
  state: Map<String, PrototypeScalar>,
  pages: Map<String, Int>,
  path: String,
  pagerContext: Pair<Int, Int>? = null,
): PrototypeRenderNode {
  val context =
    if (node is PrototypePagerNode) (pages[node.id] ?: 0) to node.children.size else pagerContext
  val localState =
    if (context == null) state
    else
      state +
        mapOf(
          "page" to PrototypeScalar.Numeric((context.first + 1).toDouble()),
          "pageCount" to PrototypeScalar.Numeric(context.second.toDouble()),
        )
  requirePrototypeRenderSizes(node.style, path)
  node.styleWhen?.forEachIndexed { index, entry ->
    requirePrototypeRenderSizes(entry.style, "$path.styleWhen[$index]")
  }
  val role =
    when (node) {
      is PrototypeBoxNode -> "box"
      is PrototypeRowNode -> "row"
      is PrototypeColumnNode -> "column"
      is PrototypeTextNode -> "text"
      is PrototypeImageNode -> "image"
      is PrototypeIconNode -> "icon"
      is PrototypeSpacerNode -> "spacer"
      is PrototypeTextFieldNode -> "textField"
      is PrototypeSwitchNode -> "switch"
      is PrototypeCheckboxNode -> "checkbox"
      is PrototypeButtonNode -> "button"
      is PrototypeRadioGroupNode -> "radioGroup"
      is PrototypeListItemNode -> "listItem"
      is PrototypeSliderNode -> "slider"
      is PrototypeChipNode -> "chip"
      is PrototypeCardNode -> "card"
      is PrototypeIconButtonNode -> "iconButton"
      is PrototypeFabNode -> "fab"
      is PrototypeSegmentedButtonNode -> "segmentedButton"
      is PrototypeTopAppBarNode -> "topAppBar"
      is PrototypeDividerNode -> "divider"
      is PrototypeBadgeNode -> "badge"
      is PrototypeProgressNode -> "progress"
      is PrototypeDialogNode -> "dialog"
      is PrototypeSnackbarNode -> "snackbar"
      is PrototypeTimePickerNode -> "timePicker"
      is PrototypeDatePickerNode -> "datePicker"
      is PrototypeScrollNode -> "scroll"
      is PrototypePagerNode -> "pager"
      is PrototypeTabBarNode -> "tabBar"
      is PrototypeBottomNavNode -> "bottomNav"
      is PrototypeBottomSheetNode -> "bottomSheet"
    }
  val text =
    when (node) {
      is PrototypeTextNode -> interpolatePrototypeText(node.text, localState, context != null)
      is PrototypeTextFieldNode -> (state[node.stateKey] as? PrototypeScalar.Text)?.value.orEmpty()
      is PrototypeSwitchNode -> node.label.orEmpty()
      is PrototypeCheckboxNode -> node.label.orEmpty()
      is PrototypeButtonNode -> node.label
      is PrototypeListItemNode -> node.headline
      is PrototypeSliderNode -> node.label.orEmpty()
      is PrototypeChipNode -> node.label
      is PrototypeIconNode -> node.name
      is PrototypeFabNode -> node.label.orEmpty()
      is PrototypeTopAppBarNode -> interpolatePrototypeText(node.title, localState, context != null)
      is PrototypeBadgeNode ->
        node.text?.let { interpolatePrototypeText(it, localState, context != null) }.orEmpty()
      is PrototypeDialogNode ->
        node.title?.let { interpolatePrototypeText(it, localState, context != null) }.orEmpty()
      is PrototypeSnackbarNode -> interpolatePrototypeText(node.text, localState, context != null)
      else -> ""
    }
  val children =
    prototypeChildEntries(node, path).map { (child, childPath) ->
      mapPrototypeNode(child, state, pages, childPath, context)
    }
  val pager =
    when (node) {
      is PrototypeTabBarNode -> node.pager
      is PrototypeBottomNavNode -> node.pager
      else -> null
    }
  val stateKey =
    when (node) {
      is PrototypeTabBarNode -> node.stateKey
      is PrototypeBottomNavNode -> node.stateKey
      else -> null
    }
  val items =
    when (node) {
      is PrototypeTabBarNode -> node.items
      is PrototypeBottomNavNode -> node.items
      else -> emptyList()
    }
  val selected =
    pager?.let { pages[it] } ?: (state[stateKey] as? PrototypeScalar.Numeric)?.value?.toInt() ?: 0
  return PrototypeRenderNode(
    role,
    text,
    node.testTag,
    node.visibleWhen?.holds(localState) ?: true,
    mapPrototypeStyle(resolvePrototypeStyle(node.style, node.styleWhen, localState)),
    node.safeAreaPadding,
    prototypeNodeIconName(node),
    children,
    node,
    path,
    (node as? PrototypePagerNode)?.let { pages[it.id] } ?: 0,
    selected.coerceIn(0, (items.size - 1).coerceAtLeast(0)),
    prototypeOpenWhen(node)?.let { state[it.key] == PrototypeScalar.BooleanValue(it.equals) }
      ?: false,
    checked =
      (prototypeToggleKey(node) ?: prototypeListItemToggleKey(node))?.let {
        state[it] == PrototypeScalar.BooleanValue(true)
      } ?: false,
    selectedValue =
      prototypeSelectionKey(node)?.let { (state[it] as? PrototypeScalar.Text)?.value },
    sliderValue =
      prototypeNumberKey(node)?.let { (state[it] as? PrototypeScalar.Numeric)?.value } ?: 0.0,
    supportingText =
      (node as? PrototypeDialogNode)?.text?.let {
        interpolatePrototypeText(it, localState, context != null)
      },
    hour = prototypeStateInt(state, (node as? PrototypeTimePickerNode)?.hourKey),
    minute = prototypeStateInt(state, (node as? PrototypeTimePickerNode)?.minuteKey),
    contentDescription =
      node.contentDescription?.let { interpolatePrototypeText(it, localState, context != null) },
  )
}

/** The icon a node draws as its whole content, which labels it when nothing else does. */
private fun prototypeNodeIconName(node: PrototypeNode): String? =
  when (node) {
    is PrototypeIconNode -> node.name
    is PrototypeIconButtonNode -> node.icon
    is PrototypeFabNode -> node.icon
    else -> null
  }

/** The boolean condition that opens a `bottomSheet`, `dialog` or `snackbar`; null otherwise. */
internal fun prototypeOpenWhen(node: PrototypeNode?): PrototypeSheetCondition? =
  when (node) {
    is PrototypeBottomSheetNode -> node.openWhen
    is PrototypeDialogNode -> node.openWhen
    is PrototypeSnackbarNode -> node.openWhen
    else -> null
  }

/** The string key a `radioGroup`, `segmentedButton` or `datePicker` is bound to. */
private fun prototypeSelectionKey(node: PrototypeNode): String? =
  when (node) {
    is PrototypeRadioGroupNode -> node.stateKey
    is PrototypeSegmentedButtonNode -> node.stateKey
    is PrototypeDatePickerNode -> node.stateKey
    else -> null
  }

/** The number key a `slider` or a determinate `progress` is bound to. */
private fun prototypeNumberKey(node: PrototypeNode): String? =
  when (node) {
    is PrototypeSliderNode -> node.stateKey
    is PrototypeProgressNode -> node.stateKey
    else -> null
  }

private fun prototypeStateInt(state: Map<String, PrototypeScalar>, key: String?): Int =
  key?.let { (state[it] as? PrototypeScalar.Numeric)?.value?.toInt() } ?: 0

/**
 * Pager placeholders use one-based page labels in the nearest pager; outside it they stay literal.
 *
 * Tokens (`{key}` with an ASCII identifier key) are found by a plain string scan rather than a
 * regex: Android's ICU regex engine rejects a lone `}` that the desktop JVM accepts, which broke
 * every prototype `show` on a device (#9947) while the JVM unit tests stayed green.
 */
fun interpolatePrototypeText(
  text: String,
  state: Map<String, PrototypeScalar>,
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
  state: Map<String, PrototypeScalar>,
  inPager: Boolean,
): String {
  val key = token.substring(1, token.length - 1)
  if (!inPager && (key == "page" || key == "pageCount")) return token
  return when (val value = state[key]) {
    is PrototypeScalar.Text -> value.value
    is PrototypeScalar.BooleanValue -> value.value.toString()
    is PrototypeScalar.Numeric -> value.value.toString().removeSuffix(".0")
    null -> token
  }
}

/** The settled design specifies AARRGGBB (alpha first), not CSS RRGGBBAA. */
fun prototypeColor(value: String): Color {
  require(value.matches(Regex("#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?"))) { "Invalid color: $value" }
  val argb = value.drop(1).toLong(16)
  return Color(if (value.length == 7) argb or 0xff000000L else argb)
}

/**
 * The value a per-mode spec slot (#11218) holds in the prototype's resolved appearance: a single
 * value serves both modes, and a `{light, dark}` pair gives its [dark] or light side. A colour slot
 * yields a hex value or a Material role name, an image slot an asset id.
 */
internal fun prototypeModeValue(value: PrototypeModeValue, dark: Boolean): String =
  when (value) {
    is PrototypeModeValue.Single -> value.value
    is PrototypeModeValue.Modes -> if (dark) value.dark else value.light
  }

/**
 * The colour of a single hex value. Null for a Material role name and for a `{light, dark}` pair:
 * both depend on the theme, so they resolve during composition ([prototypeResolveColor]). Because a
 * pair maps to no literal colour, it never takes part in inferring light or dark from the authored
 * background, which would be circular.
 */
internal fun prototypeHexColor(value: PrototypeModeValue?): Color? =
  (value as? PrototypeModeValue.Single)?.value?.takeIf { it.startsWith("#") }?.let(::prototypeColor)

fun mapPrototypeStyle(style: PrototypeStyle): PrototypeRenderStyle =
  PrototypeRenderStyle(
    style,
    prototypeHexColor(style.background),
    prototypeHexColor(style.border?.color),
    // Unspecified: an unstyled node takes the theme's content colour, not a fixed black.
    prototypeHexColor(style.color) ?: Color.Unspecified,
    prototypeAlignment(style.alignment),
    prototypeHorizontalAlignment(style.alignment),
    prototypeVerticalAlignment(style.alignment),
    FontWeight(style.fontWeight ?: 400),
    builtInFontFamily(style.fontFamily),
    (style.fontFamily as? PrototypeFontFamily.Asset)?.id,
    when (style.textAlign) {
      "center" -> TextAlign.Center
      "end" -> TextAlign.End
      "justify" -> TextAlign.Justify
      else -> TextAlign.Start
    },
    prototypeHexColor(style.shadowColor),
    if (style.fontStyle == "italic") FontStyle.Italic else FontStyle.Normal,
    prototypeTextDecoration(style.textDecoration),
    when (style.overflow) {
      "ellipsis" -> TextOverflow.Ellipsis
      "visible" -> TextOverflow.Visible
      else -> TextOverflow.Clip
    },
  )

private fun prototypeTextDecoration(value: String?): TextDecoration =
  when (value) {
    "underline" -> TextDecoration.Underline
    "lineThrough" -> TextDecoration.LineThrough
    "underlineLineThrough" ->
      TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
    else -> TextDecoration.None
  }

private fun builtInFontFamily(family: PrototypeFontFamily?): FontFamily =
  when ((family as? PrototypeFontFamily.Named)?.name) {
    "sansSerif" -> FontFamily.SansSerif
    "serif" -> FontFamily.Serif
    "monospace" -> FontFamily.Monospace
    else -> FontFamily.Default
  }

private fun prototypeAlignment(value: String?): Alignment =
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

private fun prototypeHorizontalAlignment(value: String?): Alignment.Horizontal =
  when (value) {
    "topCenter",
    "center",
    "bottomCenter" -> Alignment.CenterHorizontally
    "topEnd",
    "centerEnd",
    "bottomEnd" -> Alignment.End
    else -> Alignment.Start
  }

private fun prototypeVerticalAlignment(value: String?): Alignment.Vertical =
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
fun prototypeLinearGradientLine(angle: Double, width: Float, height: Float): Pair<Offset, Offset> {
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
 * descending list anyway, so the rendered result is deterministic and documented. A stop colour is
 * a hex value, a role name or a `{light, dark}` pair of either, resolved against [palette].
 */
internal fun prototypeGradientStops(
  stops: List<PrototypeGradientStop>,
  palette: PrototypePalette,
): Pair<List<Color>, List<Float>?> {
  // The validator only admits hex values and known role names, so the fallback is unreachable.
  val colors = stops.map { prototypeResolveColor(palette, null, it.color) ?: Color.Transparent }
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
private fun requirePrototypeRenderSizes(style: PrototypeStyle?, path: String) {
  if (style == null) return
  val sizes =
    mapOf(
      "width.dp" to (style.width as? PrototypeDimension.Dp)?.dp,
      "height.dp" to (style.height as? PrototypeDimension.Dp)?.dp,
      "weight" to style.weight,
      "elevation" to style.elevation,
      "aspectRatio" to style.aspectRatio,
      "gradient.angle" to (style.gradient as? PrototypeLinearGradient)?.angle,
      "minWidth" to style.minWidth,
      "maxWidth" to style.maxWidth,
      "minHeight" to style.minHeight,
      "maxHeight" to style.maxHeight,
      "padding.top" to style.padding?.top,
      "padding.bottom" to style.padding?.bottom,
      "padding.start" to style.padding?.start,
      "padding.end" to style.padding?.end,
      "cornerRadius" to (style.cornerRadius as? PrototypeCornerRadius.Dp)?.dp,
      "cornerRadius.topStart" to (style.cornerRadius as? PrototypeCornerRadius.Corners)?.topStart,
      "cornerRadius.topEnd" to (style.cornerRadius as? PrototypeCornerRadius.Corners)?.topEnd,
      "cornerRadius.bottomEnd" to (style.cornerRadius as? PrototypeCornerRadius.Corners)?.bottomEnd,
      "cornerRadius.bottomStart" to
        (style.cornerRadius as? PrototypeCornerRadius.Corners)?.bottomStart,
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
 * hoisted and rendered by [modalPrototypeSheets], so their fields count and their closed twins do
 * not. The window may take input focus only while this holds.
 */
fun hasVisibleTextField(root: PrototypeRenderNode): Boolean =
  inlineTextFieldVisible(root) ||
    modalPrototypeSheets(root).any { sheet -> sheet.children.any(::inlineTextFieldVisible) }

private fun inlineTextFieldVisible(node: PrototypeRenderNode): Boolean =
  when {
    !node.visible -> false
    node.role == "textField" -> true
    node.role in PROTOTYPE_MODAL_ROLES -> false // Hoisted: only modalPrototypeSheets renders it.
    node.role == "pager" ->
      node.children.getOrNull(node.page)?.let(::inlineTextFieldVisible) == true
    else -> node.children.any(::inlineTextFieldVisible)
  }

/** Roles drawn above the whole author tree while their `openWhen` holds, never inline. */
internal val PROTOTYPE_MODAL_ROLES = setOf("bottomSheet", "dialog", "snackbar")

/**
 * Open sheets, dialogs and snackbars are rendered last, in tree order, so a modal scrim covers the
 * entire prototype window.
 */
fun modalPrototypeSheets(node: PrototypeRenderNode): List<PrototypeRenderNode> {
  if (!node.visible) return emptyList()
  val modal = node.role in PROTOTYPE_MODAL_ROLES
  if (modal && !node.sheetOpen) return emptyList()
  val children =
    if (node.role == "pager") listOfNotNull(node.children.getOrNull(node.page)) else node.children
  return (if (modal) listOf(node) else emptyList()) + children.flatMap(::modalPrototypeSheets)
}

/** Roles that compose their children inline through the node renderer; others never draw them. */
private val PROTOTYPE_INLINE_CONTAINER_ROLES =
  setOf("box", "row", "column", "scroll", "card", "pager")

/** A non-root anchored node: drawn in the window-level anchor layer, never in its parent. */
internal fun isLayeredPrototypeAnchor(node: PrototypeRenderNode): Boolean =
  node.source?.anchor is PrototypeBoundsAnchor

/**
 * An anchored node drawn in a window-level layer, with the [ancestors] it was authored under (the
 * outermost first). The layer keeps it composed while any of them animates out, so it fades with
 * them instead of vanishing when they hide (#10803).
 */
data class LayeredPrototypeAnchor(
  val node: PrototypeRenderNode,
  val ancestors: List<PrototypeRenderNode> = emptyList(),
) {
  /** Every ancestor is shown; the node's own `visible` is left to the renderer. */
  val ancestorsShown: Boolean
    get() = ancestors.all { it.visible }

  /**
   * The ancestor whose `visibleWhen` transition the node follows: the outermost animated one that
   * is hiding (its exit contains the others), else the nearest animated one. Null when no ancestor
   * is animated, so the node appears and disappears with them instantly.
   */
  val animatedAncestor: PrototypeRenderNode?
    get() {
      val animated = ancestors.filter { it.source?.visibleWhen != null }
      return animated.firstOrNull { !it.visible } ?: animated.lastOrNull()
    }
}

/**
 * The anchored nodes under [node] that the renderer draws in a window-level layer above the author
 * tree (#10803), in tree order. Drawn inside their parent they were clipped to its slot (a
 * wrap-content parent animating its size clips) and took a slot there. Nodes under a hidden
 * ancestor are listed too, flagged by [LayeredPrototypeAnchor.ancestorsShown], so the layer can
 * fade them with it; nodes on a pager page other than the settled one and nodes inside a modal
 * (modals list their own through [layeredPrototypeAnchorsIn]) are not. The anchored node's own
 * visibility is left to the renderer, so its `visibleWhen` transition still runs. [node] itself is
 * never listed: a window root keeps its own anchored placement.
 */
fun layeredPrototypeAnchors(node: PrototypeRenderNode): List<LayeredPrototypeAnchor> =
  anchorsBelow(node, listOf(node))

/** [layeredPrototypeAnchors] for content drawn as [children], such as a modal's body. */
fun layeredPrototypeAnchorsIn(children: List<PrototypeRenderNode>): List<LayeredPrototypeAnchor> =
  anchorsAmong(children, emptyList())

private fun anchorsBelow(parent: PrototypeRenderNode, ancestors: List<PrototypeRenderNode>) =
  if (parent.role !in PROTOTYPE_INLINE_CONTAINER_ROLES) emptyList()
  else
    anchorsAmong(
      if (parent.role == "pager") listOfNotNull(parent.children.getOrNull(parent.page))
      else parent.children,
      ancestors,
    )

private fun anchorsAmong(
  children: List<PrototypeRenderNode>,
  ancestors: List<PrototypeRenderNode>,
): List<LayeredPrototypeAnchor> = children.flatMap { child ->
  (if (isLayeredPrototypeAnchor(child)) listOf(LayeredPrototypeAnchor(child, ancestors))
  else emptyList()) + anchorsBelow(child, ancestors + child)
}
