package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import dev.jasonpearson.automobile.protocol.*

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
  val textAlign: TextAlign,
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
  val sheetOpen: Boolean = false,
)

data class OverlayRenderModel(
  val placement: OverlayPlacement,
  val opacityPercent: Int,
  val root: OverlayRenderNode,
  val hasTextField: Boolean = false,
) {
  fun request() =
    InteractiveOverlayRequest(
      placement = placement,
      opacityPercent = opacityPercent,
      hasTextField = hasTextField,
    ) {
      OverlaySpecContent(root)
    }
}

/** Path spelling and traversal order match the protocol validator, including unsupported nodes. */
fun guardOverlayTree(root: OverlayNode) {
  var count = 0
  fun visit(node: OverlayNode, path: String, depth: Int) {
    require(++count <= OverlaySpecValidator.MAX_OVERLAY_NODES) { "$path: Node limit exceeded" }
    require(depth <= OverlaySpecValidator.MAX_OVERLAY_DEPTH) { "$path: Tree depth limit exceeded" }
    when (node) {
      is OverlayScrollNode -> visit(node.child, "$path.child", depth + 1)
      is OverlayBottomSheetNode -> visit(node.child, "$path.child", depth + 1)
      else ->
        overlayChildren(node).forEachIndexed { index, child ->
          visit(child, "$path.children[$index]", depth + 1)
        }
    }
  }
  visit(root, "root", 1)
}

private fun overlayChildren(node: OverlayNode): List<OverlayNode> =
  when (node) {
    is OverlayBoxNode -> node.children
    is OverlayRowNode -> node.children
    is OverlayColumnNode -> node.children
    is OverlayPagerNode -> node.children
    else -> emptyList()
  }

fun mapOverlaySpec(spec: OverlaySpec, pages: Map<String, Int> = emptyMap()): OverlayRenderModel {
  guardOverlayTree(spec.root)
  return OverlayRenderModel(
    mapOverlayPlacement(spec.window.placement),
    spec.window.opacity,
    mapOverlayNode(spec.root, spec.state.orEmpty(), pages, "root"),
    hasOverlayTextField(spec.root),
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
      is OverlayIconNode -> node.name
      else -> ""
    }
  val children =
    overlayDescendants(node).mapIndexed { index, child ->
      val childPath =
        if (node is OverlayScrollNode || node is OverlayBottomSheetNode) "$path.child"
        else "$path.children[$index]"
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
    node.visibleWhen?.let { localState[it.key] == it.equals } ?: true,
    mapOverlayStyle(node.style ?: OverlayStyle()),
    node.safeAreaPadding,
    (node as? OverlayIconNode)?.name,
    children,
    node,
    path,
    (node as? OverlayPagerNode)?.let { pages[it.id] } ?: 0,
    selected.coerceIn(0, (items.size - 1).coerceAtLeast(0)),
    (node as? OverlayBottomSheetNode)?.let {
      state[it.openWhen.key] == OverlayScalar.BooleanValue(it.openWhen.equals)
    } ?: false,
  )
}

private val interpolationToken = Regex("\\{([A-Za-z_][A-Za-z0-9_]*)}")

/**
 * Pager placeholders use one-based page labels in the nearest pager; outside it they stay literal.
 */
fun interpolateOverlayText(
  text: String,
  state: Map<String, OverlayScalar>,
  inPager: Boolean = false,
): String =
  interpolationToken.replace(text) { match ->
    val key = match.groupValues[1]
    if (!inPager && (key == "page" || key == "pageCount")) match.value
    else
      when (val value = state[key]) {
        is OverlayScalar.Text -> value.value
        is OverlayScalar.BooleanValue -> value.value.toString()
        is OverlayScalar.Numeric -> value.value.toString().removeSuffix(".0")
        null -> match.value
      }
  }

/** The settled design specifies AARRGGBB (alpha first), not CSS RRGGBBAA. */
fun overlayColor(value: String): Color {
  require(value.matches(Regex("#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?"))) { "Invalid color: $value" }
  val argb = value.drop(1).toLong(16)
  return Color(if (value.length == 7) argb or 0xff000000L else argb)
}

fun mapOverlayStyle(style: OverlayStyle): OverlayRenderStyle =
  OverlayRenderStyle(
    style,
    style.background?.let(::overlayColor),
    style.border?.color?.let(::overlayColor),
    style.color?.let(::overlayColor) ?: Color.Black,
    overlayAlignment(style.alignment),
    overlayHorizontalAlignment(style.alignment),
    overlayVerticalAlignment(style.alignment),
    FontWeight(style.fontWeight ?: 400),
    when (style.fontFamily) {
      "sansSerif" -> FontFamily.SansSerif
      "serif" -> FontFamily.Serif
      "monospace" -> FontFamily.Monospace
      else -> FontFamily.Default
    },
    when (style.textAlign) {
      "center" -> TextAlign.Center
      "end" -> TextAlign.End
      "justify" -> TextAlign.Justify
      else -> TextAlign.Start
    },
  )

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

/** Compose uses Float dp; reject unrepresentable values before installing a content lambda. */
private fun requireOverlayRenderSizes(style: OverlayStyle?, path: String) {
  if (style == null) return
  val sizes =
    mapOf(
      "width.dp" to (style.width as? OverlayDimension.Dp)?.dp,
      "height.dp" to (style.height as? OverlayDimension.Dp)?.dp,
      "padding.top" to style.padding?.top,
      "padding.bottom" to style.padding?.bottom,
      "padding.start" to style.padding?.start,
      "padding.end" to style.padding?.end,
      "cornerRadius" to style.cornerRadius,
      "border.width" to style.border?.width,
      "spacing" to style.spacing,
      "textSize" to style.textSize,
    )
  for ((key, value) in sizes) {
    require(value == null || value.toFloat().isFinite()) {
      "$path.style.$key: Size cannot be represented in Compose dp"
    }
  }
}

private fun hasOverlayTextField(node: OverlayNode): Boolean =
  node is OverlayTextFieldNode || overlayDescendants(node).any(::hasOverlayTextField)

/** Open sheet nodes are rendered last so their modal scrim covers the entire overlay window. */
fun modalOverlaySheets(node: OverlayRenderNode): List<OverlayRenderNode> {
  if (!node.visible) return emptyList()
  if (node.role == "bottomSheet" && !node.sheetOpen) return emptyList()
  val children =
    if (node.role == "pager") listOfNotNull(node.children.getOrNull(node.page)) else node.children
  return (if (node.role == "bottomSheet") listOf(node) else emptyList()) +
    children.flatMap(::modalOverlaySheets)
}
